//! Portability commands: remap, export, import, portable mode toggle.
use crate::db;
use crate::error::{AppError, AppResult};
use crate::AppState;
use std::path::Path;

#[tauri::command]
pub async fn remap_root_cmd(
    state: tauri::State<'_, AppState>,
    old_path: String,
    new_path: String,
) -> Result<db::RemapReport, String> {
    db::remap_root(&state.paths.db_file, &old_path, &new_path)
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub zip_path: String,
    pub entries: usize,
    pub bytes: u64,
}

/// Export db + thumbnails + classifications into a single zip.
/// `base_dir` is the AppPaths base (what `config::resolve_paths().base_dir` returns).
/// Refuses to overwrite an existing zip at `zip_path`.
pub fn export_catalog_at(base_dir: &Path, zip_path: &Path) -> AppResult<ExportReport> {
    use std::io::Write;

    if zip_path.exists() {
        return Err(AppError::InvalidPath(format!(
            "refusing to overwrite existing file: {}",
            zip_path.display()
        )));
    }

    if let Some(parent) = zip_path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent)?;
        }
    }

    let file = std::fs::File::create(zip_path)
        .map_err(|e| AppError::Config(format!("cannot create zip: {e}")))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts: zip::write::FileOptions<()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let mut entries = 0usize;
    let mut bytes = 0u64;

    for rel in [
        Path::new("db"),
        Path::new("cache/thumbnails"),
        Path::new("cache/classifications"),
    ] {
        let abs = base_dir.join(rel);
        if !abs.exists() {
            continue;
        }
        for entry in walkdir::WalkDir::new(&abs) {
            let entry = entry.map_err(|e| AppError::Config(format!("walk {}: {e}", rel.display())))?;
            if !entry.file_type().is_file() {
                continue;
            }
            let rel_in_zip = entry
                .path()
                .strip_prefix(base_dir)
                .map_err(|e| AppError::Config(format!("strip_prefix: {e}")))?
                .to_string_lossy()
                .replace('\\', "/");
            zip.start_file(&rel_in_zip, opts)
                .map_err(|e| AppError::Config(format!("zip start: {e}")))?;
            let data = std::fs::read(entry.path())?;
            zip.write_all(&data)
                .map_err(|e| AppError::Config(format!("zip write: {e}")))?;
            entries += 1;
            bytes += data.len() as u64;
        }
    }

    zip.finish()
        .map_err(|e| AppError::Config(format!("zip finish: {e}")))?;
    Ok(ExportReport {
        zip_path: zip_path.to_string_lossy().into_owned(),
        entries,
        bytes,
    })
}

#[tauri::command]
pub async fn export_catalog_cmd(
    state: tauri::State<'_, AppState>,
    out_zip: String,
) -> Result<ExportReport, String> {
    export_catalog_at(&state.paths.base_dir, std::path::Path::new(&out_zip))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod export_tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn export_catalog_bundles_db_and_caches() {
        let src = tempdir().unwrap();
        let out = tempdir().unwrap();

        // Fake AppPaths layout.
        fs::create_dir_all(src.path().join("db")).unwrap();
        fs::write(src.path().join("db/index.sqlite"), b"sqlitebytes").unwrap();
        fs::create_dir_all(src.path().join("cache/thumbnails/root/a")).unwrap();
        fs::write(src.path().join("cache/thumbnails/root/a/b.jpg"), b"thumb").unwrap();
        fs::create_dir_all(src.path().join("cache/classifications/root/a")).unwrap();
        fs::write(src.path().join("cache/classifications/root/a/b.json"), b"{}").unwrap();

        let zip_path = out.path().join("catalog.zip");
        let report = export_catalog_at(src.path(), &zip_path).unwrap();
        assert!(zip_path.exists(), "zip should exist on disk");
        assert!(report.entries >= 3, "expected >=3 entries, got {}", report.entries);

        // Sanity: the zip opens and contains our files.
        let f = fs::File::open(&zip_path).unwrap();
        let mut arch = zip::ZipArchive::new(f).unwrap();
        let names: Vec<String> = (0..arch.len())
            .map(|i| arch.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(names.iter().any(|n| n.ends_with("index.sqlite")), "missing index.sqlite in {names:?}");
        assert!(names.iter().any(|n| n.contains("thumbnails/") || n.contains("thumbnails\\")), "missing thumbnails in {names:?}");
    }

    #[test]
    fn export_catalog_handles_missing_cache_dirs() {
        // If cache/thumbnails or cache/classifications don't exist, export should skip them gracefully, not fail.
        let src = tempdir().unwrap();
        let out = tempdir().unwrap();
        fs::create_dir_all(src.path().join("db")).unwrap();
        fs::write(src.path().join("db/index.sqlite"), b"only db").unwrap();
        // No cache/ tree at all.

        let zip_path = out.path().join("catalog.zip");
        let report = export_catalog_at(src.path(), &zip_path).unwrap();
        assert_eq!(report.entries, 1, "should export exactly the DB file");
    }

    #[test]
    fn export_catalog_refuses_overwrite_of_existing_zip() {
        let src = tempdir().unwrap();
        let out = tempdir().unwrap();
        fs::create_dir_all(src.path().join("db")).unwrap();
        fs::write(src.path().join("db/index.sqlite"), b"x").unwrap();

        let zip_path = out.path().join("catalog.zip");
        fs::write(&zip_path, b"pre-existing").unwrap();

        let err = export_catalog_at(src.path(), &zip_path);
        assert!(err.is_err(), "should refuse to overwrite existing zip");
    }
}
