//! Portability commands: remap, export, import, portable mode toggle.
use crate::db;
use crate::AppState;

#[tauri::command]
pub async fn remap_root_cmd(
    state: tauri::State<'_, AppState>,
    old_path: String,
    new_path: String,
) -> Result<db::RemapReport, String> {
    db::remap_root(&state.paths.db_file, &old_path, &new_path)
        .map_err(|e| e.to_string())
}
