//! Timeline density aggregation — monthly photo-count buckets for the heatmap sidebar.
use crate::db::open_conn;
use crate::error::AppResult;
use std::path::Path;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineBucket {
    /// ISO-8601 month string, e.g. "2023-06"
    pub bucket: String,
    pub count: i64,
}

pub fn list_timeline_buckets(db_path: &Path) -> AppResult<Vec<TimelineBucket>> {
    let conn = open_conn(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT strftime('%Y-%m', datetime(mtime_ns / 1000000000, 'unixepoch')) AS bucket,
                COUNT(*) AS c
         FROM files
         WHERE deleted_at IS NULL
           AND mtime_ns IS NOT NULL
           AND mtime_ns > 0
         GROUP BY bucket
         ORDER BY bucket ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(TimelineBucket { bucket: r.get(0)?, count: r.get(1)? })
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}

#[tauri::command]
pub async fn list_timeline_buckets_cmd(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<TimelineBucket>, String> {
    list_timeline_buckets(&state.paths.db_file).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{init_database, upsert_root};
    use rusqlite::Connection;
    use tempfile::tempdir;

    fn insert_file(conn: &Connection, root_id: i64, filename: &str, mtime_ns: i64) {
        conn.execute(
            "INSERT INTO files
               (root_id, rel_path, filename, abs_path, mtime_ns, size_bytes, fingerprint, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, 0)",
            rusqlite::params![
                root_id,
                filename,
                filename,
                format!("/tmp/{filename}"),
                mtime_ns,
                format!("fp-{filename}"),
            ],
        )
        .unwrap();
    }

    // 2023-01-15 00:00:00 UTC in ns
    const JAN_2023: i64 = 1673740800_i64 * 1_000_000_000;
    // 2023-06-20 00:00:00 UTC in ns
    const JUN_2023: i64 = 1687219200_i64 * 1_000_000_000;
    // 2024-03-10 00:00:00 UTC in ns
    const MAR_2024: i64 = 1710028800_i64 * 1_000_000_000;

    #[test]
    fn groups_by_month_ascending() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("t.sqlite");
        init_database(&db).unwrap();
        let root = upsert_root(&db, "/tmp").unwrap();
        let conn = Connection::open(&db).unwrap();
        insert_file(&conn, root, "a.jpg", JAN_2023);
        insert_file(&conn, root, "b.jpg", JAN_2023);
        insert_file(&conn, root, "c.jpg", JUN_2023);
        insert_file(&conn, root, "d.jpg", MAR_2024);
        drop(conn);

        let out = list_timeline_buckets(&db).unwrap();
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].bucket, "2023-01");
        assert_eq!(out[0].count, 2);
        assert_eq!(out[1].bucket, "2023-06");
        assert_eq!(out[1].count, 1);
        assert_eq!(out[2].bucket, "2024-03");
        assert_eq!(out[2].count, 1);
    }

    #[test]
    fn skips_deleted_files() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("t.sqlite");
        init_database(&db).unwrap();
        let root = upsert_root(&db, "/tmp").unwrap();
        let conn = Connection::open(&db).unwrap();
        insert_file(&conn, root, "a.jpg", JAN_2023);
        conn.execute(
            "UPDATE files SET deleted_at = 1 WHERE filename = 'a.jpg'",
            [],
        )
        .unwrap();
        drop(conn);

        let out = list_timeline_buckets(&db).unwrap();
        assert!(out.is_empty(), "deleted files should not appear in timeline");
    }

    #[test]
    fn empty_db_returns_empty_vec() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("t.sqlite");
        init_database(&db).unwrap();
        let out = list_timeline_buckets(&db).unwrap();
        assert!(out.is_empty());
    }
}
