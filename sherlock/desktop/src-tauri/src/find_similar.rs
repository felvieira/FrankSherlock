//! Ranked "find similar" query using dHash + description similarity.
use crate::db::open_conn;
use crate::error::{AppError, AppResult};
use crate::similarity::{combined_similarity, hamming_distance};
use rusqlite::params;
use std::path::Path;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimilarResult {
    pub file_id: i64,
    pub root_id: i64,
    pub rel_path: String,
    pub abs_path: String,
    pub filename: String,
    pub media_type: String,
    pub description: String,
    pub thumb_path: Option<String>,
    pub score: f32,
}

/// Early-exit pruning: if visual alone can't exceed `min_score`, skip the row.
/// combined = 0.85 * visual + 0.15 * textual; textual ≤ 1.0, so:
///   visual ≥ (min_score - 0.15) / 0.85
///   hamming ≤ (1 - visual) * 64
fn max_hamming_for(min_score: f32) -> u32 {
    let visual_min = ((min_score - 0.15) / 0.85).max(0.0);
    ((1.0 - visual_min) * 64.0).floor() as u32
}

/// Rank all other files by `combined_similarity` to the source file.
/// Returns the top `limit` with `score ≥ min_score`, descending by score.
pub fn find_similar(
    db_path: &Path,
    source_file_id: i64,
    limit: usize,
    min_score: f32,
) -> AppResult<Vec<SimilarResult>> {
    let conn = open_conn(db_path)?;

    // Fetch the source row.
    let (src_dhash, src_desc, src_media_type): (Option<i64>, String, String) = conn
        .query_row(
            "SELECT dhash, description, media_type FROM files
             WHERE id = ?1 AND deleted_at IS NULL",
            params![source_file_id],
            |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                AppError::InvalidPath(format!("no such file: {source_file_id}"))
            }
            other => other.into(),
        })?;

    let src_dhash = match src_dhash {
        Some(v) => v as u64,
        None => {
            // No dHash on source — fall back is out of scope; return empty.
            return Ok(Vec::new());
        }
    };

    let max_h = max_hamming_for(min_score);

    let mut stmt = conn.prepare(
        "SELECT f.id, f.root_id, f.rel_path, f.filename, f.abs_path,
                f.media_type, f.description, f.thumb_path, f.dhash
         FROM files f
         WHERE f.id != ?1
           AND f.deleted_at IS NULL
           AND f.dhash IS NOT NULL
           AND f.media_type = ?2",
    )?;

    let mut scored: Vec<SimilarResult> = Vec::new();
    type Row = (
        i64,
        i64,
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        u64,
    );
    let rows = stmt.query_map(params![source_file_id, src_media_type], |row| -> rusqlite::Result<Row> {
        let dhash: i64 = row.get(8)?;
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, Option<String>>(7)?,
            dhash as u64,
        ))
    })?;

    for row in rows {
        let (file_id, root_id, rel_path, filename, abs_path, media_type, description, thumb_path, cand_dhash) = row?;
        if hamming_distance(src_dhash, cand_dhash) > max_h {
            continue;
        }
        let score = combined_similarity(src_dhash, cand_dhash, &src_desc, &description);
        if score < min_score {
            continue;
        }
        scored.push(SimilarResult {
            file_id,
            root_id,
            rel_path,
            abs_path,
            filename,
            media_type,
            description,
            thumb_path,
            score,
        });
    }

    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit);
    Ok(scored)
}

#[tauri::command]
pub async fn find_similar_cmd(
    state: tauri::State<'_, crate::AppState>,
    file_id: i64,
    limit: usize,
    min_score: f32,
) -> Result<Vec<SimilarResult>, String> {
    find_similar(&state.paths.db_file, file_id, limit, min_score).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{init_database, upsert_root};
    use rusqlite::Connection;
    use tempfile::tempdir;

    fn seed_file(
        conn: &Connection,
        root_id: i64,
        filename: &str,
        rel_path: &str,
        media_type: &str,
        description: &str,
        dhash: Option<i64>,
    ) -> i64 {
        conn.execute(
            "INSERT INTO files (root_id, rel_path, filename, abs_path, media_type, description,
                                mtime_ns, size_bytes, fingerprint, updated_at, dhash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, ?7, 0, ?8)",
            rusqlite::params![
                root_id,
                rel_path,
                filename,
                format!("D:\\Photos\\{rel_path}"),
                media_type,
                description,
                format!("fp-{filename}"),
                dhash,
            ],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn setup() -> (tempfile::TempDir, std::path::PathBuf, i64) {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.sqlite");
        init_database(&db_path).unwrap();
        let root_id = upsert_root(&db_path, "D:\\Photos").unwrap();
        (dir, db_path, root_id)
    }

    #[test]
    fn find_similar_returns_high_scoring_candidates() {
        let (_dir, db_path, root_id) = setup();
        let conn = Connection::open(&db_path).unwrap();
        let src = seed_file(&conn, root_id, "a.jpg", "a.jpg", "photo", "sunset over beach", Some(0));
        let close = seed_file(&conn, root_id, "b.jpg", "b.jpg", "photo", "sunset over beach", Some(0b11));
        let far = seed_file(&conn, root_id, "c.jpg", "c.jpg", "photo", "car in parking lot",
            Some(i64::from_le_bytes(0xFFFFFFFFFFFFFFFFu64.to_le_bytes())));
        let doc = seed_file(&conn, root_id, "d.jpg", "d.jpg", "document", "sunset over beach", Some(0));
        drop(conn);

        let out = find_similar(&db_path, src, 10, 0.5).unwrap();
        let ids: Vec<i64> = out.iter().map(|r| r.file_id).collect();
        assert!(ids.contains(&close), "expected close match included, got {ids:?}");
        assert!(!ids.contains(&far), "expected far match excluded by min_score 0.5, got {ids:?}");
        assert!(!ids.contains(&src));
        assert!(!ids.contains(&doc), "document media_type must be filtered out");

        let scores: Vec<f32> = out.iter().map(|r| r.score).collect();
        let mut sorted = scores.clone();
        sorted.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
        assert_eq!(scores, sorted);
    }

    #[test]
    fn find_similar_respects_limit() {
        let (_dir, db_path, root_id) = setup();
        let conn = Connection::open(&db_path).unwrap();
        let src = seed_file(&conn, root_id, "src.jpg", "src.jpg", "photo", "cat on couch", Some(0));
        for i in 0..5 {
            seed_file(
                &conn,
                root_id,
                &format!("n{i}.jpg"),
                &format!("n{i}.jpg"),
                "photo",
                "cat on couch",
                Some(i as i64),
            );
        }
        drop(conn);

        let out = find_similar(&db_path, src, 2, 0.5).unwrap();
        assert_eq!(out.len(), 2, "limit must cap results at 2");
    }

    #[test]
    fn find_similar_returns_empty_when_source_has_no_dhash() {
        let (_dir, db_path, root_id) = setup();
        let conn = Connection::open(&db_path).unwrap();
        let src = seed_file(&conn, root_id, "src.jpg", "src.jpg", "photo", "x", None);
        seed_file(&conn, root_id, "c.jpg", "c.jpg", "photo", "x", Some(0));
        drop(conn);

        let out = find_similar(&db_path, src, 10, 0.5).unwrap();
        assert!(out.is_empty(), "source without dhash should yield empty results");
    }

    #[test]
    fn find_similar_errors_on_unknown_source() {
        let (_dir, db_path, _root_id) = setup();
        let err = find_similar(&db_path, 9999, 10, 0.5);
        assert!(err.is_err());
    }

    #[test]
    fn find_similar_excludes_deleted_candidates() {
        let (_dir, db_path, root_id) = setup();
        let conn = Connection::open(&db_path).unwrap();
        let src = seed_file(&conn, root_id, "src.jpg", "src.jpg", "photo", "sunset", Some(0));
        let gone = seed_file(&conn, root_id, "gone.jpg", "gone.jpg", "photo", "sunset", Some(0));
        conn.execute("UPDATE files SET deleted_at = 1 WHERE id = ?1", rusqlite::params![gone]).unwrap();
        drop(conn);

        let out = find_similar(&db_path, src, 10, 0.5).unwrap();
        assert!(out.iter().all(|r| r.file_id != gone));
    }
}
