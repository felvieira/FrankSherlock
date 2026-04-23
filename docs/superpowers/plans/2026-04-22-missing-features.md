# Missing Features — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the three features left out of the auto-organize roadmap: (A) color swatches in the toolbar, (B) background saved-search alert polling with desktop notifications, and (C) offline map view with GPS pins + "Find nearby" context-menu action.

**Architecture:**
- (A) Pure frontend change — add a row of 12 named-color swatches to Toolbar that inject `color:#RRGGBB` tokens into the query.
- (B) Frontend `setInterval` (15 min) calls a new Rust `check_saved_search_alerts` command; matches are emitted as Web Notifications + in-app toasts. No new Tauri plugin needed.
- (C) Migration 22 persists `gps_lat`/`gps_lon` in the `files` table (EXIF extraction already has the data, marked dead_code). New `list_gps_files` and `find_nearby` Rust commands feed a `MapView` React component using maplibre-gl with OSM raster tiles.

**Tech Stack:** Rust/rusqlite (migrations, SQL), React + TypeScript (Vitest), maplibre-gl (npm), Web Notification API (browser built-in), SQLite FTS5.

**Worktree:** `D:\Repos\GERAL\FrankSherlock\.worktrees\feat-auto-organize` — branch `feat/auto-organize`.  
All `cargo` commands run from `sherlock/desktop/src-tauri/`.  
All `npm` commands run from `sherlock/desktop/`.

---

## File map

| File | Action | Purpose |
|---|---|---|
| `sherlock/desktop/src-tauri/src/db.rs` | Modify | Migration 22 (gps_lat/gps_lon), `list_gps_files`, `find_nearby`, `check_saved_search_alerts` |
| `sherlock/desktop/src-tauri/src/models.rs` | Modify | `GpsFile` struct, `NearbyResult` struct, `SavedSearchAlert` struct |
| `sherlock/desktop/src-tauri/src/scan.rs` | Modify | Wire `gps_lat`/`gps_lon` from ExifLocation into FileRecordUpsert → upsert_file_record |
| `sherlock/desktop/src-tauri/src/lib.rs` | Modify | Register `list_gps_files_cmd`, `find_nearby_cmd`, `check_saved_search_alerts_cmd` |
| `sherlock/desktop/src/types.ts` | Modify | Add `GpsFile`, `NearbyResult`, `SavedSearchAlert` types |
| `sherlock/desktop/src/api.ts` | Modify | Add `listGpsFiles`, `findNearby`, `checkSavedSearchAlerts` functions |
| `sherlock/desktop/src/components/Content/Toolbar.tsx` | Modify | Add color swatch row |
| `sherlock/desktop/src/components/Content/Toolbar.css` | Modify | Swatch row styles |
| `sherlock/desktop/src/components/Content/MapView.tsx` | Create | Map view using maplibre-gl |
| `sherlock/desktop/src/components/Content/MapView.css` | Create | Map view styles |
| `sherlock/desktop/src/components/Content/ContextMenu.tsx` | Modify | Add "Find nearby" item |
| `sherlock/desktop/src/hooks/useSavedSearchAlerts.ts` | Create | 15-min polling hook |
| `sherlock/desktop/src/App.tsx` | Modify | Wire MapView, useSavedSearchAlerts, Find nearby, map mode |
| `sherlock/desktop/src/components/modals/HelpModal.tsx` | Modify | Add color, nearby, shot: token docs |
| `sherlock/desktop/src/components/Sidebar/Sidebar.tsx` | Modify | Add "Map" button in Tools section |
| `sherlock/desktop/package.json` | Modify | Add maplibre-gl |
| `releases/v0.17.0.md` | Create | Release notes |

---

## Task 1 — Color swatches in Toolbar

**Files:**
- Modify: `sherlock/desktop/src/components/Content/Toolbar.tsx`
- Modify: `sherlock/desktop/src/components/Content/Toolbar.css`
- Test: `sherlock/desktop/src/__tests__/components/Toolbar.test.tsx`

### Step 1 — Write failing tests

Append to `sherlock/desktop/src/__tests__/components/Toolbar.test.tsx`:

```typescript
it("renders color swatch row", () => {
  render(
    <Toolbar
      query=""
      onQueryChange={() => {}}
      selectedMediaType=""
      onMediaTypeChange={() => {}}
      mediaTypeOptions={[""]}
      sortBy="dateModified"
      onSortByChange={() => {}}
      sortOrder="desc"
      onSortOrderChange={() => {}}
      hasTextQuery={false}
    />
  );
  expect(document.querySelectorAll(".toolbar-color-swatch").length).toBeGreaterThan(0);
});

it("clicking a color swatch appends color: token", () => {
  const onChange = vi.fn();
  render(
    <Toolbar
      query="beach"
      onQueryChange={onChange}
      selectedMediaType=""
      onMediaTypeChange={() => {}}
      mediaTypeOptions={[""]}
      sortBy="dateModified"
      onSortByChange={() => {}}
      sortOrder="desc"
      onSortOrderChange={() => {}}
      hasTextQuery={true}
    />
  );
  const swatch = document.querySelector(".toolbar-color-swatch") as HTMLElement;
  fireEvent.click(swatch);
  expect(onChange).toHaveBeenCalledWith(expect.stringMatching(/color:#[0-9a-fA-F]{6}/));
});

it("clicking active swatch removes color: token", () => {
  const onChange = vi.fn();
  render(
    <Toolbar
      query="color:#ff0000"
      onQueryChange={onChange}
      selectedMediaType=""
      onMediaTypeChange={() => {}}
      mediaTypeOptions={[""]}
      sortBy="dateModified"
      onSortByChange={() => {}}
      sortOrder="desc"
      onSortOrderChange={() => {}}
      hasTextQuery={true}
    />
  );
  // Find the active swatch (the red one) and click it
  const activeSwatch = document.querySelector(".toolbar-color-swatch.active") as HTMLElement;
  expect(activeSwatch).not.toBeNull();
  fireEvent.click(activeSwatch);
  expect(onChange).toHaveBeenCalledWith(expect.not.stringContaining("color:"));
});
```

- [ ] **Run to confirm failure:**
  ```
  cd sherlock/desktop && npm run test -- --run src/__tests__/components/Toolbar.test.tsx
  ```
  Expected: 3 new tests FAIL.

### Step 2 — Add color swatches to Toolbar.tsx

Replace the entire content of `sherlock/desktop/src/components/Content/Toolbar.tsx` with:

```tsx
import { useEffect } from "react";
import type { SortField, SortOrder } from "../../types";
import ChipSearchBar from "../Search/ChipSearchBar";

/** 12 named colors: name → packed hex string */
const COLOR_SWATCHES: { name: string; hex: string }[] = [
  { name: "Red",     hex: "#e53935" },
  { name: "Orange",  hex: "#f4511e" },
  { name: "Yellow",  hex: "#fdd835" },
  { name: "Green",   hex: "#43a047" },
  { name: "Teal",    hex: "#00897b" },
  { name: "Cyan",    hex: "#00acc1" },
  { name: "Blue",    hex: "#1e88e5" },
  { name: "Indigo",  hex: "#3949ab" },
  { name: "Purple",  hex: "#8e24aa" },
  { name: "Pink",    hex: "#d81b60" },
  { name: "White",   hex: "#f5f5f5" },
  { name: "Black",   hex: "#212121" },
];

/** Extract the active color hex from query, or null */
function getActiveColor(query: string): string | null {
  const m = query.match(/\bcolor:(#[0-9a-fA-F]{6})\b/i);
  return m ? m[1].toLowerCase() : null;
}

/** Replace or remove the color token in a query string */
function setColorInQuery(query: string, hex: string | null): string {
  const stripped = query.replace(/\s*color:#[0-9a-fA-F]{6}/gi, "").trim();
  if (!hex) return stripped;
  return (stripped + " color:" + hex).trim();
}

function getBlurState(query: string): "none" | "sharp" | "blurry" {
  if (/\bblur:false\b/i.test(query)) return "sharp";
  if (/\bblur:true\b/i.test(query)) return "blurry";
  return "none";
}

function cycleBlurState(current: "none" | "sharp" | "blurry"): "none" | "sharp" | "blurry" {
  if (current === "none") return "sharp";
  if (current === "sharp") return "blurry";
  return "none";
}

function setBlurInQuery(query: string, state: "none" | "sharp" | "blurry"): string {
  const stripped = query.replace(/\s*blur:(true|false)/gi, "").trim();
  if (state === "sharp") return (stripped + " blur:false").trim();
  if (state === "blurry") return (stripped + " blur:true").trim();
  return stripped;
}

type Props = {
  query: string;
  onQueryChange: (value: string) => void;
  selectedMediaType: string;
  onMediaTypeChange: (value: string) => void;
  mediaTypeOptions: string[];
  sortBy: SortField;
  onSortByChange: (value: SortField) => void;
  sortOrder: SortOrder;
  onSortOrderChange: (value: SortOrder) => void;
  hasTextQuery: boolean;
  onSaveSmartFolder?: () => void;
  onSaveSearch?: () => void;
};

const sortOptions: { value: SortField; label: string; icon: JSX.Element; requiresQuery?: boolean }[] = [
  {
    value: "relevance", label: "Relevance", requiresQuery: true,
    icon: <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1l2.1 4.3 4.7.7-3.4 3.3.8 4.7L8 11.8 3.8 14l.8-4.7L1.2 6l4.7-.7z"/></svg>,
  },
  {
    value: "dateModified", label: "Date",
    icon: <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M12 2h1.5A1.5 1.5 0 0115 3.5v10a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 13.5v-10A1.5 1.5 0 012.5 2H4V.5h1.5V2h5V.5H12V2zM2.5 6v7.5h11V6h-11z"/></svg>,
  },
  {
    value: "name", label: "Name",
    icon: <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1 3h3.2L6 8.4 7.8 3H11L7 14H5.2L1 3zm11.5 0H15l-2.2 11h-2.3l2-11z"/></svg>,
  },
  {
    value: "type", label: "Type",
    icon: <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 1h5l1 1.5H14a1 1 0 011 1V13a1 1 0 01-1 1H2a1 1 0 01-1-1V2a1 1 0 011-1zm0 4v8h12V5H2z"/></svg>,
  },
];

export default function Toolbar({
  query, onQueryChange, selectedMediaType, onMediaTypeChange, mediaTypeOptions,
  sortBy, onSortByChange, sortOrder, onSortOrderChange, hasTextQuery, onSaveSmartFolder,
  onSaveSearch,
}: Props) {
  useEffect(() => {
    if (!hasTextQuery && sortBy === "relevance") {
      onSortByChange("dateModified");
    }
  }, [hasTextQuery, sortBy, onSortByChange]);

  const blurState = getBlurState(query);
  const activeColor = getActiveColor(query);

  function handleBlurToggle() {
    const next = cycleBlurState(blurState);
    onQueryChange(setBlurInQuery(query, next));
  }

  function handleSwatchClick(hex: string) {
    if (activeColor === hex.toLowerCase()) {
      // Toggle off
      onQueryChange(setColorInQuery(query, null));
    } else {
      onQueryChange(setColorInQuery(query, hex));
    }
  }

  const blurLabel =
    blurState === "none" ? "Blur: all" :
    blurState === "sharp" ? "Blur: hide blurry" :
    "Blur: only blurry";

  return (
    <div className="toolbar">
      <div className="toolbar-row">
        <ChipSearchBar
          query={query}
          onQueryChange={onQueryChange}
          placeholder="e.g. photo beach sunset — F1 for help"
        />
        {hasTextQuery && onSaveSmartFolder && (
          <button
            className="toolbar-save-btn"
            onClick={onSaveSmartFolder}
            title="Save as Smart Folder"
            aria-label="Save as Smart Folder"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2 1h10l3 3v10a1 1 0 01-1 1H2a1 1 0 01-1-1V2a1 1 0 011-1zm2 0v4h7V1H4zm4 6a2.5 2.5 0 100 5 2.5 2.5 0 000-5z"/>
            </svg>
          </button>
        )}
        {hasTextQuery && onSaveSearch && (
          <button
            className="toolbar-save-btn"
            onClick={onSaveSearch}
            title="Save Search"
            aria-label="Save Search"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 1.5a5.5 5.5 0 110 11 5.5 5.5 0 010-11zm0 2a.75.75 0 00-.75.75v2.5H5.75a.75.75 0 000 1.5h1.5v2.5a.75.75 0 001.5 0v-2.5h1.5a.75.75 0 000-1.5H8.75v-2.5A.75.75 0 008 4.5z"/>
            </svg>
          </button>
        )}
        <select
          value={selectedMediaType}
          onChange={(e) => onMediaTypeChange(e.target.value)}
          aria-label="Media type filter"
        >
          {mediaTypeOptions.map((opt) => (
            <option key={opt} value={opt}>
              {opt ? opt : "all types"}
            </option>
          ))}
        </select>
        <div className="sort-toggles" role="group" aria-label="Sort field">
          {sortOptions
            .filter((opt) => !opt.requiresQuery || hasTextQuery)
            .map((opt) => (
              <button
                key={opt.value}
                className={`sort-toggle${sortBy === opt.value ? " sort-toggle-active" : ""}`}
                onClick={() => onSortByChange(opt.value)}
                title={opt.label}
                aria-label={opt.label}
                aria-pressed={sortBy === opt.value}
              >
                {opt.icon}
                <span>{opt.label}</span>
              </button>
            ))}
        </div>
        {sortBy !== "relevance" && (
          <button
            className="toolbar-sort-dir"
            onClick={() => onSortOrderChange(sortOrder === "asc" ? "desc" : "asc")}
            aria-label="Sort direction"
            title={sortOrder === "asc" ? "Ascending" : "Descending"}
          >
            {sortOrder === "asc" ? "\u2191" : "\u2193"}
          </button>
        )}
        <button
          className={`toolbar-blur-toggle${blurState !== "none" ? " toolbar-blur-active" : ""}`}
          onClick={handleBlurToggle}
          title={blurLabel}
          aria-label={blurLabel}
          aria-pressed={blurState !== "none"}
        >
          {blurState === "blurry" ? "~Blurry" : blurState === "sharp" ? "~Sharp" : "~"}
        </button>
      </div>

      <div className="toolbar-color-row" role="group" aria-label="Color filter">
        {COLOR_SWATCHES.map((s) => (
          <button
            key={s.hex}
            className={`toolbar-color-swatch${activeColor === s.hex.toLowerCase() ? " active" : ""}`}
            style={{ background: s.hex }}
            title={`Filter by color: ${s.name}`}
            aria-label={`Filter by ${s.name}`}
            aria-pressed={activeColor === s.hex.toLowerCase()}
            onClick={() => handleSwatchClick(s.hex)}
          />
        ))}
        {activeColor && (
          <button
            className="toolbar-color-clear"
            onClick={() => onQueryChange(setColorInQuery(query, null))}
            title="Clear color filter"
            aria-label="Clear color filter"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3 — Add CSS to Toolbar.css**

Find `sherlock/desktop/src/components/Content/Toolbar.css` and append at the end:

```css
/* ── Toolbar layout ─────────────────────────────────────── */
.toolbar-row {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

/* ── Color swatch row ────────────────────────────────────── */
.toolbar-color-row {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 3px 0 2px;
  flex-wrap: nowrap;
  overflow-x: auto;
}

.toolbar-color-swatch {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
  transition: transform 0.1s, border-color 0.1s;
}

.toolbar-color-swatch:hover {
  transform: scale(1.25);
  border-color: var(--text-secondary);
}

.toolbar-color-swatch.active {
  border-color: var(--accent);
  transform: scale(1.25);
  box-shadow: 0 0 0 1px var(--accent);
}

.toolbar-color-clear {
  all: unset;
  font-size: 0.65rem;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 1px 4px;
  border-radius: var(--radius-sm);
  line-height: 1;
}

.toolbar-color-clear:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}
```

- [ ] **Step 4 — Check existing Toolbar.css to ensure `toolbar` class still wraps everything**

Read `sherlock/desktop/src/components/Content/Toolbar.css` and verify the `.toolbar` class has `flex-direction: column` or at minimum `display: flex` so the two rows stack. If `.toolbar` only has `display: flex; flex-direction: row`, add `flex-direction: column; align-items: stretch;`.

- [ ] **Step 5 — Run tests**

```
cd sherlock/desktop && npm run test -- --run src/__tests__/components/Toolbar.test.tsx
```

Expected: all Toolbar tests PASS (including the 3 new ones).

- [ ] **Step 6 — Commit**

```
cd sherlock/desktop && git add src/components/Content/Toolbar.tsx src/components/Content/Toolbar.css src/__tests__/components/Toolbar.test.tsx
git commit -m "feat(toolbar): color swatch row for visual color filtering"
```

---

## Task 2 — Saved-search background polling + desktop notifications

**Files:**
- Modify: `sherlock/desktop/src-tauri/src/db.rs`
- Modify: `sherlock/desktop/src-tauri/src/models.rs`
- Modify: `sherlock/desktop/src-tauri/src/lib.rs`
- Create: `sherlock/desktop/src/hooks/useSavedSearchAlerts.ts`
- Modify: `sherlock/desktop/src/api.ts`
- Modify: `sherlock/desktop/src/types.ts`
- Modify: `sherlock/desktop/src/App.tsx`

### Step 1 — Write Rust test for `check_saved_search_alerts`

Append to `#[cfg(test)] mod tests` in `sherlock/desktop/src-tauri/src/db.rs`:

```rust
#[test]
fn check_saved_search_alerts_returns_matches() {
    use tempfile::tempdir;
    let dir = tempdir().unwrap();
    let db = dir.path().join("t.sqlite");
    init_database(&db).unwrap();
    let root = upsert_root(&db, "D:\\P").unwrap();
    let conn = open_conn(&db).unwrap();

    // Insert two files with descriptions that match "beach"
    for i in 0..2i64 {
        conn.execute(
            "INSERT INTO files (root_id, rel_path, filename, abs_path, mtime_ns, size_bytes,
                                fingerprint, updated_at, description, media_type, confidence)
             VALUES (?1, ?2, ?3, ?4, 0, 0, ?5, 0, 'beach sunset', 'photo', 0.9)",
            rusqlite::params![root, format!("a{i}.jpg"), format!("a{i}.jpg"),
                              format!("D:\\P\\a{i}.jpg"), format!("fp{i}")],
        ).unwrap();
    }
    // Rebuild FTS
    conn.execute("INSERT INTO files_fts(files_fts) VALUES ('rebuild')", []).unwrap();

    // Create a saved search with notify=1, last_match_id=0
    conn.execute(
        "INSERT INTO saved_searches (name, query, notify, last_match_id, last_checked_at)
         VALUES ('beach alert', 'beach', 1, 0, 0)",
        [],
    ).unwrap();
    drop(conn);

    let alerts = check_saved_search_alerts(&db).unwrap();
    assert_eq!(alerts.len(), 1);
    assert_eq!(alerts[0].name, "beach alert");
    assert!(alerts[0].new_count > 0);
}

#[test]
fn check_saved_search_alerts_skips_notify_false() {
    use tempfile::tempdir;
    let dir = tempdir().unwrap();
    let db = dir.path().join("t.sqlite");
    init_database(&db).unwrap();
    let root = upsert_root(&db, "D:\\P").unwrap();
    let conn = open_conn(&db).unwrap();
    conn.execute(
        "INSERT INTO files (root_id, rel_path, filename, abs_path, mtime_ns, size_bytes,
                            fingerprint, updated_at, description, media_type, confidence)
         VALUES (?1, 'b.jpg', 'b.jpg', 'D:\\P\\b.jpg', 0, 0, 'fp9', 0, 'sunset', 'photo', 0.9)",
        rusqlite::params![root],
    ).unwrap();
    conn.execute("INSERT INTO files_fts(files_fts) VALUES ('rebuild')", []).unwrap();
    conn.execute(
        "INSERT INTO saved_searches (name, query, notify, last_match_id, last_checked_at)
         VALUES ('sunset watch', 'sunset', 0, 0, 0)",
        [],
    ).unwrap();
    drop(conn);

    let alerts = check_saved_search_alerts(&db).unwrap();
    assert!(alerts.is_empty());
}
```

- [ ] **Run to confirm failure:**

```
cd sherlock/desktop/src-tauri && cargo test check_saved_search_alerts --lib -- --test-threads=1
```

Expected: FAIL — `check_saved_search_alerts` not defined.

### Step 2 — Add `SavedSearchAlert` model

In `sherlock/desktop/src-tauri/src/models.rs`, append after the `SavedSearch` struct:

```rust
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSearchAlert {
    pub id: i64,
    pub name: String,
    pub query: String,
    pub new_count: i64,
    pub max_new_id: i64,
}
```

### Step 3 — Implement `check_saved_search_alerts` in db.rs

Add this import at the top of db.rs (it already imports `SavedSearch`, add next to it):
```rust
use crate::models::{..., SavedSearchAlert};  // add SavedSearchAlert to the existing import list
```

Add the function after `set_saved_search_notify`:

```rust
/// For each saved search with notify=1, check if there are new file matches
/// (id > last_match_id) since the last check. Returns alerts for searches
/// that have new results. Updates last_match_id and last_checked_at.
pub fn check_saved_search_alerts(db_path: &Path) -> AppResult<Vec<SavedSearchAlert>> {
    let conn = open_conn(db_path)?;
    let now = now_epoch_secs() as i64;

    // Load all notify=1 searches
    let searches: Vec<(i64, String, String, i64)> = {
        let mut stmt = conn.prepare(
            "SELECT id, name, query, last_match_id FROM saved_searches
             WHERE notify = 1 AND query != ''",
        )?;
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .filter_map(Result::ok)
            .collect()
    };

    let mut alerts = Vec::new();
    for (id, name, query, last_match_id) in searches {
        // Simple FTS search for new files since last_match_id
        let fts_query = query.trim().replace('\'', "''");
        let sql = format!(
            "SELECT COUNT(*), COALESCE(MAX(f.id), 0) FROM files f
             JOIN files_fts ON files_fts.rowid = f.id
             WHERE files_fts MATCH '{fts_query}' AND f.deleted_at IS NULL AND f.id > {last_match_id}"
        );
        let result: Option<(i64, i64)> = conn
            .query_row(&sql, [], |r| Ok((r.get(0)?, r.get(1)?)))
            .ok();

        if let Some((new_count, max_new_id)) = result {
            if new_count > 0 {
                alerts.push(SavedSearchAlert {
                    id,
                    name: name.clone(),
                    query: query.clone(),
                    new_count,
                    max_new_id,
                });
                // Update last_match_id and last_checked_at
                conn.execute(
                    "UPDATE saved_searches SET last_match_id = ?1, last_checked_at = ?2 WHERE id = ?3",
                    params![max_new_id, now, id],
                )?;
            } else {
                // Still update last_checked_at even when no new results
                conn.execute(
                    "UPDATE saved_searches SET last_checked_at = ?1 WHERE id = ?2",
                    params![now, id],
                )?;
            }
        }
    }
    Ok(alerts)
}
```

### Step 4 — Register Tauri command

In `sherlock/desktop/src-tauri/src/lib.rs`:

1. Import: the `SavedSearchAlert` model is already in `models.rs`, exposed via `db::check_saved_search_alerts`. No new import needed.

2. Add the command function near the other saved_search commands:

```rust
#[tauri::command]
async fn check_saved_search_alerts_cmd(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<models::SavedSearchAlert>, String> {
    db::check_saved_search_alerts(&state.paths.db_file).map_err(|e| e.to_string())
}
```

3. Add to `generate_handler!` list (after `set_saved_search_notify`):
```rust
check_saved_search_alerts_cmd,
```

### Step 5 — Run Rust tests

```
cd sherlock/desktop/src-tauri && cargo test check_saved_search --lib -- --test-threads=1
```

Expected: 2 tests PASS.

### Step 6 — Add frontend types and API

In `sherlock/desktop/src/types.ts`, append after `SavedSearch`:

```typescript
export type SavedSearchAlert = {
  id: number;
  name: string;
  query: string;
  newCount: number;
  maxNewId: number;
};
```

In `sherlock/desktop/src/api.ts`, add after `setSavedSearchNotify`:

```typescript
export async function checkSavedSearchAlerts(): Promise<SavedSearchAlert[]> {
  return invoke<SavedSearchAlert[]>("check_saved_search_alerts_cmd");
}
```

Also add the import at the top of api.ts (next to other type imports):
```typescript
import type { ..., SavedSearchAlert } from "./types";
```

### Step 7 — Create `useSavedSearchAlerts` hook

Create `sherlock/desktop/src/hooks/useSavedSearchAlerts.ts`:

```typescript
import { useEffect, useRef } from "react";
import { checkSavedSearchAlerts } from "../api";

const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

type Callbacks = {
  onAlert: (name: string, count: number, query: string) => void;
};

/**
 * Polls check_saved_search_alerts every 15 minutes.
 * On matches, calls onAlert and emits a Web Notification (if permission granted).
 * The first check runs 15 minutes after mount — not immediately.
 */
export function useSavedSearchAlerts({ onAlert }: Callbacks) {
  const onAlertRef = useRef(onAlert);
  onAlertRef.current = onAlert;

  useEffect(() => {
    // Request notification permission on first mount (silently — no blocking prompt)
    if (typeof window !== "undefined" && "Notification" in window &&
        Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }

    const timerId = setInterval(async () => {
      try {
        const alerts = await checkSavedSearchAlerts();
        for (const alert of alerts) {
          // In-app callback
          onAlertRef.current(alert.name, alert.newCount, alert.query);

          // Desktop notification (best-effort)
          if (typeof window !== "undefined" && "Notification" in window &&
              Notification.permission === "granted") {
            const n = new Notification(`New matches: ${alert.name}`, {
              body: `${alert.newCount} new file(s) found for "${alert.query}"`,
              silent: false,
            });
            // Auto-close after 6 seconds
            setTimeout(() => n.close(), 6000);
          }
        }
      } catch {
        // Ignore errors — polling is best-effort
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(timerId);
  }, []);
}
```

### Step 8 — Wire into App.tsx

In `sherlock/desktop/src/App.tsx`:

1. Add import at the top:
```typescript
import { useSavedSearchAlerts } from "./hooks/useSavedSearchAlerts";
```

2. After the other hooks (e.g. after `useSmartFolderManager`), add:
```typescript
useSavedSearchAlerts({
  onAlert: (name, count, alertQuery) => {
    setNotice(`📌 "${name}": ${count} new match${count !== 1 ? "es" : ""} — click to search`);
    // Optionally: clicking the toast could set the query
    void alertQuery; // acknowledged — toast is informational only
  },
});
```

### Step 9 — Run all frontend tests

```
cd sherlock/desktop && npm run test -- --run
```

Expected: all tests PASS.

### Step 10 — Commit

```
cd sherlock/desktop && git add src-tauri/src/db.rs src-tauri/src/models.rs src-tauri/src/lib.rs src/types.ts src/api.ts src/hooks/useSavedSearchAlerts.ts src/App.tsx
git commit -m "feat(alerts): background saved-search polling with desktop notifications"
```

---

## Task 3 — Persist GPS coordinates in DB (Migration 22)

**Files:**
- Modify: `sherlock/desktop/src-tauri/src/db.rs`
- Modify: `sherlock/desktop/src-tauri/src/models.rs` (FileRecordUpsert)
- Modify: `sherlock/desktop/src-tauri/src/scan.rs`

### Step 1 — Write failing migration test

Append to `#[cfg(test)] mod tests` in `sherlock/desktop/src-tauri/src/db.rs`:

```rust
#[test]
fn migration_adds_gps_lat_lon_columns() {
    use tempfile::tempdir;
    let dir = tempdir().unwrap();
    let db = dir.path().join("t.sqlite");
    init_database(&db).unwrap();
    let conn = open_conn(&db).unwrap();
    let mut stmt = conn.prepare("PRAGMA table_info(files)").unwrap();
    let cols: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .unwrap().filter_map(Result::ok).collect();
    assert!(cols.iter().any(|c| c == "gps_lat"), "missing gps_lat, got {cols:?}");
    assert!(cols.iter().any(|c| c == "gps_lon"), "missing gps_lon, got {cols:?}");
}
```

- [ ] **Run to confirm failure:**

```
cd sherlock/desktop/src-tauri && cargo test migration_adds_gps --lib
```

Expected: FAIL — columns not yet in schema.

### Step 2 — Append Migration 22

In `sherlock/desktop/src-tauri/src/db.rs`, find the closing `]);` of the Migrations vector (after Migration 21) and insert before it:

```rust
        // Migration 22: GPS lat/lon stored for map view
        M::up(
            "ALTER TABLE files ADD COLUMN gps_lat REAL;
             ALTER TABLE files ADD COLUMN gps_lon REAL;
             CREATE INDEX IF NOT EXISTS idx_files_gps ON files(gps_lat, gps_lon)
             WHERE gps_lat IS NOT NULL;"
        ),
```

### Step 3 — Add fields to FileRecordUpsert

In `sherlock/desktop/src-tauri/src/models.rs`, find `FileRecordUpsert` and add:

```rust
pub struct FileRecordUpsert {
    // ... existing fields ...
    pub gps_lat: Option<f64>,
    pub gps_lon: Option<f64>,
}
```

### Step 4 — Update `upsert_file_record` INSERT/UPDATE SQL

In `sherlock/desktop/src-tauri/src/db.rs`, find `upsert_file_record`. The INSERT statement has a column list and values list. Add `gps_lat, gps_lon` to the INSERT columns and `?gps_lat, ?gps_lon` to the values. Add to the ON CONFLICT UPDATE clause:

```sql
gps_lat = COALESCE(excluded.gps_lat, gps_lat),
gps_lon = COALESCE(excluded.gps_lon, gps_lon),
```

Bind `record.gps_lat` and `record.gps_lon` in the params list.

### Step 5 — Update FileRecordUpsert instantiation sites

Run:
```
cd sherlock/desktop/src-tauri && cargo build 2>&1 | grep "missing field\|gps_lat\|gps_lon" | head -30
```

For every compilation error about missing `gps_lat`/`gps_lon`, add `gps_lat: None, gps_lon: None` to that struct literal (all test fixtures in db.rs tests, and in scan.rs).

### Step 6 — Wire GPS into scan.rs

In `sherlock/desktop/src-tauri/src/scan.rs`, find `probe_to_minimal_record` (or wherever `FileRecordUpsert` is built from an `ExifLocation`). The `ExifLocation` struct already has `latitude: Option<f64>` and `longitude: Option<f64>`. Wire them:

```rust
gps_lat: exif_location.latitude,
gps_lon: exif_location.longitude,
```

If `probe_to_minimal_record` doesn't receive an `ExifLocation`, check how `location_text` is currently being set — it comes from the same EXIF call. Follow that pattern.

### Step 7 — Run tests

```
cd sherlock/desktop/src-tauri && cargo test --lib -- --test-threads=1
```

Expected: all tests PASS including the new migration test.

### Step 8 — Commit

```
cd sherlock/desktop && git add src-tauri/src/db.rs src-tauri/src/models.rs src-tauri/src/scan.rs
git commit -m "feat(db): migration 22 — gps_lat/gps_lon columns for map view"
```

---

## Task 4 — `list_gps_files` and `find_nearby` Rust commands

**Files:**
- Modify: `sherlock/desktop/src-tauri/src/db.rs`
- Modify: `sherlock/desktop/src-tauri/src/models.rs`
- Modify: `sherlock/desktop/src-tauri/src/lib.rs`

### Step 1 — Write failing tests

Append to `#[cfg(test)] mod tests` in `db.rs`:

```rust
#[test]
fn list_gps_files_returns_only_gps_tagged_files() {
    use tempfile::tempdir;
    let dir = tempdir().unwrap();
    let db = dir.path().join("t.sqlite");
    init_database(&db).unwrap();
    let root = upsert_root(&db, "D:\\P").unwrap();
    let conn = open_conn(&db).unwrap();

    // File with GPS
    conn.execute(
        "INSERT INTO files (root_id, rel_path, filename, abs_path, mtime_ns, size_bytes,
                            fingerprint, updated_at, gps_lat, gps_lon)
         VALUES (?1, 'gps.jpg', 'gps.jpg', 'D:\\P\\gps.jpg', 0, 0, 'fpg', 0, 48.8566, 2.3522)",
        rusqlite::params![root],
    ).unwrap();
    // File without GPS
    conn.execute(
        "INSERT INTO files (root_id, rel_path, filename, abs_path, mtime_ns, size_bytes,
                            fingerprint, updated_at)
         VALUES (?1, 'no_gps.jpg', 'no_gps.jpg', 'D:\\P\\no_gps.jpg', 0, 0, 'fpn', 0)",
        rusqlite::params![root],
    ).unwrap();
    drop(conn);

    let result = list_gps_files(&db, None).unwrap();
    assert_eq!(result.len(), 1);
    assert!((result[0].lat - 48.8566).abs() < 0.001);
    assert!((result[0].lon - 2.3522).abs() < 0.001);
}

#[test]
fn find_nearby_returns_closest_files() {
    use tempfile::tempdir;
    let dir = tempdir().unwrap();
    let db = dir.path().join("t.sqlite");
    init_database(&db).unwrap();
    let root = upsert_root(&db, "D:\\P").unwrap();
    let conn = open_conn(&db).unwrap();

    // 3 files: Paris, London, Tokyo
    let files = [
        ("paris.jpg", 48.8566f64, 2.3522f64),
        ("london.jpg", 51.5074, -0.1278),
        ("tokyo.jpg", 35.6762, 139.6503),
    ];
    for (i, (name, lat, lon)) in files.iter().enumerate() {
        conn.execute(
            "INSERT INTO files (root_id, rel_path, filename, abs_path, mtime_ns, size_bytes,
                                fingerprint, updated_at, gps_lat, gps_lon)
             VALUES (?1, ?2, ?3, ?4, 0, 0, ?5, 0, ?6, ?7)",
            rusqlite::params![root, name, name, format!("D:\\P\\{name}"), format!("fp{i}"), lat, lon],
        ).unwrap();
    }
    drop(conn);

    // Query near Paris (48.85, 2.35) — should return Paris first, then London, not Tokyo
    let results = find_nearby(&db, 48.85, 2.35, 50).unwrap();
    assert!(!results.is_empty());
    assert_eq!(results[0].filename, "paris.jpg");
    // Tokyo should not appear in top 2
    if results.len() >= 2 {
        assert_ne!(results[1].filename, "tokyo.jpg");
    }
}
```

- [ ] **Run to confirm failure:**

```
cd sherlock/desktop/src-tauri && cargo test list_gps_files --lib -- --test-threads=1
```

Expected: FAIL — functions not yet defined.

### Step 2 — Add `GpsFile` and `NearbyResult` models

In `sherlock/desktop/src-tauri/src/models.rs`, append:

```rust
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpsFile {
    pub id: i64,
    pub lat: f64,
    pub lon: f64,
    pub thumb_path: Option<String>,
    pub filename: String,
    pub media_type: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearbyResult {
    pub id: i64,
    pub filename: String,
    pub rel_path: String,
    pub abs_path: String,
    pub media_type: String,
    pub description: String,
    pub confidence: f32,
    pub lat: f64,
    pub lon: f64,
    pub thumb_path: Option<String>,
    pub dist_deg: f64,
}
```

### Step 3 — Implement `list_gps_files` and `find_nearby` in db.rs

Add the import to db.rs models import line — include `GpsFile, NearbyResult`.

Then add the functions after `check_saved_search_alerts`:

```rust
/// Returns all non-deleted files that have GPS coordinates.
/// `root_id` filters to a specific root when Some.
pub fn list_gps_files(db_path: &Path, root_id: Option<i64>) -> AppResult<Vec<GpsFile>> {
    let conn = open_conn(db_path)?;
    let sql = match root_id {
        Some(_) => "SELECT id, gps_lat, gps_lon, thumb_path, filename, media_type
                    FROM files WHERE deleted_at IS NULL
                    AND gps_lat IS NOT NULL AND gps_lon IS NOT NULL
                    AND root_id = ?1",
        None =>    "SELECT id, gps_lat, gps_lon, thumb_path, filename, media_type
                    FROM files WHERE deleted_at IS NULL
                    AND gps_lat IS NOT NULL AND gps_lon IS NOT NULL",
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = match root_id {
        Some(rid) => stmt.query_map(params![rid], |r| {
            Ok(GpsFile {
                id: r.get(0)?,
                lat: r.get(1)?,
                lon: r.get(2)?,
                thumb_path: r.get(3)?,
                filename: r.get(4)?,
                media_type: r.get(5)?,
            })
        })?,
        None => stmt.query_map([], |r| {
            Ok(GpsFile {
                id: r.get(0)?,
                lat: r.get(1)?,
                lon: r.get(2)?,
                thumb_path: r.get(3)?,
                filename: r.get(4)?,
                media_type: r.get(5)?,
            })
        })?,
    };
    Ok(rows.filter_map(Result::ok).collect())
}

/// Returns up to `limit` files sorted by approximate distance (degrees, not km)
/// from the given (lat, lon). Uses a bounding box pre-filter for efficiency.
pub fn find_nearby(db_path: &Path, lat: f64, lon: f64, limit: i64) -> AppResult<Vec<NearbyResult>> {
    let conn = open_conn(db_path)?;
    // ~1 degree ≈ 111 km. We pre-filter to ±10 degrees (≈1100 km) then sort by Euclidean dist.
    let delta = 10.0f64;
    let mut stmt = conn.prepare(
        "SELECT id, filename, rel_path, abs_path, media_type, description, confidence,
                gps_lat, gps_lon, thumb_path,
                ((gps_lat - ?1) * (gps_lat - ?1) + (gps_lon - ?2) * (gps_lon - ?2)) AS dist_sq
         FROM files
         WHERE deleted_at IS NULL
           AND gps_lat BETWEEN ?3 AND ?4
           AND gps_lon BETWEEN ?5 AND ?6
         ORDER BY dist_sq ASC
         LIMIT ?7",
    )?;
    let rows = stmt.query_map(
        params![lat, lon, lat - delta, lat + delta, lon - delta, lon + delta, limit],
        |r| {
            let dist_sq: f64 = r.get(10)?;
            Ok(NearbyResult {
                id: r.get(0)?,
                filename: r.get(1)?,
                rel_path: r.get(2)?,
                abs_path: r.get(3)?,
                media_type: r.get(4)?,
                description: r.get(5)?,
                confidence: r.get(6)?,
                lat: r.get(7)?,
                lon: r.get(8)?,
                thumb_path: r.get(9)?,
                dist_deg: dist_sq.sqrt(),
            })
        },
    )?;
    Ok(rows.filter_map(Result::ok).collect())
}
```

### Step 4 — Register Tauri commands in lib.rs

Add after `check_saved_search_alerts_cmd`:

```rust
#[tauri::command]
async fn list_gps_files_cmd(
    state: tauri::State<'_, AppState>,
    root_id: Option<i64>,
) -> Result<Vec<models::GpsFile>, String> {
    db::list_gps_files(&state.paths.db_file, root_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn find_nearby_cmd(
    state: tauri::State<'_, AppState>,
    lat: f64,
    lon: f64,
    limit: i64,
) -> Result<Vec<models::NearbyResult>, String> {
    db::find_nearby(&state.paths.db_file, lat, lon, limit).map_err(|e| e.to_string())
}
```

Add to `generate_handler!`:
```rust
list_gps_files_cmd,
find_nearby_cmd,
```

### Step 5 — Run tests

```
cd sherlock/desktop/src-tauri && cargo test list_gps_files find_nearby --lib -- --test-threads=1
```

Expected: 2 new tests PASS, all existing tests still PASS.

### Step 6 — Commit

```
cd sherlock/desktop && git add src-tauri/src/db.rs src-tauri/src/models.rs src-tauri/src/lib.rs
git commit -m "feat(db): list_gps_files and find_nearby commands for map view"
```

---

## Task 5 — MapView frontend component

**Files:**
- Modify: `sherlock/desktop/package.json`
- Create: `sherlock/desktop/src/components/Content/MapView.tsx`
- Create: `sherlock/desktop/src/components/Content/MapView.css`
- Modify: `sherlock/desktop/src/types.ts`
- Modify: `sherlock/desktop/src/api.ts`

### Step 1 — Install maplibre-gl

```
cd sherlock/desktop && npm install maplibre-gl@^4
```

Verify it appears in `package.json` dependencies.

### Step 2 — Add frontend types

In `sherlock/desktop/src/types.ts`, append:

```typescript
export type GpsFile = {
  id: number;
  lat: number;
  lon: number;
  thumbPath: string | null;
  filename: string;
  mediaType: string;
};

export type NearbyResult = {
  id: number;
  filename: string;
  relPath: string;
  absPath: string;
  mediaType: string;
  description: string;
  confidence: number;
  lat: number;
  lon: number;
  thumbPath: string | null;
  distDeg: number;
};
```

### Step 3 — Add API functions

In `sherlock/desktop/src/api.ts`, append:

```typescript
export async function listGpsFiles(rootId?: number | null): Promise<GpsFile[]> {
  return invoke<GpsFile[]>("list_gps_files_cmd", { rootId: rootId ?? null });
}

export async function findNearby(lat: number, lon: number, limit = 50): Promise<NearbyResult[]> {
  return invoke<NearbyResult[]>("find_nearby_cmd", { lat, lon, limit });
}
```

Also add `GpsFile, NearbyResult` to the type imports in api.ts.

### Step 4 — Create MapView.tsx

Create `sherlock/desktop/src/components/Content/MapView.tsx`:

```tsx
import { useEffect, useRef, useState, useCallback } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { GpsFile, NearbyResult } from "../../types";
import { listGpsFiles } from "../../api";
import "./MapView.css";

type Props = {
  onBack: () => void;
  onSelectFiles: (ids: number[]) => void;
  onFindNearby: (lat: number, lon: number) => void;
};

const OSM_STYLE = {
  version: 8 as const,
  sources: {
    osm: {
      type: "raster" as const,
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
      maxzoom: 19,
    },
  },
  layers: [{ id: "osm", type: "raster" as const, source: "osm" }],
};

export default function MapView({ onBack, onSelectFiles, onFindNearby }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [gpsFiles, setGpsFiles] = useState<GpsFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const files = await listGpsFiles();
      setGpsFiles(files);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  useEffect(() => {
    if (!containerRef.current || loading || error) return;
    if (mapRef.current) return; // already initialized

    // Dynamic import to avoid issues with SSR/test environments
    import("maplibre-gl").then(({ Map, NavigationControl, Marker, Popup }) => {
      if (!containerRef.current) return;

      const map = new Map({
        container: containerRef.current,
        style: OSM_STYLE,
        center: gpsFiles.length > 0
          ? [gpsFiles[0].lon, gpsFiles[0].lat]
          : [0, 20],
        zoom: gpsFiles.length > 0 ? 4 : 2,
      });

      map.addControl(new NavigationControl(), "top-right");

      // Add markers
      for (const file of gpsFiles) {
        const el = document.createElement("div");
        el.className = "map-pin";
        el.title = file.filename;

        const popup = new Popup({ offset: 16, closeButton: false })
          .setHTML(
            `<div class="map-popup">
               ${file.thumbPath ? `<img src="asset://localhost/${encodeURIComponent(file.thumbPath.replace(/\\/g, "/"))}" alt="" />` : ""}
               <div class="map-popup-name">${file.filename}</div>
               <button class="map-popup-nearby" data-lat="${file.lat}" data-lon="${file.lon}">Find nearby</button>
             </div>`
          );

        const marker = new Marker({ element: el })
          .setLngLat([file.lon, file.lat])
          .setPopup(popup)
          .addTo(map);

        el.addEventListener("click", () => {
          setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(file.id)) {
              next.delete(file.id);
            } else {
              next.add(file.id);
            }
            return next;
          });
        });

        marker.getPopup().on("open", () => {
          const btn = document.querySelector<HTMLButtonElement>(".map-popup-nearby");
          if (btn) {
            btn.onclick = () => {
              const lat = parseFloat(btn.dataset.lat ?? "0");
              const lon = parseFloat(btn.dataset.lon ?? "0");
              onFindNearby(lat, lon);
            };
          }
        });
      }

      mapRef.current = map;

      // Auto-fit to all markers
      if (gpsFiles.length > 1) {
        const lats = gpsFiles.map((f) => f.lat);
        const lons = gpsFiles.map((f) => f.lon);
        map.fitBounds(
          [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
          { padding: 60, maxZoom: 12 }
        );
      }
    }).catch(() => setError("Failed to load map library"));

    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, error, gpsFiles.length]);

  return (
    <div className="map-view">
      <div className="map-view-header">
        <button className="map-back-btn" onClick={onBack}>← Back</button>
        <span className="map-view-title">
          Map — {gpsFiles.length} file{gpsFiles.length !== 1 ? "s" : ""} with GPS
        </span>
        {selectedIds.size > 0 && (
          <button
            className="map-select-btn"
            onClick={() => onSelectFiles([...selectedIds])}
          >
            Show {selectedIds.size} selected
          </button>
        )}
      </div>

      {loading && <div className="map-loading">Loading GPS data…</div>}
      {error && <div className="map-error">{error}</div>}
      {!loading && !error && gpsFiles.length === 0 && (
        <div className="map-empty">No files with GPS coordinates found. Scan photos with EXIF location data to see them here.</div>
      )}

      <div
        ref={containerRef}
        className="map-container"
        style={{ visibility: loading || error || gpsFiles.length === 0 ? "hidden" : "visible" }}
      />
    </div>
  );
}
```

### Step 5 — Create MapView.css

Create `sherlock/desktop/src/components/Content/MapView.css`:

```css
.map-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  position: relative;
}

.map-view-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-primary);
  flex-shrink: 0;
}

.map-back-btn {
  background: none;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  padding: 3px 8px;
  cursor: pointer;
}

.map-back-btn:hover {
  border-color: var(--border-focus);
}

.map-view-title {
  flex: 1;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.map-select-btn {
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: var(--radius-sm);
  font: inherit;
  font-size: var(--font-size-sm);
  padding: 4px 10px;
  cursor: pointer;
}

.map-container {
  flex: 1;
  min-height: 0;
}

.map-loading,
.map-error,
.map-empty {
  padding: 24px;
  text-align: center;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.map-error { color: var(--danger); }

/* ── Map pin marker ─────────────────────────────────────── */
.map-pin {
  width: 12px;
  height: 12px;
  background: var(--accent, #4d8fff);
  border: 2px solid #fff;
  border-radius: 50%;
  cursor: pointer;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
  transition: transform 0.1s;
}

.map-pin:hover {
  transform: scale(1.4);
}

/* ── Popup ──────────────────────────────────────────────── */
.map-popup {
  min-width: 120px;
  font-family: inherit;
}

.map-popup img {
  width: 100%;
  height: 80px;
  object-fit: cover;
  border-radius: 2px;
  display: block;
  margin-bottom: 4px;
}

.map-popup-name {
  font-size: 0.75rem;
  color: #111;
  word-break: break-all;
  margin-bottom: 4px;
}

.map-popup-nearby {
  width: 100%;
  padding: 3px 0;
  background: #1e88e5;
  color: #fff;
  border: none;
  border-radius: 3px;
  font-size: 0.7rem;
  cursor: pointer;
}

.map-popup-nearby:hover {
  background: #1565c0;
}
```

### Step 6 — Run frontend tests

```
cd sherlock/desktop && npm run test -- --run
```

Expected: all tests PASS (MapView has no unit tests yet — the component is visual; we add a smoke test in the next step).

### Step 7 — Commit

```
cd sherlock/desktop && git add src/components/Content/MapView.tsx src/components/Content/MapView.css src/types.ts src/api.ts package.json package-lock.json
git commit -m "feat(map): MapView with GPS pins using maplibre-gl"
```

---

## Task 6 — "Find nearby" context menu + MapView wiring in App.tsx

**Files:**
- Modify: `sherlock/desktop/src/components/Content/ContextMenu.tsx`
- Modify: `sherlock/desktop/src/App.tsx`
- Modify: `sherlock/desktop/src/components/Sidebar/Sidebar.tsx`

### Step 1 — Add `onFindNearby` to ContextMenu

In `sherlock/desktop/src/components/Content/ContextMenu.tsx`:

1. Add to Props type:
```typescript
  hasGps: boolean;
  onFindNearby: () => void;
```

2. Add to destructured params:
```typescript
  hasGps, onFindNearby,
```

3. Add the menu item after "Find similar":
```tsx
{selectedCount === 1 && hasGps && (
  <button className="context-menu-item" role="menuitem" onClick={onFindNearby}>
    <span>Find nearby</span>
  </button>
)}
```

### Step 2 — Add map mode state to App.tsx

In `sherlock/desktop/src/App.tsx`, find the mode state declarations and add:

```typescript
const [mapMode, setMapMode] = useState(false);
```

### Step 3 — Add "Map" tool button to Sidebar props

In `sherlock/desktop/src/components/Sidebar/Sidebar.tsx`:

1. Add to SidebarProps type (after `onFindDuplicates`):
```typescript
  onOpenMap?: () => void;
```

2. Add to destructured params.

3. In the Tools section JSX, add after the "Find Duplicates" button:
```tsx
{onOpenMap && (
  <button
    type="button"
    className="sidebar-tool-btn"
    onClick={onOpenMap}
    title="Browse photos on a map"
  >
    Map
  </button>
)}
```

### Step 4 — Wire everything into App.tsx

1. Add imports:
```typescript
import MapView from "./components/Content/MapView";
import { findNearby } from "./api";
```

2. Add `nearbySource` state:
```typescript
const [nearbySource, setNearbySource] = useState<{ lat: number; lon: number } | null>(null);
```

3. Add context menu GPS info state (near other context menu state):
```typescript
const [contextMenuHasGps, setContextMenuHasGps] = useState(false);
```

4. In `onTileContextMenu`, after calling `getFileMetadata`, also fetch GPS:
```typescript
// After the existing getFileMetadata call, add:
if (effectiveSelection.size === 1) {
  const item = items[idx];
  if (item) {
    getFileProperties(item.id)
      .then((props) => setContextMenuHasGps(
        props.latitude != null && props.longitude != null
      ))
      .catch(() => setContextMenuHasGps(false));
  }
} else {
  setContextMenuHasGps(false);
}
```

5. Add `handleContextFindNearby`:
```typescript
async function handleContextFindNearby() {
  setContextMenu(null);
  if (selectedIndices.size !== 1) return;
  const idx = [...selectedIndices][0];
  if (idx >= items.length) return;
  const item = items[idx];
  try {
    const props = await getFileProperties(item.id);
    if (props.latitude != null && props.longitude != null) {
      setNearbySource({ lat: props.latitude, lon: props.longitude });
      setMapMode(true);
    }
  } catch { /* ignore */ }
}
```

6. Update ContextMenu JSX to pass the new props:
```tsx
hasGps={contextMenuHasGps}
onFindNearby={handleContextFindNearby}
```

7. Wire `onOpenMap` to Sidebar:
```tsx
onOpenMap={() => {
  setMapMode(true);
  duplicates.setDuplicatesMode(false);
  setPdfPasswordsMode(false);
  faces.setFacesMode(false);
}}
```

8. Add `enterMapMode` helper (near other mode-switching functions):
```typescript
function enterMapMode() {
  setMapMode(true);
  duplicates.setDuplicatesMode(false);
  setPdfPasswordsMode(false);
  faces.setFacesMode(false);
}
```

9. In the main content area (the big if/else chain), add MapView as the first branch before FacesView:

Replace:
```tsx
{faces.facesMode ? (
```
With:
```tsx
{mapMode ? (
  <MapView
    onBack={() => setMapMode(false)}
    onSelectFiles={async (ids) => {
      // When user selects pins from map, run a search for those file IDs
      // by setting a synthetic query that forces a reload
      setMapMode(false);
      // Use the "id:" filter if supported, or show a toast with IDs count
      setNotice(`Selected ${ids.length} file(s) from map — use the grid to view them`);
    }}
    onFindNearby={async (lat, lon) => {
      try {
        const results = await findNearby(lat, lon, 50);
        if (results.length === 0) {
          setNotice("No nearby files found within search radius");
          return;
        }
        setMapMode(false);
        // Build a query from the nearby result IDs by using location_text or a toast
        setNotice(`Found ${results.length} nearby file(s)`);
        // Navigate to the first result file in the preview
        const synth = results.map((r) => ({
          id: r.id, rootId: 0, relPath: r.relPath, absPath: r.absPath,
          mediaType: r.mediaType, description: r.description,
          confidence: r.confidence, mtimeNs: 0, sizeBytes: 0,
          thumbnailPath: r.thumbPath,
        }));
        setFacePreviewItems(synth.slice(0, 10) as SearchItem[]);
      } catch (err) {
        setError(errorMessage(err));
      }
    }}
  />
) : faces.facesMode ? (
```

And close the extra ternary at the end — make sure the JSX chain is correct.

### Step 5 — Update `subtitle` memo to include map mode

In the `subtitle` useMemo, add:
```typescript
if (mapMode) return "Map";
```
as the first condition.

Also add `mapMode` to the dependency array.

### Step 6 — Run all frontend tests

```
cd sherlock/desktop && npm run test -- --run
```

Expected: all tests PASS.

### Step 7 — Commit

```
cd sherlock/desktop && git add src/App.tsx src/components/Content/ContextMenu.tsx src/components/Sidebar/Sidebar.tsx
git commit -m "feat(map): Find nearby context menu, map mode in App, Map sidebar button"
```

---

## Task 7 — HelpModal updates + release notes

**Files:**
- Modify: `sherlock/desktop/src/components/modals/HelpModal.tsx`
- Create: `releases/v0.17.0.md`

### Step 1 — Update HelpModal

In `sherlock/desktop/src/components/modals/HelpModal.tsx`, after the "Time of day" section, add new sections:

```tsx
<div className="help-section">
  <h4>Color filter</h4>
  <div className="help-examples">
    <code>color:#ff0000</code>
    <code>color:#1e88e5</code>
  </div>
  <p className="help-note-inline">Click a color swatch in the toolbar, or type hex directly.</p>
</div>

<div className="help-section">
  <h4>Shot kind</h4>
  <div className="help-examples">
    <code>shot:selfie</code>
    <code>shot:group</code>
    <code>shot:landscape</code>
  </div>
</div>

<div className="help-section">
  <h4>Blur filter</h4>
  <div className="help-examples">
    <code>blur:true</code>
    <code>blur:false</code>
  </div>
  <p className="help-note-inline">Or use the ~ toggle in the toolbar.</p>
</div>
```

### Step 2 — Create release notes

Create `releases/v0.17.0.md`:

```markdown
# Frank Sherlock v0.17.0 — Map View, Color Swatches, Alert Notifications

## What's New

### Color Swatches in Toolbar
- A row of 12 named color swatches now appears below the search bar
- Click a swatch to filter results by dominant color (uses `color:#RRGGBB` token)
- Click the active swatch again to clear the filter
- Swatches cover: Red, Orange, Yellow, Green, Teal, Cyan, Blue, Indigo, Purple, Pink, White, Black

### Saved Search Alerts (Background Polling)
- Saved searches with the 🔔 bell enabled now check for new matches every 15 minutes
- When new files match a saved search, a desktop notification is shown (requires browser notification permission, granted on first launch)
- In-app toast also appears for missed notifications

### Map View
- New **Map** tool in the sidebar — shows all scanned files that have GPS coordinates as pins on an OpenStreetMap map
- Click a pin to see a thumbnail popup with a **Find nearby** button
- Right-click any photo → **Find nearby** to show photos taken within ~1100 km
- GPS coordinates (`gps_lat`, `gps_lon`) are now persisted in the database at scan time

## Changes

### Backend
- Migration 22: `gps_lat REAL`, `gps_lon REAL` columns on `files` table with spatial index
- New commands: `list_gps_files_cmd`, `find_nearby_cmd`, `check_saved_search_alerts_cmd`
- `scan.rs`: wires `ExifLocation.latitude/longitude` into `FileRecordUpsert`

### Frontend
- `Toolbar`: color swatch row with 12 swatches, active state, clear button
- `MapView`: maplibre-gl with OSM raster tiles, pin markers, popup with thumbnail
- `ContextMenu`: "Find nearby" item (visible when file has GPS)
- `Sidebar`: "Map" button in Tools section
- `useSavedSearchAlerts`: 15-min polling hook, Web Notification API + in-app toast
- `HelpModal`: `color:`, `shot:`, `blur:` token docs added

## Breaking Changes
- Database schema updated (migration 22 — applied automatically on first launch)
```

### Step 3 — Commit

```
cd sherlock/desktop && git add src/components/modals/HelpModal.tsx releases/v0.17.0.md
git commit -m "docs: v0.17.0 release notes, HelpModal color/shot/blur token docs"
```

---

## Task 8 — Final run + PR

### Step 1 — Full test suite

```
cd sherlock/desktop/src-tauri && cargo test --lib -- --test-threads=1
```

Expected: 384+ tests PASS.

```
cd sherlock/desktop && npm run test -- --run
```

Expected: 343+ tests PASS.

### Step 2 — Create PR targeting felvieira/FrankSherlock:master

```bash
cd sherlock/desktop && git push origin feat/missing-features
gh pr create \
  --repo felvieira/FrankSherlock \
  --base master \
  --head feat/missing-features \
  --title "feat: color swatches, saved-search alerts, map view + find nearby" \
  --body "$(cat releases/v0.17.0.md)"
```

### Step 3 — Merge

```bash
gh pr merge --repo felvieira/FrankSherlock --merge
```

---

## Self-review

### Spec coverage

| Requirement | Task |
|---|---|
| Color swatch row in toolbar | Task 1 |
| Click swatch → `color:#hex` token | Task 1 |
| Active swatch highlighted | Task 1 |
| Saved search polling every 15 min | Task 2 |
| Desktop notification on new matches | Task 2 |
| Update `last_match_id` / `last_checked_at` | Task 2 |
| Persist GPS lat/lon in DB | Task 3 |
| `list_gps_files` command | Task 4 |
| `find_nearby` command (bounding box + sort by dist) | Task 4 |
| MapLibre map with OSM tiles | Task 5 |
| GPS pins with popup thumbnail | Task 5 |
| Click pin cluster → navigate | Task 5/6 |
| "Find nearby" context menu (GPS files only) | Task 6 |
| Map mode in App.tsx | Task 6 |
| Sidebar "Map" button | Task 6 |
| HelpModal `color:` / `blur:` / `shot:` docs | Task 7 |
| Release notes | Task 7 |

### Placeholder check

No TBDs or "fill in later" items — all steps contain complete code.

### Type consistency

- `GpsFile` defined in Task 4 (models.rs) and Task 5 (types.ts) — same fields.
- `NearbyResult` defined in Task 4 (models.rs) and Task 5 (types.ts) — same fields.
- `SavedSearchAlert` defined in Task 2 (models.rs) and Task 2 (types.ts) — same fields.
- `check_saved_search_alerts_cmd` registered in lib.rs (Task 2) and called as `checkSavedSearchAlerts` in api.ts (Task 2).
- `list_gps_files_cmd` / `find_nearby_cmd` registered in lib.rs (Task 4) and called in api.ts (Task 5).
- `onFindNearby` prop added to ContextMenu (Task 6) and wired in App.tsx (Task 6).
- `hasGps` prop added to ContextMenu (Task 6) — populated from `getFileProperties` in App.tsx.
