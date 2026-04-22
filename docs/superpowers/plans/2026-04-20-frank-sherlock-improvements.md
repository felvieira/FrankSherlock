# Frank Sherlock Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship 10 improvements across data portability, scheduling, classification flexibility and UX.

**Architecture:** Six phases, each shippable on its own. Phase 1 (portability) solves the most concrete user pain — changing drive letters or migrating machines without losing hours of Ollama reprocessing. Phases 2-6 layer on top without breaking Phase 1's invariants.

**Tech Stack:** Rust (Tauri v2, rusqlite, rusqlite_migration, notify, zip), React + TypeScript (Vite), SQLite + FTS5, Ollama.

**Phase map:**

| # | Name | Solves | Est. |
|---|---|---|---|
| 1 | Data portability | Drive-letter swap, machine migration, portable drives | 2d |
| 2 | Schema normalization | Eliminate `abs_path` duplication → remap needs only roots | 1d |
| 3 | Watch mode | Auto-index on FS change, no manual rescan | 2d |
| 4 | Priority queue + multi-model | New files first, "fast" profile for backfill | 2d |
| 5 | Manual corrections + few-shot | User tags + drift-proof prompt | 2d |
| 6 | UI polish | Dedup actions, EXIF panel | 1d |

---

## Phase 1 — Data Portability

**Deliverables:** Three Tauri commands + UI: `remap_root`, `export_catalog`, `import_catalog`, and a `portable_mode` flag that relocates `AppPaths` under `<root>/.frank_sherlock/`.

**Files touched:**
- Create: `sherlock/desktop/src-tauri/src/portability.rs`
- Modify: `sherlock/desktop/src-tauri/src/db.rs` (add remap function)
- Modify: `sherlock/desktop/src-tauri/src/config.rs` (portable mode)
- Modify: `sherlock/desktop/src-tauri/src/lib.rs` (register commands)
- Create: `sherlock/desktop/src/features/portability/RemapRootDialog.tsx`
- Create: `sherlock/desktop/src/features/portability/ExportDialog.tsx`
- Create: `sherlock/desktop/src/features/portability/ImportDialog.tsx`
- Modify: `sherlock/desktop/src/App.tsx` (wire buttons)

### Task 1.1: `remap_root` DB primitive

**Files:**
- Modify: `sherlock/desktop/src-tauri/src/db.rs` (append near `move_files_to_child_root`)
- Test: inline `#[cfg(test)] mod tests` at bottom of `db.rs`

- [ ] **Step 1: Write the failing test**

Append to the existing `#[cfg(test)] mod tests` in `db.rs`:

```rust
#[test]
fn remap_root_updates_root_and_abs_paths() {
    use tempfile::tempdir;
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("test.sqlite");
    init_db(&db_path).unwrap();

    // Seed a root with one file.
    let root_id = upsert_root(&db_path, "D:\\Photos").unwrap();
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    conn.execute(
        "INSERT INTO files (root_id, rel_path, filename, abs_path, mtime_ns, size_bytes, fingerprint, updated_at)
         VALUES (?1, ?2, ?3, ?4, 0, 0, 'fp', 0)",
        rusqlite::params![root_id, "a/b.jpg", "b.jpg", "D:\\Photos\\a\\b.jpg"],
    ).unwrap();
    drop(conn);

    // Act.
    let changed = remap_root(&db_path, "D:\\Photos", "E:\\Photos").unwrap();
    assert_eq!(changed.roots_updated, 1);
    assert_eq!(changed.files_updated, 1);

    // Assert.
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    let root_path: String = conn.query_row(
        "SELECT root_path FROM roots WHERE id = ?1",
        rusqlite::params![root_id],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(root_path, "E:\\Photos");

    let abs: String = conn.query_row(
        "SELECT abs_path FROM files WHERE root_id = ?1",
        rusqlite::params![root_id],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(abs, "E:\\Photos\\a\\b.jpg");
}

#[test]
fn remap_root_rejects_collision_with_existing_root() {
    use tempfile::tempdir;
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("test.sqlite");
    init_db(&db_path).unwrap();
    upsert_root(&db_path, "D:\\A").unwrap();
    upsert_root(&db_path, "D:\\B").unwrap();

    let err = remap_root(&db_path, "D:\\A", "D:\\B");
    assert!(err.is_err(), "remap onto another existing root must fail");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd sherlock/desktop/src-tauri && cargo test remap_root --lib`
Expected: FAIL — `cannot find function remap_root`.

- [ ] **Step 3: Implement `remap_root`**

Append to `db.rs`:

```rust
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemapReport {
    pub roots_updated: usize,
    pub files_updated: usize,
    pub scan_jobs_updated: usize,
}

/// Rewrite `root_path` and all dependent `abs_path` columns when a root
/// moves (drive letter change, directory rename). Both paths are compared
/// and stored verbatim — the caller is expected to canonicalize.
///
/// Fails if `new_root_path` collides with another existing root.
pub fn remap_root(db_path: &Path, old_root_path: &str, new_root_path: &str) -> AppResult<RemapReport> {
    if old_root_path == new_root_path {
        return Ok(RemapReport::default());
    }
    let mut conn = Connection::open(db_path)?;
    let tx = conn.transaction()?;

    // Collision check.
    let collides: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM roots WHERE root_path = ?1)",
        params![new_root_path],
        |r| r.get::<_, i64>(0).map(|v| v != 0),
    )?;
    if collides {
        return Err(AppError::Config(format!(
            "remap target already exists as a root: {new_root_path}"
        )));
    }

    // Find the root id.
    let root_id: Option<i64> = tx.query_row(
        "SELECT id FROM roots WHERE root_path = ?1",
        params![old_root_path],
        |r| r.get(0),
    ).ok();
    let Some(root_id) = root_id else {
        return Err(AppError::Config(format!("no such root: {old_root_path}")));
    };

    let roots_updated = tx.execute(
        "UPDATE roots SET root_path = ?1 WHERE id = ?2",
        params![new_root_path, root_id],
    )?;

    // Rewrite only the prefix of abs_path to avoid clobbering substrings that
    // match elsewhere in the string.
    let files_updated = tx.execute(
        "UPDATE files SET abs_path = ?1 || substr(abs_path, length(?2) + 1)
         WHERE root_id = ?3 AND substr(abs_path, 1, length(?2)) = ?2",
        params![new_root_path, old_root_path, root_id],
    )?;

    let scan_jobs_updated = tx.execute(
        "UPDATE scan_jobs SET root_path = ?1 WHERE root_id = ?2",
        params![new_root_path, root_id],
    )?;

    tx.commit()?;
    Ok(RemapReport {
        roots_updated,
        files_updated,
        scan_jobs_updated,
    })
}

impl Default for RemapReport {
    fn default() -> Self {
        Self { roots_updated: 0, files_updated: 0, scan_jobs_updated: 0 }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd sherlock/desktop/src-tauri && cargo test remap_root --lib`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sherlock/desktop/src-tauri/src/db.rs
git commit -m "feat(db): add remap_root for drive-letter and path swaps"
```

### Task 1.2: Tauri command wrapper

**Files:**
- Create: `sherlock/desktop/src-tauri/src/portability.rs`
- Modify: `sherlock/desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: Write the test**

Create `portability.rs`:

```rust
//! Portability commands: remap, export, import, portable mode toggle.
use crate::db;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[tauri::command]
pub async fn remap_root_cmd(
    state: tauri::State<'_, AppState>,
    old_path: String,
    new_path: String,
) -> Result<db::RemapReport, String> {
    db::remap_root(&state.paths.db_file, &old_path, &new_path)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    // Integration coverage: db::tests already exercise the core logic.
    // The command layer is a thin adapter; add e2e tests in webapp-testing
    // phase (Task 1.9).
}
```

- [ ] **Step 2: Register the command in `lib.rs`**

`AppState` is currently `struct AppState { ... }` (private) at `lib.rs:36`. Change to `pub(crate) struct AppState` and make its fields accessed from `portability.rs` (`paths`) `pub(crate)` as well:

```rust
pub(crate) struct AppState {
    pub(crate) paths: AppPaths,
    // ... (other fields unchanged)
}
```

Locate the `.invoke_handler(tauri::generate_handler![...])` call in `run()` and add `portability::remap_root_cmd,`. Also add `mod portability;` near the top of `lib.rs`.

- [ ] **Step 3: Run cargo check**

Run: `cd sherlock/desktop/src-tauri && cargo check`
Expected: compiles clean.

- [ ] **Step 4: Commit**

```bash
git add sherlock/desktop/src-tauri/src/portability.rs sherlock/desktop/src-tauri/src/lib.rs
git commit -m "feat: expose remap_root_cmd to frontend"
```

### Task 1.3: Remap UI

**Files:**
- Create: `sherlock/desktop/src/features/portability/RemapRootDialog.tsx`
- Create: `sherlock/desktop/src/features/portability/RemapRootDialog.test.tsx`
- Modify: `sherlock/desktop/src/App.tsx`

- [ ] **Step 1: Write the failing component test**

Create `RemapRootDialog.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import RemapRootDialog from "./RemapRootDialog";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

describe("RemapRootDialog", () => {
  beforeEach(() => invoke.mockReset());

  it("submits old and new paths to remap_root_cmd", async () => {
    invoke.mockResolvedValue({ rootsUpdated: 1, filesUpdated: 42, scanJobsUpdated: 1 });
    render(<RemapRootDialog oldPath="D:\\Photos" onClose={() => {}} onRemapped={() => {}} />);

    fireEvent.change(screen.getByLabelText(/new path/i), { target: { value: "E:\\Photos" } });
    fireEvent.click(screen.getByRole("button", { name: /remap/i }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("remap_root_cmd", {
      oldPath: "D:\\Photos",
      newPath: "E:\\Photos",
    }));
    expect(screen.getByText(/42 file/i)).toBeInTheDocument();
  });

  it("shows error when backend rejects", async () => {
    invoke.mockRejectedValue("no such root: D:\\Photos");
    render(<RemapRootDialog oldPath="D:\\Photos" onClose={() => {}} onRemapped={() => {}} />);
    fireEvent.change(screen.getByLabelText(/new path/i), { target: { value: "Z:\\x" } });
    fireEvent.click(screen.getByRole("button", { name: /remap/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/no such root/i));
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `cd sherlock/desktop && npm run test -- RemapRootDialog`
Expected: FAIL (component missing).

- [ ] **Step 3: Implement `RemapRootDialog.tsx`**

```tsx
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "../../utils";

interface RemapReport { rootsUpdated: number; filesUpdated: number; scanJobsUpdated: number }

interface Props {
  oldPath: string;
  onClose: () => void;
  onRemapped: (report: RemapReport) => void;
}

export default function RemapRootDialog({ oldPath, onClose, onRemapped }: Props) {
  const [newPath, setNewPath] = useState(oldPath);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<RemapReport | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await invoke<RemapReport>("remap_root_cmd", { oldPath, newPath });
      setReport(result);
      onRemapped(result);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal" role="dialog" aria-label="Remap root">
      <h2>Remap Root</h2>
      <p>Old: <code>{oldPath}</code></p>
      <label>
        New path
        <input
          aria-label="new path"
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
        />
      </label>
      {error && <div role="alert" className="error">{error}</div>}
      {report && <div>Updated {report.filesUpdated} file record(s).</div>}
      <footer>
        <button onClick={onClose}>Close</button>
        <button onClick={submit} disabled={busy || !newPath || newPath === oldPath}>
          {busy ? "Remapping…" : "Remap"}
        </button>
      </footer>
    </div>
  );
}
```

- [ ] **Step 4: Run test to confirm pass**

Run: `cd sherlock/desktop && npm run test -- RemapRootDialog`
Expected: PASS.

- [ ] **Step 5: Wire into App.tsx**

Locate the sidebar root list (look for `useRootsManagement` or similar hook that yields `roots`). Add a context-menu or button per root: `Remap…`. On click, render `<RemapRootDialog oldPath={root.rootPath} onClose={...} onRemapped={() => reloadRoots()} />`.

- [ ] **Step 6: Commit**

```bash
git add sherlock/desktop/src/features/portability/ sherlock/desktop/src/App.tsx
git commit -m "feat(ui): remap root dialog"
```

### Task 1.4: `export_catalog` backend

**Files:**
- Modify: `sherlock/desktop/src-tauri/src/portability.rs`
- Modify: `sherlock/desktop/src-tauri/Cargo.toml` (add `zip` dep)

- [ ] **Step 1: Add dependency**

Edit `Cargo.toml`:

```toml
zip = { version = "2.2", default-features = false, features = ["deflate"] }
```

- [ ] **Step 2: Write the failing test**

Add to `portability.rs`:

```rust
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
        assert!(zip_path.exists());
        assert!(report.entries >= 3);

        // Sanity: the zip opens and contains our files.
        let f = fs::File::open(&zip_path).unwrap();
        let mut arch = zip::ZipArchive::new(f).unwrap();
        let names: Vec<String> = (0..arch.len())
            .map(|i| arch.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(names.iter().any(|n| n.ends_with("index.sqlite")));
        assert!(names.iter().any(|n| n.contains("thumbnails/")));
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cd sherlock/desktop/src-tauri && cargo test export_catalog`
Expected: FAIL.

- [ ] **Step 4: Implement `export_catalog_at`**

Add to `portability.rs`:

```rust
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub zip_path: String,
    pub entries: usize,
    pub bytes: u64,
}

/// Export db + thumbnails + classifications into a single zip.
/// `base_dir` is the AppPaths base (what `config::resolve_paths().base_dir` returns).
pub fn export_catalog_at(base_dir: &Path, zip_path: &Path) -> AppResult<ExportReport> {
    use std::io::Write;

    let file = std::fs::File::create(zip_path)
        .map_err(|e| AppError::Config(format!("cannot create zip: {e}")))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts: zip::write::FileOptions<()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let mut entries = 0usize;
    let mut bytes = 0u64;

    for (label, rel) in [
        ("db", Path::new("db")),
        ("thumbnails", Path::new("cache/thumbnails")),
        ("classifications", Path::new("cache/classifications")),
    ] {
        let abs = base_dir.join(rel);
        if !abs.exists() {
            continue;
        }
        for entry in walkdir::WalkDir::new(&abs) {
            let entry = entry.map_err(|e| AppError::Config(format!("{label}: {e}")))?;
            if !entry.file_type().is_file() {
                continue;
            }
            let rel_in_zip = entry.path().strip_prefix(base_dir).unwrap();
            zip.start_file(rel_in_zip.to_string_lossy(), opts)
                .map_err(|e| AppError::Config(format!("zip start: {e}")))?;
            let data = std::fs::read(entry.path())?;
            zip.write_all(&data)
                .map_err(|e| AppError::Config(format!("zip write: {e}")))?;
            entries += 1;
            bytes += data.len() as u64;
        }
    }

    zip.finish().map_err(|e| AppError::Config(format!("zip finish: {e}")))?;
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
```

- [ ] **Step 5: Run tests**

Run: `cd sherlock/desktop/src-tauri && cargo test export_catalog`
Expected: PASS.

- [ ] **Step 6: Register command + commit**

Add `portability::export_catalog_cmd` to the invoke handler in `lib.rs`.

```bash
git add sherlock/desktop/src-tauri/
git commit -m "feat(portability): zip-based catalog export"
```

### Task 1.5: `import_catalog` backend

**Files:**
- Modify: `sherlock/desktop/src-tauri/src/portability.rs`

- [ ] **Step 1: Write the failing test**

Add to `portability.rs`:

```rust
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
        assert!(report.entries >= 2);
    }

    #[test]
    fn import_refuses_to_clobber_nonempty_base_without_force() {
        let src = tempdir().unwrap();
        fs::create_dir_all(src.path().join("db")).unwrap();
        fs::write(src.path().join("db/index.sqlite"), b"X").unwrap();
        let bundle = src.path().join("b.zip");
        export_catalog_at(src.path(), &bundle).unwrap();

        let dst = tempdir().unwrap();
        fs::create_dir_all(dst.path().join("db")).unwrap();
        fs::write(dst.path().join("db/index.sqlite"), b"EXISTING").unwrap();

        assert!(import_catalog_at(&bundle, dst.path()).is_err());
    }
}
```

- [ ] **Step 2: Implement `import_catalog_at`**

Add to `portability.rs`:

```rust
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub entries: usize,
    pub bytes: u64,
}

pub fn import_catalog_at(bundle: &Path, base_dir: &Path) -> AppResult<ImportReport> {
    use std::io::Read;

    let db_target = base_dir.join("db").join("index.sqlite");
    if db_target.exists() {
        return Err(AppError::Config(format!(
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
        let rel = PathBuf::from(zip_file.name());
        let target = base_dir.join(&rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut buf = Vec::with_capacity(zip_file.size() as usize);
        zip_file.read_to_end(&mut buf)
            .map_err(|e| AppError::Config(format!("read {}: {e}", rel.display())))?;
        std::fs::write(&target, &buf)?;
        entries += 1;
        bytes += buf.len() as u64;
    }

    Ok(ImportReport { entries, bytes })
}

#[tauri::command]
pub async fn import_catalog_cmd(
    state: tauri::State<'_, AppState>,
    bundle: String,
) -> Result<ImportReport, String> {
    import_catalog_at(std::path::Path::new(&bundle), &state.paths.base_dir)
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 3: Run tests**

Run: `cd sherlock/desktop/src-tauri && cargo test import_catalog`
Expected: PASS.

- [ ] **Step 4: Register + commit**

Add `portability::import_catalog_cmd` to the invoke handler.

```bash
git add sherlock/desktop/src-tauri/
git commit -m "feat(portability): import catalog from zip"
```

### Task 1.6: Export/Import UI

**Files:**
- Create: `sherlock/desktop/src/features/portability/ExportDialog.tsx`
- Create: `sherlock/desktop/src/features/portability/ImportDialog.tsx`
- Create: corresponding `.test.tsx`
- Modify: `sherlock/desktop/src/App.tsx` (settings menu entries)

- [ ] **Step 1: Write tests mirroring Task 1.3**

Pattern: mock `@tauri-apps/api/core`, render the dialog, invoke the command, assert the success/error UI paths. Use file path input + `@tauri-apps/plugin-dialog` `save`/`open` for native dialogs.

- [ ] **Step 2: Implement both dialogs**

They share the shape of `RemapRootDialog` — one text field (file path), one submit, a busy/error/report state. Use `import { save, open } from "@tauri-apps/plugin-dialog"` for native file pickers.

- [ ] **Step 3: Wire menu entries in App.tsx**

Add "Export catalog…" and "Import catalog…" to the settings dropdown. Guard import with a confirm modal ("This replaces the current index. Proceed?").

- [ ] **Step 4: Commit**

```bash
git commit -am "feat(ui): export and import catalog dialogs"
```

### Task 1.7: Portable mode

**Files:**
- Modify: `sherlock/desktop/src-tauri/src/config.rs`
- Modify: `sherlock/desktop/src-tauri/src/portability.rs`

- [ ] **Step 1: Write tests for portable resolution**

Append to `config.rs` tests:

```rust
#[test]
fn resolve_paths_portable_uses_root_subdir() {
    let _guard = ENV_LOCK.lock().unwrap();
    env::remove_var(DATA_DIR_ENV);
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("MyDrive");
    std::fs::create_dir_all(&root).unwrap();

    let paths = resolve_paths_for_root(Some(&root)).unwrap();
    assert!(paths.base_dir.starts_with(&root));
    assert_eq!(paths.base_dir.file_name().unwrap(), ".frank_sherlock");
}
```

- [ ] **Step 2: Implement**

Add to `config.rs`:

```rust
/// Resolve paths; when `portable_root` is `Some`, place the data directory
/// inside `<root>/.frank_sherlock/` so the catalog travels with the drive.
pub fn resolve_paths_for_root(portable_root: Option<&Path>) -> AppResult<AppPaths> {
    let base_dir = if let Some(root) = portable_root {
        root.join(".frank_sherlock")
    } else {
        match env::var(DATA_DIR_ENV) {
            Ok(v) if !v.trim().is_empty() => PathBuf::from(v),
            _ => default_base_dir()?,
        }
    };
    build_paths(base_dir)
}

fn build_paths(base_dir: PathBuf) -> AppResult<AppPaths> {
    let db_dir = base_dir.join("db");
    let cache_dir = base_dir.join("cache");
    Ok(AppPaths {
        db_file: db_dir.join("index.sqlite"),
        classification_cache_dir: cache_dir.join("classifications"),
        thumbnails_dir: cache_dir.join("thumbnails"),
        scans_dir: cache_dir.join("scans"),
        surya_venv_dir: base_dir.join("surya_venv"),
        tmp_dir: cache_dir.join("tmp"),
        models_dir: base_dir.join("models"),
        face_crops_dir: cache_dir.join("face_crops"),
        db_dir,
        cache_dir,
        base_dir,
    })
}
```

Rewrite the existing `resolve_paths()` to `build_paths(base)` so both entry points share.

- [ ] **Step 3: Persist the choice**

In `user_config`, store `portable_root: Option<String>`. On startup `lib.rs` calls `resolve_paths_for_root(config.portable_root.as_deref().map(Path::new))`.

- [ ] **Step 4: Add UI toggle**

In the settings dialog, add a checkbox "Store catalog inside scanned root (portable)" + a path picker. On save, write config and prompt a restart.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat: portable mode stores catalog under <root>/.frank_sherlock"
```

### Task 1.8: Ignore `.frank_sherlock` during scan

**Files:**
- Modify: `sherlock/desktop/src-tauri/src/scan.rs`

- [ ] **Step 1: Write the failing test**

Add to `scan.rs`:

```rust
#[test]
fn scan_skips_frank_sherlock_dir() {
    // Arrange a root with .frank_sherlock/db/index.sqlite; walker must not enter.
    use tempfile::tempdir;
    let dir = tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(".frank_sherlock/db")).unwrap();
    std::fs::write(dir.path().join(".frank_sherlock/db/index.sqlite"), b"x").unwrap();
    std::fs::write(dir.path().join("photo.jpg"), b"ignored payload").unwrap();

    let entries = walk_indexable(dir.path()).unwrap();
    let names: Vec<_> = entries.iter().map(|p| p.file_name().unwrap().to_string_lossy().to_string()).collect();
    assert!(names.contains(&"photo.jpg".to_string()));
    assert!(!names.iter().any(|n| n == "index.sqlite"));
}
```

- [ ] **Step 2: Add the filter**

In the scan walker (`walkdir::WalkDir::new(...).into_iter().filter_entry(...)`), filter out any entry whose `file_name()` equals `".frank_sherlock"`. If `walk_indexable` is not an existing public helper, extract the walker into one for testability.

- [ ] **Step 3: Commit**

```bash
git commit -am "fix(scan): skip .frank_sherlock portable catalog during walks"
```

### Task 1.9: End-to-end smoke via webapp-testing

- [ ] **Step 1** — Use the `anthropic-skills:webapp-testing` skill to drive the dev app: create a root, scan a tiny dir, rename the dir, remap, confirm no rescans.
- [ ] **Step 2** — Repeat with export → wipe `base_dir` → import → confirm results appear unchanged.
- [ ] **Step 3** — Commit `docs/superpowers/plans/2026-04-20-phase1-smoke.md` with the scenario transcript.

```bash
git commit -am "docs: phase-1 portability smoke transcript"
```

---

## Phase 2 — Schema Normalization

**Why:** Phase 1 works but `remap_root` has to rewrite every row's `abs_path`. Normalize so `abs_path` is derived, not stored.

**Approach:** Drop the column, expose it through a VIEW (`files_with_abs`) that joins `roots.root_path || '/' || files.rel_path`. All call sites that currently `SELECT abs_path FROM files` become `SELECT abs_path FROM files_with_abs`. All writers stop filling it.

**Tasks:**

- [ ] **2.1** Migration 12: `CREATE VIEW files_with_abs AS SELECT f.*, (r.root_path || '/' || f.rel_path) AS abs_path FROM files f JOIN roots r ON r.id = f.root_id`. On Windows use `REPLACE` to normalize separators or store `root_path` without trailing slash and let `rel_path` carry the separator.
- [ ] **2.2** Audit every `SELECT ... abs_path ... FROM files` (`rg "abs_path" src-tauri/src/`) and rewrite to read from the view. Writers: remove `abs_path` from INSERTs and the UPSERT on conflict.
- [ ] **2.3** Migration 13: `ALTER TABLE files DROP COLUMN abs_path` (SQLite ≥ 3.35).
- [ ] **2.4** Rewrite `remap_root`: remove the files UPDATE, keep roots + scan_jobs updates only. Tests still pass because `abs_path` is now computed.
- [ ] **2.5** Add `cargo test --lib` + `npm run test` green-run gate before commit.

```bash
git commit -am "refactor(db): make abs_path a derived view"
```

**Rollback plan:** migrations are append-only; if the view breaks anything, add Migration 14 that re-adds `abs_path` and a one-off `UPDATE files SET abs_path = r.root_path || '/' || f.rel_path` rebuild.

---

## Phase 3 — Watch Mode

**Deliverables:** When enabled, the app watches each `root` via the `notify` crate. New/modified files are queued for classification without a full rescan.

**Files:**
- Create: `sherlock/desktop/src-tauri/src/watcher.rs`
- Modify: `sherlock/desktop/src-tauri/Cargo.toml` (`notify = "6"`)
- Modify: `sherlock/desktop/src-tauri/src/lib.rs` (spawn watcher task)
- Create: `sherlock/desktop/src/features/watcher/WatcherToggle.tsx`

**Tasks:**

- [ ] **3.1** Extract the single-file classify pipeline out of `scan.rs` into `pipeline::process_one(path)` callable from both scan and watcher. Preserve cache and move-detection semantics.
- [ ] **3.2** Implement `watcher::start(roots, tx: Sender<PathBuf>, cancel: CancellationToken)`. Use `notify::RecommendedWatcher`, debounce via `notify-debouncer-full` 0.3+ to coalesce bursts within 1s.
- [ ] **3.3** Spawn a Tokio task consuming the channel, calling `pipeline::process_one(path)`, emitting `scan-progress` events so the existing UI updates.
- [ ] **3.4** UI: `WatcherToggle.tsx` with per-root on/off, backed by `user_config.watch = { rootId: bool }`. Persist, emit `watcher_configure_cmd`.
- [ ] **3.5** Tests: integration test under `src-tauri/tests/watcher_integration.rs` that creates a tempdir, writes a JPEG, asserts the DB contains a matching `files` row within 5s. Mock Ollama via a local HTTP stub (pattern from `classify.rs` tests).
- [ ] **3.6** Ignore `.frank_sherlock/` and any path matching the existing scan filters.

```bash
git commit -am "feat: filesystem watch mode with debounced classification"
```

---

## Phase 4 — Priority Queue + Multi-Model

### 4A — Priority queue

**Problem:** current scan processes files in directory order. For a 100k-file NAS, brand-new photos from today sit at the end.

**Tasks:**

- [ ] **4A.1** Introduce `scan_queue` table: `(file_id, priority INT, enqueued_at INT)`; `priority` is `100 - log10(age_seconds + 1) * 10` clamped — newer files bubble up. Populate during Phase-1 discovery.
- [ ] **4A.2** Replace the phase-2 loop with a heap pull: `SELECT file_id FROM scan_queue ORDER BY priority DESC, enqueued_at ASC LIMIT 1`.
- [ ] **4A.3** Watcher (Phase 3) inserts with priority 200 (above any backfill).
- [ ] **4A.4** Add `cargo test scan_queue_orders_recent_first`.

### 4B — Multi-model profiles

**Tasks:**

- [ ] **4B.1** Extend `user_config.json` schema:
  ```json
  { "modelProfiles": { "fast": "moondream:latest", "thorough": "qwen2.5vl:7b" },
    "activeProfile": "thorough" }
  ```
- [ ] **4B.2** `classify.rs` reads `active_profile` from state instead of the hard-coded constant. For `fast`, skip OCR + document enrichment (still cheap with moondream).
- [ ] **4B.3** Add UI dropdown in the scan dialog: "Model: Fast / Thorough". Store last choice per root.
- [ ] **4B.4** Test: launch classify with a fake HTTP stub, assert the model name in the outgoing request matches the active profile.

```bash
git commit -am "feat: priority queue + fast/thorough model profiles"
```

---

## Phase 5 — Manual Corrections + Few-Shot

**Goal:** let users override a bad classification and feed the correction back into the prompt as a few-shot example.

**Tasks:**

- [ ] **5.1** Migration 14: `CREATE TABLE file_overrides (file_id INTEGER PRIMARY KEY, media_type TEXT, description TEXT, tags TEXT, corrected_at INTEGER, FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE)`.
- [ ] **5.2** Tauri commands: `override_classification_cmd(file_id, { mediaType?, description?, tags? })`, `clear_override_cmd(file_id)`.
- [ ] **5.3** Query reads: join `file_overrides` and COALESCE overrides over the model output.
- [ ] **5.4** UI: preview overlay gains "Edit classification" button → modal with media-type select + description textarea + tag chips.
- [ ] **5.5** Few-shot: at classify time, pull up to 5 random overrides with the same media-type guess and inject them as "here are corrections from the user" examples before the instruction block in `classify.rs`.
- [ ] **5.6** Add `cargo test classify_injects_user_corrections` using the HTTP stub to assert the prompt body contains the correction text.

```bash
git commit -am "feat: manual classification overrides with few-shot feedback"
```

---

## Phase 6 — UI Polish

### 6A — Dedup actions

**Tasks:**

- [ ] **6A.1** Add command `dedup_action_cmd(file_ids: Vec<i64>, action: "trash" | "hardlink_to_first")`. Use the `trash` crate for cross-platform recycle-bin moves. For hardlink, pick the oldest `mtime_ns` as the canonical target and `std::fs::hard_link` the others after deleting.
- [ ] **6A.2** UI: the existing duplicates view gains a footer with two buttons. Guard destructive actions with a confirm dialog showing how many files are affected.
- [ ] **6A.3** After success, mark the removed rows as `deleted_at = now` so FTS drops them.

### 6B — EXIF panel

**Tasks:**

- [ ] **6B.1** `exif.rs` already extracts most fields; expose them via `get_file_exif_cmd(file_id) -> ExifView { date, gps, camera, lens, iso, shutter, aperture }`.
- [ ] **6B.2** Preview overlay: collapsible "Details" panel on the right rail rendering the fields when present.
- [ ] **6B.3** If `gps` is populated, render a small OpenStreetMap link (`https://www.openstreetmap.org/?mlat=…&mlon=…#map=14/…/…`).

```bash
git commit -am "feat(ui): dedup actions + EXIF panel"
```

---

## Post-phase checklist

- [ ] All `cargo test` + `npm run test` green on all three OS matrices.
- [ ] CLAUDE.md updated with new commands, tables and config keys.
- [ ] `releases/vNEXT.md` summarizes the phase-level features user-visibly.
- [ ] Manual smoke: ingest a 100-file directory, rename it, remap, confirm zero reprocesses.

```

