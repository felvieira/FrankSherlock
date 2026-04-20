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

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub entries: usize,
    pub bytes: u64,
}

/// Restore a catalog bundle (previously produced by `export_catalog_at`) into `base_dir`.
///
/// Refuses if `base_dir/db/index.sqlite` already exists (to avoid silently clobbering
/// an active catalog). Rejects any zip entry whose path escapes `base_dir` via `..`
/// components or absolute paths.
pub fn import_catalog_at(bundle: &Path, base_dir: &Path) -> AppResult<ImportReport> {
    use std::io::Read;

    let db_target = base_dir.join("db").join("index.sqlite");
    if db_target.exists() {
        return Err(AppError::InvalidPath(format!(
            "refusing to overwrite existing catalog at {}",
            base_dir.display()
        )));
    }

    let file = std::fs::File::open(bundle)
        .map_err(|e| AppError::Config(format!("open bundle: {e}")))?;
    let mut arch = zip::ZipArchive::new(file)
        .map_err(|e| AppError::Config(format!("invalid zip: {e}")))?;

    let mut entries = 0usize;
    let mut bytes = 0u64;

    for i in 0..arch.len() {
        let mut zip_file = arch.by_index(i)
            .map_err(|e| AppError::Config(format!("zip idx {i}: {e}")))?;
        if zip_file.is_dir() {
            continue;
        }
        // Defense against Zip-Slip.
        let safe_rel = sanitize_zip_path(zip_file.name())
            .ok_or_else(|| AppError::InvalidPath(format!(
                "zip contains unsafe path: {}", zip_file.name()
            )))?;

        let target = base_dir.join(&safe_rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut buf = Vec::with_capacity(zip_file.size() as usize);
        zip_file.read_to_end(&mut buf)
            .map_err(|e| AppError::Config(format!("read {}: {e}", safe_rel.display())))?;
        std::fs::write(&target, &buf)?;
        entries += 1;
        bytes += buf.len() as u64;
    }

    Ok(ImportReport { entries, bytes })
}

/// Reject absolute paths and any entry containing a `..` component. Returns the
/// sanitized relative path on success, `None` on rejection.
fn sanitize_zip_path(name: &str) -> Option<std::path::PathBuf> {
    use std::path::{Component, PathBuf};
    let p = PathBuf::from(name);
    let mut cleaned = PathBuf::new();
    for c in p.components() {
        match c {
            Component::Normal(n) => cleaned.push(n),
            Component::CurDir => {}
            // Any of these means the archive tries to escape the base_dir.
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    if cleaned.as_os_str().is_empty() {
        return None;
    }
    Some(cleaned)
}

#[tauri::command]
pub async fn import_catalog_cmd(
    state: tauri::State<'_, AppState>,
    bundle: String,
) -> Result<ImportReport, String> {
    import_catalog_at(std::path::Path::new(&bundle), &state.paths.base_dir)
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

#[cfg(test)]
mod import_tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn import_restores_db_and_caches() {
        // Arrange: create + export.
        let src = tempdir().unwrap();
        fs::create_dir_all(src.path().join("db")).unwrap();
        fs::write(src.path().join("db/index.sqlite"), b"DBDATA").unwrap();
        fs::create_dir_all(src.path().join("cache/thumbnails")).unwrap();
        fs::write(src.path().join("cache/thumbnails/x.jpg"), b"T").unwrap();

        let bundle = src.path().join("bundle.zip");
        export_catalog_at(src.path(), &bundle).unwrap();

        // Act: import into fresh directory.
        let dst = tempdir().unwrap();
        let report = import_catalog_at(&bundle, dst.path()).unwrap();

        // Assert.
        assert_eq!(fs::read(dst.path().join("db/index.sqlite")).unwrap(), b"DBDATA");
        assert_eq!(fs::read(dst.path().join("cache/thumbnails/x.jpg")).unwrap(), b"T");
        assert!(report.entries >= 2, "expected >=2 entries, got {}", report.entries);
    }

    #[test]
    fn import_refuses_when_catalog_already_exists() {
        // If db/index.sqlite already exists in the destination, refuse to clobber.
        let src = tempdir().unwrap();
        fs::create_dir_all(src.path().join("db")).unwrap();
        fs::write(src.path().join("db/index.sqlite"), b"X").unwrap();
        let bundle = src.path().join("b.zip");
        export_catalog_at(src.path(), &bundle).unwrap();

        let dst = tempdir().unwrap();
        fs::create_dir_all(dst.path().join("db")).unwrap();
        fs::write(dst.path().join("db/index.sqlite"), b"EXISTING").unwrap();

        let err = import_catalog_at(&bundle, dst.path());
        assert!(err.is_err(), "should refuse to overwrite existing catalog");
        // Verify pre-existing file was not clobbered.
        assert_eq!(fs::read(dst.path().join("db/index.sqlite")).unwrap(), b"EXISTING");
    }

    #[test]
    fn import_rejects_path_traversal() {
        // Hand-craft a malicious zip with an entry like "../evil.txt".
        use std::io::Write;
        let tmp = tempdir().unwrap();
        let bundle = tmp.path().join("evil.zip");
        {
            let f = fs::File::create(&bundle).unwrap();
            let mut zw = zip::ZipWriter::new(f);
            let opts: zip::write::FileOptions<()> =
                zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            zw.start_file("../escaped.txt", opts).unwrap();
            zw.write_all(b"pwned").unwrap();
            zw.finish().unwrap();
        }

        let dst = tempdir().unwrap();
        let err = import_catalog_at(&bundle, dst.path());
        assert!(err.is_err(), "path traversal must be rejected");
        // The parent of dst should not have been written to.
        assert!(!dst.path().parent().unwrap().join("escaped.txt").exists());
    }

    #[test]
    fn import_roundtrip_preserves_all_files() {
        // End-to-end: export → import → byte-for-byte equivalence for every file.
        let src = tempdir().unwrap();
        fs::create_dir_all(src.path().join("db")).unwrap();
        fs::write(src.path().join("db/index.sqlite"), b"db-bytes").unwrap();
        fs::create_dir_all(src.path().join("cache/thumbnails/r/sub")).unwrap();
        fs::write(src.path().join("cache/thumbnails/r/sub/a.jpg"), b"thumb-a").unwrap();
        fs::write(src.path().join("cache/thumbnails/r/sub/b.jpg"), b"thumb-b").unwrap();
        fs::create_dir_all(src.path().join("cache/classifications/r/sub")).unwrap();
        fs::write(src.path().join("cache/classifications/r/sub/a.json"), b"{\"a\":1}").unwrap();

        let bundle = src.path().join("bundle.zip");
        export_catalog_at(src.path(), &bundle).unwrap();

        let dst = tempdir().unwrap();
        import_catalog_at(&bundle, dst.path()).unwrap();

        for rel in [
            "db/index.sqlite",
            "cache/thumbnails/r/sub/a.jpg",
            "cache/thumbnails/r/sub/b.jpg",
            "cache/classifications/r/sub/a.json",
        ] {
            assert_eq!(
                fs::read(src.path().join(rel)).unwrap(),
                fs::read(dst.path().join(rel)).unwrap(),
                "mismatch for {rel}"
            );
        }
    }
}
