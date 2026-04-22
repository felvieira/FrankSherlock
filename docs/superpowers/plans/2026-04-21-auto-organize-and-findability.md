# Auto-Organize & Findability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship 21 features across six phases that turn the catalog into a navigable memory — auto-organizing media from existing EXIF/dHash/face data, and adding visual search tools so the user finds anything in ≤3 clicks.

**Architecture:** Every phase reuses data already in the DB (EXIF via `exif.rs`, dHash via `similarity.rs`, face embeddings via `face.rs`, descriptions from the Ollama pipeline). No new ML models. Phase 1 lands the SQL-only wins; Phase 2 upgrades the search bar; Phases 3-6 layer clustering, map/color, rules, and ambient surfaces on top.

**Tech stack:** Rust (rusqlite migrations, `image` + `imageproc` for blur detection, `rqrr` for QR), React + TS (Vitest), SQLite FTS5, Leaflet or MapLibre GL (Phase 4).

**Phase map:**

| # | Name | Features | Est. |
|---|---|---|---|
| 1 | EXIF-only quick wins | camera/lens filter, time-of-day filter, tag autocomplete | 1-2d |
| 2 | Search builder & timeline | visual query chips, tag autocomplete wiring, timeline heatmap | 2-3d |
| 3 | Auto-clustering | events, trips, burst collapse, blur detect, year-in-review, dedup policies | 4-5d |
| 4 | Map, color, content | color palette, offline map + nearby, QR/barcode | 3-4d |
| 5 | Auto-tagging & smart albums | path-pattern rules, face smart albums, album tag inheritance, selfie/group | 2-3d |
| 6 | Ambient surfaces | saved-search alerts, ambient similar sidebar | 1-2d |

---

## Phase 1 — EXIF-only quick wins

**Problem:** `exif.rs` already extracts camera model, lens model, ISO, shutter, aperture, and datetime into the DB (Migration 1 stored `location_text`; we'll need a new migration for the camera/lens columns if they're not yet persisted — check first). All of this is already indexed but no UI surfaces it. The user can't answer "which photos are from my iPhone 14?" in the current app.

**Deliverables:** Three new filter inputs wired into the existing search, plus a tag-autocomplete hook the Phase 2 chip builder will reuse.

### Task 1.1: Persist camera/lens columns (if missing)

**Files:**
- Modify: `sherlock/desktop/src-tauri/src/db.rs` (append migration)
- Modify: `sherlock/desktop/src-tauri/src/exif.rs` (fill the columns during extraction)
- Modify: `sherlock/desktop/src-tauri/src/scan.rs` (pass the values through to `upsert_file`)

- [ ] **Step 1: Verify the current schema**

Run from the worktree:

```
cd sherlock/desktop/src-tauri && grep -n "camera_model\|lens_model\|iso\|shutter_speed\|aperture" src/db.rs src/exif.rs
```

If the columns already exist (some projects land them silently), skip to Task 1.2. If not, proceed.

- [ ] **Step 2: Write the failing migration test**

Append to `#[cfg(test)] mod tests` in `db.rs`:

```rust
#[test]
fn migration_adds_camera_and_lens_columns() {
    use tempfile::tempdir;
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("test.sqlite");
    init_database(&db_path).unwrap();

    let conn = rusqlite::Connection::open(&db_path).unwrap();
    let mut stmt = conn.prepare("PRAGMA table_info(files)").unwrap();
    let cols: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .unwrap()
        .filter_map(|r| r.ok())
        .collect();

    for required in ["camera_model", "lens_model", "iso", "shutter_speed", "aperture", "time_of_day"] {
        assert!(cols.iter().any(|c| c == required), "missing column {required}, got {cols:?}");
    }
}
```

- [ ] **Step 3: Run tests to verify failure**

```
cd sherlock/desktop/src-tauri && cargo test migration_adds_camera --lib
```

Expected: FAIL on missing columns.

- [ ] **Step 4: Append the migration**

Find the bottom of the `Migrations::new(vec![...])` list in `run_migrations()` and append:

```rust
// Migration 12: camera/lens/EXIF detail columns for Phase 1 quick filters.
M::up(
    "ALTER TABLE files ADD COLUMN camera_model TEXT NOT NULL DEFAULT '';
     ALTER TABLE files ADD COLUMN lens_model TEXT NOT NULL DEFAULT '';
     ALTER TABLE files ADD COLUMN iso INTEGER;
     ALTER TABLE files ADD COLUMN shutter_speed REAL;
     ALTER TABLE files ADD COLUMN aperture REAL;
     ALTER TABLE files ADD COLUMN time_of_day TEXT NOT NULL DEFAULT '';
     CREATE INDEX IF NOT EXISTS idx_files_camera_model ON files(camera_model);
     CREATE INDEX IF NOT EXISTS idx_files_time_of_day ON files(time_of_day);"
),
```

(If the migration count in the existing list is not 12 when you add this, adjust the number in the comment — `rusqlite_migration` identifies migrations by position, not by the comment.)

- [ ] **Step 5: Run tests to verify they pass**

```
cargo test migration_adds_camera --lib
```

Expected: PASS.

- [ ] **Step 6: Commit**

```
git add sherlock/desktop/src-tauri/src/db.rs
git commit -m "feat(db): add camera/lens/iso/shutter/aperture/time_of_day columns"
```

### Task 1.2: Populate the columns from EXIF

**Files:**
- Modify: `sherlock/desktop/src-tauri/src/exif.rs`
- Modify: `sherlock/desktop/src-tauri/src/db.rs` (the `upsert_file` writer — add the new fields to the `FileRecord`/INSERT)
- Modify: `sherlock/desktop/src-tauri/src/scan.rs` (pass the values through)

- [ ] **Step 1: Write the failing extraction test**

Append to `#[cfg(test)] mod tests` in `exif.rs`:

```rust
#[test]
fn extract_exif_fills_camera_lens_iso_aperture_time_of_day() {
    // Use a fixture JPEG that ships with the project or embed one here via include_bytes!.
    let bytes = include_bytes!("../tests/fixtures/canon_5d_sample.jpg");
    // If that fixture doesn't exist, generate a tiny in-memory JPEG with known EXIF.
    let meta = extract_exif_from_bytes(bytes).unwrap();
    assert!(!meta.camera_model.is_empty());
    assert!(meta.iso.is_some());
    assert!(matches!(meta.time_of_day.as_str(),
        "night" | "dawn" | "morning" | "noon" | "afternoon" | "evening"));
}
```

If no suitable fixture exists, build an inline test using a synthesized JPEG + known EXIF via the `kamadak-exif` crate (already a dep). The key assertion: `time_of_day` is derived from `DateTimeOriginal` hour.

- [ ] **Step 2: Run to confirm failure**

```
cargo test extract_exif_fills --lib
```

Expected: FAIL (fields missing or all empty).

- [ ] **Step 3: Extend the extractor**

In `exif.rs`, find the `ExifMetadata` struct (or equivalent). Add fields:

```rust
pub struct ExifMetadata {
    // ... existing fields ...
    pub camera_model: String,
    pub lens_model: String,
    pub iso: Option<u32>,
    pub shutter_speed: Option<f64>,
    pub aperture: Option<f64>,
    pub time_of_day: String,
}
```

In the extractor function, read the EXIF tags:

```rust
let camera_model = reader
    .get_field(Tag::Model, In::PRIMARY)
    .and_then(|f| f.display_value().to_string().trim().trim_matches('"').to_string().into())
    .unwrap_or_default();

let lens_model = reader
    .get_field(Tag::LensModel, In::PRIMARY)
    .map(|f| f.display_value().to_string().trim().trim_matches('"').to_string())
    .unwrap_or_default();

let iso = reader
    .get_field(Tag::PhotographicSensitivity, In::PRIMARY)
    .and_then(|f| f.value.get_uint(0));

let shutter_speed = reader
    .get_field(Tag::ExposureTime, In::PRIMARY)
    .and_then(|f| match &f.value {
        exif::Value::Rational(v) if !v.is_empty() => Some(v[0].to_f64()),
        _ => None,
    });

let aperture = reader
    .get_field(Tag::FNumber, In::PRIMARY)
    .and_then(|f| match &f.value {
        exif::Value::Rational(v) if !v.is_empty() => Some(v[0].to_f64()),
        _ => None,
    });

let time_of_day = datetime_original
    .map(|dt| classify_time_of_day(dt.hour()))
    .unwrap_or_default();
```

Add the helper at module scope:

```rust
fn classify_time_of_day(hour: u32) -> String {
    match hour {
        0..=4 => "night",
        5..=7 => "dawn",
        8..=11 => "morning",
        12..=13 => "noon",
        14..=17 => "afternoon",
        18..=20 => "evening",
        _ => "night",
    }
    .to_string()
}
```

- [ ] **Step 4: Thread the values through the writer**

In `db.rs`, find `FileRecord` (or whatever struct `upsert_file` takes) and add the six new fields, then update the INSERT + UPSERT to include them. If the struct has a builder, add setters; if it's a plain struct, add the fields with defaults.

In `scan.rs`, wherever `FileRecord` is constructed for a scanned file, populate the new fields from the `ExifMetadata` returned by `extract_exif`.

- [ ] **Step 5: Run test to verify it passes**

```
cargo test extract_exif_fills --lib
```

Expected: PASS.

- [ ] **Step 6: Commit**

```
git add sherlock/desktop/src-tauri/src/exif.rs sherlock/desktop/src-tauri/src/db.rs sherlock/desktop/src-tauri/src/scan.rs
git commit -m "feat(exif): extract camera/lens/iso/shutter/aperture/time_of_day"
```

### Task 1.3: `list_cameras` + `list_lenses` Tauri commands

**Files:**
- Create: `sherlock/desktop/src-tauri/src/filters.rs`
- Modify: `sherlock/desktop/src-tauri/src/lib.rs` (module + handler registration)

- [ ] **Step 1: Write the failing test**

Create `filters.rs`:

```rust
//! Aggregation queries that feed the search-filter UI.
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
    let rows = stmt.query_map([], |r| Ok(FilterOption { value: r.get(0)?, count: r.get(1)? }))?;
    Ok(rows.filter_map(Result::ok).collect())
}

pub fn list_lenses(db_path: &Path) -> AppResult<Vec<FilterOption>> {
    let conn = open_conn(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT lens_model, COUNT(*) AS c FROM files
         WHERE deleted_at IS NULL AND lens_model != ''
         GROUP BY lens_model ORDER BY c DESC, lens_model ASC",
    )?;
    let rows = stmt.query_map([], |r| Ok(FilterOption { value: r.get(0)?, count: r.get(1)? }))?;
    Ok(rows.filter_map(Result::ok).collect())
}

#[tauri::command]
pub async fn list_cameras_cmd(state: tauri::State<'_, crate::AppState>) -> Result<Vec<FilterOption>, String> {
    list_cameras(&state.paths.db_file).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_lenses_cmd(state: tauri::State<'_, crate::AppState>) -> Result<Vec<FilterOption>, String> {
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
            rusqlite::params![root_id, filename, filename, format!("D:\\P\\{filename}"),
                              format!("fp-{filename}"), camera, lens],
        ).unwrap();
    }

    #[test]
    fn list_cameras_groups_and_counts_descending() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("t.sqlite");
        init_database(&db).unwrap();
        let root = upsert_root(&db, "D:\\P").unwrap();
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
        let root = upsert_root(&db, "D:\\P").unwrap();
        let conn = Connection::open(&db).unwrap();
        seed(&conn, root, "a.jpg", "", "50mm f/1.8");
        seed(&conn, root, "b.jpg", "", "");
        drop(conn);

        let out = list_lenses(&db).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].value, "50mm f/1.8");
    }
}
```

- [ ] **Step 2: Register the module + handlers**

In `lib.rs`: `mod filters;` and add `filters::list_cameras_cmd, filters::list_lenses_cmd,` to the `generate_handler!` list.

- [ ] **Step 3: Run tests**

```
cargo test filters --lib -- --test-threads=1
```

Expected: 2 tests pass.

- [ ] **Step 4: Commit**

```
git commit -am "feat(filters): list_cameras and list_lenses aggregation queries"
```

### Task 1.4: Thread camera/lens/time_of_day into search

**Files:**
- Modify: `sherlock/desktop/src-tauri/src/query_parser.rs` (add tokens `camera:`, `lens:`, `time:`)
- Modify: the search query builder (grep for `query_parser` callers in `lib.rs` or `db.rs` — find where `media_type` is applied as a WHERE clause, add parallel clauses).

- [ ] **Step 1: Write the failing test**

Append to `query_parser.rs` tests:

```rust
#[test]
fn parses_camera_and_lens_and_time_tokens() {
    let parsed = parse_query(r#"beach camera:"iPhone 14 Pro" lens:50mm time:evening"#);
    assert_eq!(parsed.camera_model.as_deref(), Some("iPhone 14 Pro"));
    assert_eq!(parsed.lens_model.as_deref(), Some("50mm"));
    assert_eq!(parsed.time_of_day.as_deref(), Some("evening"));
    assert_eq!(parsed.free_text.trim(), "beach");
}
```

- [ ] **Step 2: Extend `ParsedQuery` + parser**

Add the three `Option<String>` fields to `ParsedQuery`. In the parser loop, handle tokens matching `camera:`, `lens:`, `time:` (with quoted-string support — follow whatever pattern `subdir:` already uses).

- [ ] **Step 3: Thread clauses into the SQL builder**

Wherever the parsed query's `media_type` is applied (search for `ParsedQuery` usage), add `AND camera_model = ?` / `AND lens_model = ?` / `AND time_of_day = ?` clauses when the fields are `Some(_)`.

- [ ] **Step 4: Run parser test + search test**

```
cargo test query_parser --lib
```

Expected: PASS.

- [ ] **Step 5: Commit**

```
git commit -am "feat(search): camera:/lens:/time: query tokens"
```

### Task 1.5: Tag autocomplete backend

**Files:**
- Create: `sherlock/desktop/src-tauri/src/autocomplete.rs`
- Modify: `sherlock/desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Create `autocomplete.rs`:

```rust
//! Autocomplete suggestions for the search bar — pulls from canonical_mentions,
//! camera_model, lens_model, and people.name. Lowercased + deduped + ranked by count.
use crate::db::open_conn;
use crate::error::AppResult;
use std::path::Path;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub label: String,
    pub kind: String,      // "person" | "camera" | "lens" | "mention"
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

    // People.
    let mut stmt = conn.prepare(
        "SELECT name, (SELECT COUNT(*) FROM face_detections WHERE person_id = p.id) AS c
         FROM people p
         WHERE LOWER(name) LIKE ?1
         ORDER BY c DESC LIMIT ?2",
    )?;
    for row in stmt.query_map(rusqlite::params![pattern, limit as i64], |r| {
        Ok(Suggestion { label: r.get(0)?, kind: "person".into(), count: r.get(1)? })
    })? {
        if let Ok(s) = row { out.push(s); }
    }

    // Cameras.
    let mut stmt = conn.prepare(
        "SELECT camera_model, COUNT(*) FROM files
         WHERE deleted_at IS NULL AND camera_model != '' AND LOWER(camera_model) LIKE ?1
         GROUP BY camera_model ORDER BY COUNT(*) DESC LIMIT ?2",
    )?;
    for row in stmt.query_map(rusqlite::params![pattern, limit as i64], |r| {
        Ok(Suggestion { label: r.get(0)?, kind: "camera".into(), count: r.get(1)? })
    })? {
        if let Ok(s) = row { out.push(s); }
    }

    // Lenses.
    let mut stmt = conn.prepare(
        "SELECT lens_model, COUNT(*) FROM files
         WHERE deleted_at IS NULL AND lens_model != '' AND LOWER(lens_model) LIKE ?1
         GROUP BY lens_model ORDER BY COUNT(*) DESC LIMIT ?2",
    )?;
    for row in stmt.query_map(rusqlite::params![pattern, limit as i64], |r| {
        Ok(Suggestion { label: r.get(0)?, kind: "lens".into(), count: r.get(1)? })
    })? {
        if let Ok(s) = row { out.push(s); }
    }

    // Canonical mentions (split on commas, filter by prefix).
    let mut stmt = conn.prepare(
        "SELECT DISTINCT canonical_mentions FROM files
         WHERE deleted_at IS NULL AND canonical_mentions != ''",
    )?;
    let rows: Vec<String> = stmt.query_map([], |r| r.get::<_, String>(0))?
        .filter_map(Result::ok).collect();
    let mut mention_counts: std::collections::HashMap<String, i64> = Default::default();
    for row in rows {
        for token in row.split(',').map(str::trim).filter(|t| !t.is_empty()) {
            if token.to_lowercase().starts_with(&needle) {
                *mention_counts.entry(token.to_lowercase()).or_default() += 1;
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
    fn suggest_matches_people_cameras_and_mentions() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("t.sqlite");
        init_database(&db).unwrap();
        let root = upsert_root(&db, "D:\\P").unwrap();
        let conn = Connection::open(&db).unwrap();
        conn.execute(
            "INSERT INTO people (name, created_at, updated_at) VALUES ('Alice', 0, 0)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO files (root_id, rel_path, filename, abs_path, mtime_ns, size_bytes,
                                fingerprint, updated_at, camera_model, canonical_mentions)
             VALUES (?1, 'a.jpg', 'a.jpg', 'D:\\P\\a.jpg', 0, 0, 'fp1', 0, 'Alpha 7', 'Alice, Bob')",
            rusqlite::params![root],
        ).unwrap();
        drop(conn);

        let out = suggest(&db, "al", 10).unwrap();
        let labels: Vec<String> = out.iter().map(|s| s.label.clone()).collect();
        assert!(labels.iter().any(|l| l == "Alice"));
        assert!(labels.iter().any(|l| l == "Alpha 7"));
        assert!(labels.iter().any(|l| l == "alice"));
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
```

- [ ] **Step 2: Register + run tests**

In `lib.rs`: `mod autocomplete;` and `autocomplete::suggest_cmd,` in the handler list.

```
cargo test autocomplete --lib -- --test-threads=1
```

Expected: 2 tests pass.

- [ ] **Step 3: Commit**

```
git commit -am "feat(autocomplete): suggest people/cameras/lenses/mentions by prefix"
```

### Task 1.6: Wire `time:`/`camera:`/`lens:` into help modal and release note

**Files:**
- Modify: `sherlock/desktop/src/components/modals/HelpModal.tsx`
- Modify or create: `releases/v0.11.0.md`

- [ ] **Step 1: Add help entries**

Add new `<div className="help-section">` blocks to `HelpModal.tsx` after the existing "Media types" section:

```tsx
<div className="help-section">
  <h4>Camera / lens</h4>
  <div className="help-examples">
    <code>camera:"iPhone 14 Pro"</code>
    <code>lens:50mm</code>
  </div>
</div>
<div className="help-section">
  <h4>Time of day</h4>
  <div className="help-examples">
    <code>time:evening</code>
    <code>time:night</code>
  </div>
</div>
```

- [ ] **Step 2: Release note**

Create `releases/v0.11.0.md` with a summary of the Phase 1 deliverables.

- [ ] **Step 3: Commit**

```
git commit -am "docs: v0.11.0 release notes + help entries for new search tokens"
```

### Task 1.7: Backfill existing catalogs

**Files:**
- Modify: `sherlock/desktop/src-tauri/src/lib.rs` (startup hook)

- [ ] **Step 1: Add `backfill_exif_extras` migration hook**

Existing rows created before Migration 12 have empty `camera_model`/etc. Run a one-shot backfill after startup that re-extracts EXIF for files where `camera_model = ''` AND the file still exists. Limit to 200 files per startup batch to avoid stalls.

```rust
fn backfill_exif_extras(db_path: &Path) -> AppResult<()> {
    let conn = open_conn(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT id, abs_path FROM files
         WHERE deleted_at IS NULL AND camera_model = '' AND lens_model = ''
         ORDER BY id DESC LIMIT 200",
    )?;
    let rows: Vec<(i64, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .filter_map(Result::ok)
        .collect();
    for (id, path) in rows {
        if let Ok(meta) = crate::exif::extract_exif(std::path::Path::new(&path)) {
            conn.execute(
                "UPDATE files SET camera_model = ?1, lens_model = ?2, iso = ?3,
                                   shutter_speed = ?4, aperture = ?5, time_of_day = ?6
                 WHERE id = ?7",
                rusqlite::params![meta.camera_model, meta.lens_model, meta.iso,
                                  meta.shutter_speed, meta.aperture, meta.time_of_day, id],
            )?;
        }
    }
    Ok(())
}
```

Call it from `run()` in `lib.rs` after `recover_incomplete_scan_jobs`.

- [ ] **Step 2: Commit**

```
git commit -am "feat(exif): incremental backfill of camera/lens/time_of_day on startup"
```

---

## Phase 2 — Search builder & timeline

**Deliverables:** Chip-based search input + tag autocomplete + timeline density heatmap on the grid.

**Files:**
- Create: `sherlock/desktop/src/components/Search/ChipSearchBar.tsx`
- Create: `sherlock/desktop/src/components/Search/TagAutocomplete.tsx`
- Create: `sherlock/desktop/src/components/Content/TimelineHeatmap.tsx`
- Modify: `sherlock/desktop/src/App.tsx` (replace the existing search input wiring)
- Modify: `sherlock/desktop/src/hooks/useSearch.ts`

### Task 2.1: `ChipSearchBar`

Component UX: user types free text; pressing `:` exposes a popup menu listing available facets (media, camera, lens, time, person, date, subdir, album). Selecting one converts the pending token into a chip with a value input. Chips render to the left of the free-text input. Delete via `×` on chip or backspace on empty input.

- [ ] **2.1.1** Write the component test covering: typing free text, typing `media:photo`, deleting chips, serializing back to query string on submit.
- [ ] **2.1.2** Implement `ChipSearchBar.tsx` with `useReducer` for chip state, emits `onQueryChange(query: string)` parents bind to `useSearch`.
- [ ] **2.1.3** Style chips via new `ChipSearchBar.css` with monochrome pills + colored dot per facet kind.
- [ ] **2.1.4** Wire into App.tsx, replacing the plain `<input>` the current search uses.

### Task 2.2: `TagAutocomplete`

- [ ] **2.2.1** Dropdown component that binds to `suggest_cmd`. Debounced 150ms. Keyboard nav (↑/↓/Enter). Kind icon per suggestion (`person`/`camera`/`lens`/`mention`).
- [ ] **2.2.2** Integrate into `ChipSearchBar` so that while a chip value is being typed, the dropdown shows.
- [ ] **2.2.3** Tests: debounce behavior, keyboard nav, kind rendering.

### Task 2.3: `TimelineHeatmap`

- [ ] **2.3.1** Aggregate SQL: `SELECT strftime('%Y-%m', datetime(mtime_ns/1e9, 'unixepoch')) AS bucket, COUNT(*) FROM files WHERE deleted_at IS NULL GROUP BY bucket`. Expose as `list_timeline_buckets_cmd`.
- [ ] **2.3.2** Sidebar component renders a vertical bar (one row per month) with width ∝ count, color gradient. Clicking a month sets `from:/to:` on the query.
- [ ] **2.3.3** Test: correct month labels, click dispatches the right query.

### Task 2.4: Release + docs

- [ ] **2.4.1** `releases/v0.12.0.md` + CLAUDE.md entry for `ChipSearchBar`, `TagAutocomplete`, `TimelineHeatmap`, `autocomplete.rs`, `filters.rs`.

---

## Phase 3 — Auto-clustering

**Deliverables:** Six auto-organization wins that use existing EXIF + dHash + file size — zero new ML.

### Task 3.1: Event clusters (GPS + date window)

**Files:**
- Create: `sherlock/desktop/src-tauri/src/clustering.rs`
- Modify: `sherlock/desktop/src-tauri/src/db.rs` (new table `events`)

Approach: DBSCAN-lite on `(gps_lat, gps_lon, datetime)` with two ε (spatial 500m, temporal 6h). Every cluster becomes a row in a new `events` table with auto-generated name (`{city-from-location_text} — {date}` heuristic); user can rename.

**Tasks:**
- [ ] **3.1.1** Migration 13: `CREATE TABLE events (id INTEGER PK, name TEXT, started_at INTEGER, ended_at INTEGER, centroid_lat REAL, centroid_lon REAL, cover_file_id INTEGER)` + `event_files (event_id, file_id, UNIQUE)`.
- [ ] **3.1.2** `fn cluster_events(db_path) -> AppResult<Vec<EventSummary>>` runs DBSCAN-lite over files with non-null GPS + datetime. Idempotent: re-running merges into existing rows by centroid proximity, doesn't duplicate.
- [ ] **3.1.3** Tauri command `recompute_events_cmd`. Returns the number of events created/updated. Meant to run manually from a menu button or automatically after a scan.
- [ ] **3.1.4** Tests: 3 files within window → 1 event; 3 files split across 2 days → 2 events; GPS-less files ignored.

### Task 3.2: Trip detector

Similar to 3.1 but bigger scale. An "event" is a single photo session; a "trip" is a set of events outside the user's "home cluster" (defined as the highest-density 50 km² region). Add `trip_id` column to events.

- [ ] **3.2.1** Compute home cluster on demand (cheap SQL over events.centroid_lat/lon).
- [ ] **3.2.2** Events whose centroid is >50 km from home and within 7 days of a predecessor are merged into a trip.
- [ ] **3.2.3** `list_trips_cmd` returns `Vec<TripSummary { id, name_guess, started_at, ended_at, event_count, cover_file_id }>`.
- [ ] **3.2.4** UI: sidebar "Trips" section with collapsible list.

### Task 3.3: Burst collapse

- [ ] **3.3.1** `find_bursts(db_path)` detects groups of ≥3 files with same `camera_model` and mtime within 2s. Returns `Vec<Burst { cover_file_id, member_ids }>`.
- [ ] **3.3.2** UI: in the grid, bursts render as a single tile with "+N" badge; expanding shows the full burst inline.
- [ ] **3.3.3** Selection logic: selecting the cover selects the whole burst; user can "Keep cover, trash rest" in one click.

### Task 3.4: Blur detection

- [ ] **3.4.1** Migration 14: `ALTER TABLE files ADD COLUMN blur_score REAL`. Nullable.
- [ ] **3.4.2** During thumbnail generation, compute Laplacian variance via `imageproc::gradients::laplacian` on a 512px downscale. Store the variance. Low variance = blurry.
- [ ] **3.4.3** Add `blur:true` / `blur:false` query token and a "Hide blurry" toggle in the toolbar.
- [ ] **3.4.4** Tests: a crisp checkerboard yields high variance, a uniform blur yields low.

### Task 3.5: Year-in-review generator

- [ ] **3.5.1** `generate_year_review(db_path, year)` — picks top-12 photos (one per month where possible), prioritized by confidence × (1 + faces_count/5), excluding duplicates. Creates a new album named `Year in Review — {year}`.
- [ ] **3.5.2** Tauri command + a button in the Albums sidebar: "Generate year in review".
- [ ] **3.5.3** Tests: ensure one photo per month when the year is dense, gaps allowed when sparse.

### Task 3.6: Dedup policies

- [ ] **3.6.1** Migration 15: `CREATE TABLE dedup_policy (id INTEGER PK, strategy TEXT CHECK(strategy IN ('keep_largest','keep_oldest','keep_in_album')))`.
- [ ] **3.6.2** After each scan, if a policy is set, auto-apply it to newly discovered exact duplicates (soft-delete the losers). Keep a small audit trail.
- [ ] **3.6.3** UI: dropdown in the Duplicates view to set the active policy.
- [ ] **3.6.4** Tests: each strategy picks the right winner.

### Task 3.7: Release + docs

- [ ] **3.7.1** `releases/v0.13.0.md` + CLAUDE.md entries.

---

## Phase 4 — Map, color, content

### Task 4.1: Color palette search

- [ ] **4.1.1** Migration 16: `ALTER TABLE files ADD COLUMN dominant_color INTEGER` (packed `0xRRGGBB`).
- [ ] **4.1.2** During thumbnail gen, k-means (k=3) on a 64×64 downscale of each image; store the cluster with the largest weight. Use `imageproc::region_labelling` or a hand-rolled 3-centroid Lloyd iteration (50 iters max).
- [ ] **4.1.3** Query token: `color:orange` / `color:green` with a name → HSV-range table (~12 named colors).
- [ ] **4.1.4** UI: color-swatch row in the toolbar; click swatches to add the token.

### Task 4.2: Offline map view

- [ ] **4.2.1** Add `maplibre-gl` (MIT) to the frontend. Store tiles in `<base_dir>/cache/osm_tiles/`. First-fetch downloads tiles around viewed photos on demand.
- [ ] **4.2.2** New view mode `MapView` (parallel to `DuplicatesView`/`FacesView`) that renders pins for every file with GPS. Clustering at zoom-out; on click, pans to the photo grid filtered to that region.
- [ ] **4.2.3** Respect user's tile-download budget (default: only download tiles for regions with ≥5 photos). Offline-first: if a tile isn't cached and we're offline, show a gray tile.

### Task 4.3: "Nearby" on a selected photo

- [ ] **4.3.1** Right-click a photo with GPS → "Find nearby" → runs `SELECT WHERE gps_lat BETWEEN ?-delta AND ?+delta AND gps_lon BETWEEN ... ORDER BY haversine(...) LIMIT 50`.
- [ ] **4.3.2** Results open in a grid, same UI surface the existing search uses.
- [ ] **4.3.3** Context menu entry added only when the file has GPS (extend the existing menu logic in `ContextMenu.tsx`).

### Task 4.4: QR/barcode decode

- [ ] **4.4.1** Add `rqrr` (MIT) to Cargo deps.
- [ ] **4.4.2** Migration 17: `ALTER TABLE files ADD COLUMN qr_codes TEXT NOT NULL DEFAULT ''` (comma-joined decoded payloads).
- [ ] **4.4.3** During classification (optional stage, after OCR), run QR decoder on the full-res image; save decoded strings. Make this part of the FTS index so the user can `qr:wifi` or free-text-search for `"MECARD:"`.
- [ ] **4.4.4** UI: properties panel shows QR decoded text with a "Copy" button.

### Task 4.5: Release + docs

- [ ] **4.5.1** `releases/v0.14.0.md` + CLAUDE.md entry for `clustering.rs`, `MapView`, QR pipeline.

---

## Phase 5 — Auto-tagging & smart albums

### Task 5.1: Path-pattern auto-tag rules

- [ ] **5.1.1** Migration 18: `CREATE TABLE tag_rules (id, pattern TEXT, tag TEXT, enabled INTEGER)`.
- [ ] **5.1.2** At scan time, for each new file compute `rel_path`; for each enabled rule, compiled-regex match yields a tag stored in `canonical_mentions`.
- [ ] **5.1.3** UI: simple rule editor modal — list + add/edit/delete — with live preview of which files match.

### Task 5.2: Face smart albums

- [ ] **5.2.1** Reuse existing `smart_folders` table. Extend with `SELECT ... FROM files JOIN face_detections ON file_id = files.id JOIN people ON person_id = people.id WHERE people.name = ?`.
- [ ] **5.2.2** From the Faces view, right-click a person → "Create smart album". Persists a new smart folder scoped to that person.

### Task 5.3: Album tag inheritance

- [ ] **5.3.1** Migration 19: `ALTER TABLE albums ADD COLUMN tag TEXT NOT NULL DEFAULT ''` (optional freeform tag applied to all member files on insert).
- [ ] **5.3.2** When a file is added to an album with a tag, append the tag to the file's `canonical_mentions` (deduped, no-op if already present).
- [ ] **5.3.3** UI: album-edit modal adds a "Tag" field.

### Task 5.4: Selfie/group classifier

- [ ] **5.4.1** Derive at query time: `face_count == 0` → "landscape", `face_count == 1 AND face_bbox_area/img_area > 0.15` → "selfie", `face_count >= 3` → "group". Materialize into a `shot_kind` column (Migration 20) so searches are O(1).
- [ ] **5.4.2** Query token `shot:selfie` / `shot:group` / `shot:landscape`.
- [ ] **5.4.3** Backfill on startup (same pattern as Task 1.7).

### Task 5.5: Release + docs

- [ ] **5.5.1** `releases/v0.15.0.md` + CLAUDE.md entries.

---

## Phase 6 — Ambient surfaces

### Task 6.1: Saved-search alerts

- [ ] **6.1.1** Migration 21: `CREATE TABLE saved_searches (id, name, query TEXT, notify INTEGER, last_match_id INTEGER, last_checked_at INTEGER)`.
- [ ] **6.1.2** Scheduled background task: every 15 minutes, for each `notify=1` saved search with a non-empty query, run the search and if new matches exist since `last_match_id`, emit a desktop notification via `@tauri-apps/plugin-notification`.
- [ ] **6.1.3** UI: "Save" button in the search bar; "Saved searches" section in sidebar with bell icon to toggle notify.

### Task 6.2: Ambient similar sidebar

- [ ] **6.2.1** When the preview modal is open on a single file, a right-rail panel calls `find_similar_cmd(file_id, 5, 0.7)` and renders 5 thumbnails of high-confidence matches. Clicking swaps the preview to that file.
- [ ] **6.2.2** Debounced 300ms so rapid preview navigation doesn't storm the backend.
- [ ] **6.2.3** Tests: preview opens → sidebar populated; navigate → sidebar repopulated.

### Task 6.3: Release + docs

- [ ] **6.3.1** `releases/v0.16.0.md` + final CLAUDE.md entries. Update the "Key Rust Modules" table with every module created in this roadmap.

---

## Post-roadmap checklist

- [ ] All 21 features deliver user-visible UX (no "command exists but nothing uses it").
- [ ] Every migration safe on existing catalogs (idempotent `ALTER TABLE ... DEFAULT ...`).
- [ ] `cargo test` + `npm run test` green at the end of every phase.
- [ ] Each phase ships a `releases/vX.Y.Z.md` note and updates CLAUDE.md.
- [ ] Manual smoke after Phase 3: scan a pre-classified folder, confirm events + trips detected, burst collapsed, blurry marked, year-in-review generated.
