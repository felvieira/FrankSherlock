//! Autocomplete suggestions — people, cameras, lenses, canonical mentions — ranked by count.
use crate::db::open_conn;
use crate::error::AppResult;
use std::path::Path;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub label: String,
    /// "person" | "camera" | "lens" | "mention"
    pub kind: String,
    pub count: i64,
}

pub fn suggest(db_path: &Path, prefix: &str, limit: usize) -> AppResult<Vec<Suggestion>> {
    let needle = prefix.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let pattern = format!("{needle}%");
    let conn = open_conn(db_path)?;
    let mut out: Vec<Suggestion> = Vec::new();

    // People names
    let mut stmt = conn.prepare(
        "SELECT name, (SELECT COUNT(*) FROM face_detections WHERE person_id = p.id) AS c
         FROM people p
         WHERE LOWER(name) LIKE ?1
         ORDER BY c DESC LIMIT ?2",
    )?;
    for row in stmt.query_map(rusqlite::params![pattern, limit as i64], |r| {
        Ok(Suggestion { label: r.get(0)?, kind: "person".into(), count: r.get(1)? })
    })? {
        if let Ok(s) = row {
            out.push(s);
        }
    }

    // Camera models
    let mut stmt = conn.prepare(
        "SELECT camera_model, COUNT(*) FROM files
         WHERE deleted_at IS NULL AND camera_model != '' AND LOWER(camera_model) LIKE ?1
         GROUP BY camera_model ORDER BY COUNT(*) DESC LIMIT ?2",
    )?;
    for row in stmt.query_map(rusqlite::params![pattern, limit as i64], |r| {
        Ok(Suggestion { label: r.get(0)?, kind: "camera".into(), count: r.get(1)? })
    })? {
        if let Ok(s) = row {
            out.push(s);
        }
    }

    // Lens models
    let mut stmt = conn.prepare(
        "SELECT lens_model, COUNT(*) FROM files
         WHERE deleted_at IS NULL AND lens_model != '' AND LOWER(lens_model) LIKE ?1
         GROUP BY lens_model ORDER BY COUNT(*) DESC LIMIT ?2",
    )?;
    for row in stmt.query_map(rusqlite::params![pattern, limit as i64], |r| {
        Ok(Suggestion { label: r.get(0)?, kind: "lens".into(), count: r.get(1)? })
    })? {
        if let Ok(s) = row {
            out.push(s);
        }
    }

    // Canonical mentions (split on commas, filter by prefix)
    let mut stmt = conn.prepare(
        "SELECT canonical_mentions FROM files
         WHERE deleted_at IS NULL AND canonical_mentions != ''",
    )?;
    let rows: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .filter_map(Result::ok)
        .collect();
    let mut mention_counts: std::collections::HashMap<String, i64> = Default::default();
    for row in rows {
        for token in row.split(',').map(str::trim).filter(|t| !t.is_empty()) {
            let lower = token.to_lowercase();
            if lower.starts_with(&needle) {
                *mention_counts.entry(lower).or_default() += 1;
            }
        }
    }
    let mut mentions: Vec<(String, i64)> = mention_counts.into_iter().collect();
    mentions.sort_by(|a, b| b.1.cmp(&a.1));
    for (label, count) in mentions.into_iter().take(limit) {
        out.push(Suggestion { label, kind: "mention".into(), count });
    }

    out.sort_by(|a, b| b.count.cmp(&a.count));
    out.truncate(limit);
    Ok(out)
}

#[tauri::command]
pub async fn suggest_cmd(
    state: tauri::State<'_, crate::AppState>,
    prefix: String,
    limit: usize,
) -> Result<Vec<Suggestion>, String> {
    suggest(&state.paths.db_file, &prefix, limit).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{init_database, upsert_root};
    use rusqlite::Connection;
    use tempfile::tempdir;

    #[test]
    fn suggest_matches_cameras_and_mentions() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("t.sqlite");
        init_database(&db).unwrap();
        let root = upsert_root(&db, "/tmp").unwrap();
        let conn = Connection::open(&db).unwrap();
        conn.execute(
            "INSERT INTO files (root_id, rel_path, filename, abs_path, mtime_ns, size_bytes,
                                fingerprint, updated_at, camera_model, canonical_mentions)
             VALUES (?1, 'a.jpg', 'a.jpg', '/tmp/a.jpg', 0, 0, 'fp1', 0, 'Alpha 7', 'Alice, Bob')",
            rusqlite::params![root],
        )
        .unwrap();
        drop(conn);

        let out = suggest(&db, "al", 10).unwrap();
        let labels: Vec<String> = out.iter().map(|s| s.label.clone()).collect();
        assert!(labels.iter().any(|l| l == "Alpha 7"), "missing Alpha 7 in {labels:?}");
        assert!(labels.iter().any(|l| l == "alice"), "missing alice mention in {labels:?}");
    }

    #[test]
    fn suggest_empty_prefix_returns_empty() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("t.sqlite");
        init_database(&db).unwrap();
        let out = suggest(&db, "   ", 10).unwrap();
        assert!(out.is_empty());
    }
}
