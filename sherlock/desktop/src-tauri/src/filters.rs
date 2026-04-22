//! Aggregation queries that feed the search-filter UI — camera/lens pickers.
use crate::db::open_conn;
use crate::error::AppResult;
use std::path::Path;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterOption {
    pub value: String,
    pub count: i64,
}

pub fn list_cameras(db_path: &Path) -> AppResult<Vec<FilterOption>> {
    let conn = open_conn(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT camera_model, COUNT(*) AS c FROM files
         WHERE deleted_at IS NULL AND camera_model != ''
         GROUP BY camera_model ORDER BY c DESC, camera_model ASC",
    )?;
    let rows = stmt
        .query_map([], |r| Ok(FilterOption { value: r.get(0)?, count: r.get(1)? }))?;
    Ok(rows.filter_map(Result::ok).collect())
}

pub fn list_lenses(db_path: &Path) -> AppResult<Vec<FilterOption>> {
    let conn = open_conn(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT lens_model, COUNT(*) AS c FROM files
         WHERE deleted_at IS NULL AND lens_model != ''
         GROUP BY lens_model ORDER BY c DESC, lens_model ASC",
    )?;
    let rows = stmt
        .query_map([], |r| Ok(FilterOption { value: r.get(0)?, count: r.get(1)? }))?;
    Ok(rows.filter_map(Result::ok).collect())
}

#[tauri::command]
pub async fn list_cameras_cmd(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<FilterOption>, String> {
    list_cameras(&state.paths.db_file).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_lenses_cmd(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<FilterOption>, String> {
    list_lenses(&state.paths.db_file).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{init_database, upsert_root};
    use rusqlite::Connection;
    use tempfile::tempdir;

    fn seed(conn: &Connection, root_id: i64, filename: &str, camera: &str, lens: &str) {
        conn.execute(
            "INSERT INTO files (root_id, rel_path, filename, abs_path, mtime_ns, size_bytes,
                                fingerprint, updated_at, camera_model, lens_model)
             VALUES (?1, ?2, ?3, ?4, 0, 0, ?5, 0, ?6, ?7)",
            rusqlite::params![
                root_id,
                filename,
                filename,
                format!("/tmp/{filename}"),
                format!("fp-{filename}"),
                camera,
                lens
            ],
        )
        .unwrap();
    }

    #[test]
    fn list_cameras_groups_and_counts_descending() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("t.sqlite");
        init_database(&db).unwrap();
        let root = upsert_root(&db, "/tmp").unwrap();
        let conn = Connection::open(&db).unwrap();
        seed(&conn, root, "a.jpg", "Canon EOS R5", "RF 24-70mm");
        seed(&conn, root, "b.jpg", "Canon EOS R5", "RF 24-70mm");
        seed(&conn, root, "c.jpg", "iPhone 14 Pro", "");
        drop(conn);

        let out = list_cameras(&db).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].value, "Canon EOS R5");
        assert_eq!(out[0].count, 2);
        assert_eq!(out[1].value, "iPhone 14 Pro");
    }

    #[test]
    fn list_lenses_skips_empty() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("t.sqlite");
        init_database(&db).unwrap();
        let root = upsert_root(&db, "/tmp").unwrap();
        let conn = Connection::open(&db).unwrap();
        seed(&conn, root, "a.jpg", "", "50mm f/1.8");
        seed(&conn, root, "b.jpg", "", "");
        drop(conn);

        let out = list_lenses(&db).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].value, "50mm f/1.8");
    }
}
