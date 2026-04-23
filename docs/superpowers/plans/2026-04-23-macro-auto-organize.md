# Macro Plan — Auto-Organize, AI Suggestions & Pro UX

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the already-implemented `clustering.rs` backend (events/trips/bursts) into a full user-facing flow — browse events, review AI-suggested folder structure, execute move/copy with date preservation — plus round out the app with map clustering, mtime fix, batch rename, and `date_taken` sort.

**Architecture:** All backend primitives (DBSCAN-lite event clustering, burst detection, LLM tags/descriptions/location_text per file, GPS per file) already exist. Build thin new Rust commands for suggest-names and organize-files on top. Frontend gets three new views (Events, Trips, Bursts) and a wizard modal (OrganizeWizard). Every physical file-move is atomic: SQLite `BEGIN` → `std::fs::rename` loop → `UPDATE files.path` → `COMMIT`, with rollback on any error.

**Tech Stack:** Rust (rusqlite, rusqlite_migration, filetime, chrono, serde), React/TypeScript (Tauri v2, maplibre-gl ^4.7.1, existing shared-tool-view.css pattern).

---

## Phase overview

| Phase | Tasks | Value |
|-------|-------|-------|
| A. Foundation fixes | 1–3 | Correct mtime, sort by date_taken, map clustering |
| B. Events UI | 4–6 | EventsView + TripsView + event name suggestions |
| C. Organize Wizard | 7–10 | Analyze → Review → Execute move/copy with atomic rollback |
| D. Burst review | 11–12 | BurstReviewView with "keep sharpest" AI picker |
| E. Batch rename | 13–14 | Template-based rename (`{date_taken:%Y-%m-%d}_{event}`) |
| F. Resumable face scan | 15–17 | Checkpoint table + auto-resume on boot + incremental clustering |
| G. Polish & ship | 18–19 | Help docs + release notes v0.18.0 |

---

## File Structure

**Rust — new/modified:**
- Modify: `sherlock/desktop/src-tauri/src/exif.rs` — add `apply_exif_mtime(path, datetime)` helper
- Create: `sherlock/desktop/src-tauri/src/organize.rs` — event-name suggestion + atomic move/copy engine
- Modify: `sherlock/desktop/src-tauri/src/clustering.rs` — add `suggest_event_names` that aggregates tags/location_text per event
- Modify: `sherlock/desktop/src-tauri/src/lib.rs` — register new commands
- Modify: `sherlock/desktop/src-tauri/src/db.rs` — migration 23 adds `events.suggested_name TEXT`
- Modify: `sherlock/desktop/src-tauri/src/filters.rs` — accept `date_taken` as a sort field
- Modify: `sherlock/desktop/src-tauri/src/scan.rs` — call `apply_exif_mtime` during scan if EXIF date found

**Frontend — new/modified:**
- Create: `sherlock/desktop/src/components/Content/EventsView.tsx` + `.css`
- Create: `sherlock/desktop/src/components/Content/TripsView.tsx` + `.css`
- Create: `sherlock/desktop/src/components/Content/BurstReviewView.tsx` + `.css`
- Create: `sherlock/desktop/src/components/modals/OrganizeWizard.tsx` + `.css`
- Modify: `sherlock/desktop/src/components/Content/MapView.tsx` — enable maplibre cluster source
- Modify: `sherlock/desktop/src/components/Sidebar/Sidebar.tsx` — add Events/Trips/Bursts/Organize buttons
- Modify: `sherlock/desktop/src/App.tsx` — wire new modes (`eventsMode`, `tripsMode`, `burstsMode`) + organize wizard state
- Modify: `sherlock/desktop/src/api.ts` + `types.ts` — types for `OrganizePlan`, `OrganizeResult`, `SuggestedName`, `DateSortField`
- Modify: `sherlock/desktop/src/components/modals/HelpModal.tsx` — document events/trips/organize

---

# Phase A — Foundation fixes

## Task 1: Apply EXIF date_taken to filesystem mtime

**Files:**
- Modify: `sherlock/desktop/src-tauri/Cargo.toml` — add `filetime = "0.2"` (if not present — check first with `grep filetime sherlock/desktop/src-tauri/Cargo.toml`)
- Modify: `sherlock/desktop/src-tauri/src/exif.rs` — add helper
- Modify: `sherlock/desktop/src-tauri/src/scan.rs` — call helper on each scanned file
- Test: add unit test at bottom of `exif.rs`

- [ ] **Step 1: Ensure `filetime` dep is declared**

Run: `grep filetime D:/Repos/GERAL/FrankSherlock/.worktrees/feat-auto-organize/sherlock/desktop/src-tauri/Cargo.toml || echo MISSING`

If MISSING, add under `[dependencies]`:
```toml
filetime = "0.2"
```

- [ ] **Step 2: Write failing test in `exif.rs`** (append to existing `#[cfg(test)] mod tests`)

```rust
#[test]
fn apply_exif_mtime_updates_os_mtime() {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("x.jpg");
    fs::write(&p, b"hello").unwrap();
    // 2020-01-15T12:00:00Z = 1579089600
    let target = chrono::DateTime::<chrono::Utc>::from_timestamp(1579089600, 0).unwrap();
    apply_exif_mtime(&p, target).unwrap();
    let meta = fs::metadata(&p).unwrap();
    let got = meta.modified().unwrap().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
    assert_eq!(got, 1579089600);
}
```

- [ ] **Step 3: Run test — should fail "function not defined"**

Run: `cd sherlock/desktop/src-tauri && cargo test apply_exif_mtime_updates_os_mtime`
Expected: compile error / undefined function.

- [ ] **Step 4: Implement `apply_exif_mtime`**

Add to `exif.rs`:
```rust
use std::path::Path;

pub fn apply_exif_mtime(path: &Path, dt: chrono::DateTime<chrono::Utc>) -> std::io::Result<()> {
    let ts = filetime::FileTime::from_unix_time(dt.timestamp(), 0);
    filetime::set_file_mtime(path, ts)
}
```

- [ ] **Step 5: Run test — should pass**

Run: `cd sherlock/desktop/src-tauri && cargo test apply_exif_mtime_updates_os_mtime`
Expected: 1 passed.

- [ ] **Step 6: Wire into scan pipeline**

In `scan.rs`, find the block that computes `ExifData` for each file (search for `extract_exif` call). Immediately after `let exif = extract_exif(...)`, add:
```rust
if let Some(dt) = exif.date_taken {
    let _ = crate::exif::apply_exif_mtime(&path, dt); // best-effort
}
```
(Skip the call if `exif.date_taken` is `None`.)

- [ ] **Step 7: Build backend**

Run: `cd sherlock/desktop/src-tauri && cargo build`
Expected: clean build.

- [ ] **Step 8: Commit**

```bash
git add sherlock/desktop/src-tauri/Cargo.toml sherlock/desktop/src-tauri/src/exif.rs sherlock/desktop/src-tauri/src/scan.rs
git commit -m "feat(scan): apply EXIF date_taken to OS mtime"
```

---

## Task 2: Sort by date_taken

**Files:**
- Modify: `sherlock/desktop/src-tauri/src/filters.rs` — accept `dateTaken` as a sort key
- Modify: `sherlock/desktop/src/types.ts` — add `"dateTaken"` to the sort-field union
- Modify: `sherlock/desktop/src/components/Content/Toolbar.tsx` — add `<option value="dateTaken">Date taken</option>`

- [ ] **Step 1: Extend Rust sort enum**

In `filters.rs`, locate the `match sort_by.as_str()` block (search: `"mtime"` or `ORDER BY`). Add a new arm:
```rust
"dateTaken" | "date_taken" => "COALESCE(date_taken, mtime) DESC",
```
Keep existing arms intact.

- [ ] **Step 2: Frontend type**

In `types.ts`, find `export type SortField` (or similar union used by Toolbar). Add `"dateTaken"`:
```ts
export type SortField = "name" | "mtime" | "size" | "dateTaken";
```

- [ ] **Step 3: Toolbar option**

In `Toolbar.tsx`, find the `<select>` that emits sort options. Add:
```tsx
<option value="dateTaken">Date taken</option>
```
Before the existing `mtime` option.

- [ ] **Step 4: Build & smoke test**

Run: `cd sherlock/desktop && npm run build` (expect clean tsc) and `cd src-tauri && cargo build`.

- [ ] **Step 5: Commit**

```bash
git add sherlock/desktop/src-tauri/src/filters.rs sherlock/desktop/src/types.ts sherlock/desktop/src/components/Content/Toolbar.tsx
git commit -m "feat(sort): add 'date taken' as a sort field"
```

---

## Task 3: Map pin clustering

**Files:**
- Modify: `sherlock/desktop/src/components/Content/MapView.tsx` — convert markers to GeoJSON source with `cluster: true`

- [ ] **Step 1: Replace per-pin markers with clustered GeoJSON source**

Find the current `map.on('load', ...)` callback in `MapView.tsx`. Replace the marker-addition loop with:

```tsx
map.addSource("photos", {
  type: "geojson",
  cluster: true,
  clusterRadius: 50,
  clusterMaxZoom: 14,
  data: {
    type: "FeatureCollection",
    features: gpsFiles.map((f) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [f.lon, f.lat] },
      properties: { id: f.id },
    })),
  },
});

map.addLayer({
  id: "clusters",
  type: "circle",
  source: "photos",
  filter: ["has", "point_count"],
  paint: {
    "circle-color": "#1e88e5",
    "circle-radius": ["step", ["get", "point_count"], 15, 10, 20, 100, 28],
    "circle-stroke-width": 2,
    "circle-stroke-color": "#fff",
  },
});

map.addLayer({
  id: "cluster-count",
  type: "symbol",
  source: "photos",
  filter: ["has", "point_count"],
  layout: {
    "text-field": "{point_count_abbreviated}",
    "text-size": 12,
  },
  paint: { "text-color": "#fff" },
});

map.addLayer({
  id: "unclustered",
  type: "circle",
  source: "photos",
  filter: ["!", ["has", "point_count"]],
  paint: {
    "circle-color": "#e53935",
    "circle-radius": 6,
    "circle-stroke-width": 2,
    "circle-stroke-color": "#fff",
  },
});

map.on("click", "clusters", (e) => {
  const f = map.queryRenderedFeatures(e.point, { layers: ["clusters"] })[0];
  const clusterId = f.properties!.cluster_id;
  (map.getSource("photos") as any).getClusterExpansionZoom(clusterId, (err: any, zoom: number) => {
    if (err) return;
    map.easeTo({ center: (f.geometry as any).coordinates, zoom });
  });
});

map.on("click", "unclustered", (e) => {
  const f = e.features?.[0];
  if (!f) return;
  const fileId = f.properties?.id as number;
  onSelectFiles([fileId]);
});
```

Delete the old `new maplibregl.Marker(...)` loop.

- [ ] **Step 2: Build & smoke**

Run: `cd sherlock/desktop && npm run build`. Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add sherlock/desktop/src/components/Content/MapView.tsx
git commit -m "feat(map): cluster pins via maplibre-gl native clustering"
```

---

# Phase B — Events UI

## Task 4: Migration 23 + suggested_name column

**Files:**
- Modify: `sherlock/desktop/src-tauri/src/db.rs` — append migration
- Modify test: the two schema-version assertions inside `db.rs` tests

- [ ] **Step 1: Append migration 23**

At the bottom of the `migrations()` vec in `db.rs`, add (keep the trailing comma):
```rust
M::up(r#"
    ALTER TABLE events ADD COLUMN suggested_name TEXT;
"#),
```

- [ ] **Step 2: Update schema-version test assertions**

Search `db.rs` for `assert_eq!(version, 23)`. Change both to `24`.

- [ ] **Step 3: Run migration test**

Run: `cd sherlock/desktop/src-tauri && cargo test test_migrations_apply_to_fresh_db test_schema_version_set`
Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add sherlock/desktop/src-tauri/src/db.rs
git commit -m "feat(db): migration 23 adds events.suggested_name"
```

---

## Task 5: Backend — suggest_event_names command

**Files:**
- Create: `sherlock/desktop/src-tauri/src/organize.rs`
- Modify: `sherlock/desktop/src-tauri/src/lib.rs` — register `mod organize;` and new command
- Modify: `sherlock/desktop/src-tauri/src/models.rs` — add `SuggestedName` struct (or inline in organize.rs)

- [ ] **Step 1: Create `organize.rs` with suggest_event_names**

```rust
use crate::db::open_conn;
use crate::error::AppResult;
use rusqlite::params;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestedName {
    pub event_id: i64,
    pub suggested: String,
}

/// Aggregates top-1 LLM tag + location_text + YYYY-MM of each event
/// into a human-readable suggested folder name.
pub fn suggest_event_names(db_path: &Path) -> AppResult<Vec<SuggestedName>> {
    let conn = open_conn(db_path)?;
    let mut stmt = conn.prepare(
        r#"SELECT id, started_at FROM events ORDER BY started_at"#,
    )?;
    let events: Vec<(i64, i64)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    drop(stmt);

    let mut out = Vec::with_capacity(events.len());
    for (event_id, started_at) in events {
        let month = chrono::DateTime::<chrono::Utc>::from_timestamp(started_at, 0)
            .map(|d| d.format("%Y-%m").to_string())
            .unwrap_or_else(|| "unknown".to_string());

        // Pick most common non-null location_text in the event, else top tag
        let location: Option<String> = conn.query_row(
            r#"SELECT f.location_text FROM files f
               JOIN event_files ef ON ef.file_id = f.id
               WHERE ef.event_id = ?1 AND f.location_text IS NOT NULL AND f.location_text != ''
               GROUP BY f.location_text
               ORDER BY COUNT(*) DESC LIMIT 1"#,
            params![event_id],
            |r| r.get::<_, String>(0),
        ).ok();

        let tag: Option<String> = conn.query_row(
            r#"SELECT t.name FROM tags t
               JOIN file_tags ft ON ft.tag_id = t.id
               JOIN event_files ef ON ef.file_id = ft.file_id
               WHERE ef.event_id = ?1
               GROUP BY t.name
               ORDER BY COUNT(*) DESC LIMIT 1"#,
            params![event_id],
            |r| r.get::<_, String>(0),
        ).ok();

        let suggested = match (location, tag) {
            (Some(loc), _) => format!("{} {}", month, loc),
            (None, Some(t)) => format!("{} {}", month, t),
            _ => format!("{} Photos", month),
        };

        // Persist
        conn.execute(
            "UPDATE events SET suggested_name = ?1 WHERE id = ?2",
            params![suggested, event_id],
        )?;

        out.push(SuggestedName { event_id, suggested });
    }
    Ok(out)
}

#[tauri::command]
pub async fn suggest_event_names_cmd(
    state: tauri::State<'_, crate::runtime::AppState>,
) -> Result<Vec<SuggestedName>, String> {
    let db = state.db_path.clone();
    tokio::task::spawn_blocking(move || suggest_event_names(&db))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}
```

> **Note:** If the actual column/table names differ (e.g. `event_files` might be `event_members`), look up the migration that created events to match. Open `db.rs`, search `CREATE TABLE events`, and use the exact member-table name.

- [ ] **Step 2: Register module**

In `lib.rs`, add `mod organize;` near other `mod` declarations. In the `invoke_handler![...]` macro, add `organize::suggest_event_names_cmd,`.

- [ ] **Step 3: Build**

Run: `cd sherlock/desktop/src-tauri && cargo build`
Fix any column-name mismatches by reading the actual events schema.

- [ ] **Step 4: Add integration test**

Append to `organize.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;

    #[test]
    fn suggest_event_names_empty_db_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("t.db");
        init_db(&db).unwrap();
        let result = suggest_event_names(&db).unwrap();
        assert_eq!(result.len(), 0);
    }
}
```

Run: `cargo test suggest_event_names_empty_db_returns_empty` — expected pass.

- [ ] **Step 5: Commit**

```bash
git add sherlock/desktop/src-tauri/src/organize.rs sherlock/desktop/src-tauri/src/lib.rs
git commit -m "feat(organize): suggest_event_names aggregates tags/location per event"
```

---

## Task 6: Frontend — EventsView + TripsView

**Files:**
- Create: `sherlock/desktop/src/components/Content/EventsView.tsx`
- Create: `sherlock/desktop/src/components/Content/EventsView.css`
- Create: `sherlock/desktop/src/components/Content/TripsView.tsx`
- Create: `sherlock/desktop/src/components/Content/TripsView.css`
- Modify: `sherlock/desktop/src/api.ts` — add `suggestEventNames`
- Modify: `sherlock/desktop/src/types.ts` — add `SuggestedName`
- Modify: `sherlock/desktop/src/components/Sidebar/Sidebar.tsx` — Events + Trips buttons
- Modify: `sherlock/desktop/src/App.tsx` — `eventsMode` + `tripsMode` state

- [ ] **Step 1: Add types + API**

In `types.ts`:
```ts
export type SuggestedName = {
  eventId: number;
  suggested: string;
};
```

In `api.ts`:
```ts
export async function suggestEventNames(): Promise<SuggestedName[]> {
  return invoke<SuggestedName[]>("suggest_event_names_cmd");
}
```
Also add `SuggestedName` to the import list at the top of `api.ts`.

- [ ] **Step 2: Create `EventsView.tsx`**

```tsx
import { useEffect, useState } from "react";
import { listEvents, recomputeEvents, suggestEventNames } from "../../api";
import { errorMessage } from "../../utils/errorMessage";
import type { EventSummary } from "../../types";
import "./shared-tool-view.css";
import "./EventsView.css";

type Props = {
  onBack: () => void;
  onOpenEvent: (eventId: number) => void;
  onOrganize: () => void;
};

export default function EventsView({ onBack, onOpenEvent, onOrganize }: Props) {
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        let list = await listEvents();
        if (list.length === 0) list = await recomputeEvents();
        await suggestEventNames();
        list = await listEvents();
        setEvents(list);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="tool-view events-view">
      <div className="tool-toolbar">
        <div className="tool-toolbar-stats">
          <strong>{events.length}</strong> events detected
        </div>
        <button type="button" onClick={onOrganize} disabled={events.length === 0}>
          Organize…
        </button>
        <button type="button" onClick={onBack}>Close</button>
      </div>
      <div className="tool-body">
        {loading && <div className="tool-loading">Detecting events…</div>}
        {error && <div className="tool-empty">{error}</div>}
        {!loading && !error && events.length === 0 && (
          <div className="tool-empty">No events detected yet. Scan a library first.</div>
        )}
        <ul className="events-list">
          {events.map((e) => (
            <li key={e.id} className="event-card" onClick={() => onOpenEvent(e.id)}>
              <div className="event-name">{e.name}</div>
              <div className="event-meta">
                {new Date(e.startedAt * 1000).toLocaleDateString()} ·{" "}
                {e.fileCount} photo{e.fileCount !== 1 ? "s" : ""}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create `EventsView.css`**

```css
.events-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
}
.event-card {
  padding: 12px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  cursor: pointer;
}
.event-card:hover { background: var(--bg-hover); }
.event-name { font-weight: 600; margin-bottom: 4px; }
.event-meta { font-size: var(--font-size-sm); color: var(--text-secondary); }
```

- [ ] **Step 4: Create `TripsView.tsx`** (analogous to Events, trip-level)

```tsx
import { useEffect, useState } from "react";
import { listTrips, detectTrips } from "../../api";
import { errorMessage } from "../../utils/errorMessage";
import type { TripSummary } from "../../types";
import "./shared-tool-view.css";
import "./TripsView.css";

type Props = {
  onBack: () => void;
  onOpenTrip: (tripId: number) => void;
};

export default function TripsView({ onBack, onOpenTrip }: Props) {
  const [trips, setTrips] = useState<TripSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        let list = await listTrips();
        if (list.length === 0) list = await detectTrips();
        setTrips(list);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="tool-view trips-view">
      <div className="tool-toolbar">
        <div className="tool-toolbar-stats">
          <strong>{trips.length}</strong> trips detected
        </div>
        <button type="button" onClick={onBack}>Close</button>
      </div>
      <div className="tool-body">
        {loading && <div className="tool-loading">Detecting trips…</div>}
        {error && <div className="tool-empty">{error}</div>}
        {!loading && !error && trips.length === 0 && (
          <div className="tool-empty">No trips detected yet.</div>
        )}
        <ul className="trips-list">
          {trips.map((t) => (
            <li key={t.id} className="trip-card" onClick={() => onOpenTrip(t.id)}>
              <div className="trip-name">{t.name}</div>
              <div className="trip-meta">
                {new Date(t.startedAt * 1000).toLocaleDateString()} –{" "}
                {new Date(t.endedAt * 1000).toLocaleDateString()} ·{" "}
                {t.eventCount} event{t.eventCount !== 1 ? "s" : ""}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Create `TripsView.css`** (same grid, rename classes to `trip-*`)

```css
.trips-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
}
.trip-card {
  padding: 12px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  cursor: pointer;
}
.trip-card:hover { background: var(--bg-hover); }
.trip-name { font-weight: 600; margin-bottom: 4px; }
.trip-meta { font-size: var(--font-size-sm); color: var(--text-secondary); }
```

- [ ] **Step 6: Sidebar — add Events/Trips buttons**

In `Sidebar.tsx`, add props `onOpenEvents?` and `onOpenTrips?`. Add buttons after the existing Map button:
```tsx
{onOpenEvents && (
  <button type="button" className="sidebar-tool-btn" onClick={onOpenEvents}
    title="Browse auto-detected events (groups by time + location)">Events</button>
)}
{onOpenTrips && (
  <button type="button" className="sidebar-tool-btn" onClick={onOpenTrips}
    title="Browse auto-detected trips (multi-day event clusters)">Trips</button>
)}
```
Add both to the `(onOpenMap || onOpenEvents || onOpenTrips || ...)` visibility guard of the tools panel.

- [ ] **Step 7: Wire into `App.tsx`**

Add state + handlers (follow the pattern already used for `mapMode`):
```tsx
const [eventsMode, setEventsMode] = useState(false);
const [tripsMode, setTripsMode] = useState(false);

function enterEventsMode() {
  setMapMode(false); setDuplicatesMode(false); setFacesMode(false);
  setPdfPasswordsMode(false); setTripsMode(false); setBurstsMode(false);
  setEventsMode(true);
}
function enterTripsMode() {
  setMapMode(false); setDuplicatesMode(false); setFacesMode(false);
  setPdfPasswordsMode(false); setEventsMode(false); setBurstsMode(false);
  setTripsMode(true);
}
```
Add `setEventsMode(false)` + `setTripsMode(false)` to every existing mode-switch function (search for `setMapMode(false)` and add both next to it).

Add to subtitle useMemo:
```tsx
if (eventsMode) return "Events";
if (tripsMode) return "Trips";
```
and include both in the deps array.

Render tree, next to MapView branch:
```tsx
) : eventsMode ? (
  <EventsView
    onBack={() => setEventsMode(false)}
    onOpenEvent={(id) => {
      setQuery(`event:${id}`);
      setEventsMode(false);
    }}
    onOrganize={() => setOrganizeOpen(true)}
  />
) : tripsMode ? (
  <TripsView
    onBack={() => setTripsMode(false)}
    onOpenTrip={(id) => {
      setQuery(`trip:${id}`);
      setTripsMode(false);
    }}
  />
```
Import the two components at top of file.

Pass `onOpenEvents={enterEventsMode}` and `onOpenTrips={enterTripsMode}` to Sidebar.

> **Note:** `event:` and `trip:` query tokens are added in Task 10; for now these set a query that returns empty — that's fine for Phase B smoke testing.

- [ ] **Step 8: Build**

Run: `cd sherlock/desktop && npm run build` — expected clean tsc.

- [ ] **Step 9: Commit**

```bash
git add sherlock/desktop/src/components/Content/EventsView.* sherlock/desktop/src/components/Content/TripsView.* sherlock/desktop/src/components/Sidebar/Sidebar.tsx sherlock/desktop/src/App.tsx sherlock/desktop/src/api.ts sherlock/desktop/src/types.ts
git commit -m "feat(ui): EventsView + TripsView powered by clustering.rs"
```

---

# Phase C — Organize Wizard

## Task 7: Backend — build_organize_plan

**Files:**
- Modify: `sherlock/desktop/src-tauri/src/organize.rs` — add `build_organize_plan` + `OrganizePlan` types

- [ ] **Step 1: Add types and function**

Append to `organize.rs`:
```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeProposal {
    pub event_id: i64,
    pub folder_name: String,
    pub file_ids: Vec<i64>,
    pub file_paths: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizePlan {
    pub base_dir: String,
    pub proposals: Vec<OrganizeProposal>,
    pub unassigned_count: i64,
}

pub fn build_organize_plan(db_path: &Path, base_dir: &str) -> AppResult<OrganizePlan> {
    let conn = open_conn(db_path)?;
    let mut stmt = conn.prepare(
        r#"SELECT id, COALESCE(suggested_name, name) FROM events ORDER BY started_at"#,
    )?;
    let events: Vec<(i64, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    drop(stmt);

    let mut proposals = Vec::new();
    let mut assigned_ids: std::collections::HashSet<i64> = std::collections::HashSet::new();

    for (event_id, folder_name) in events {
        let mut st = conn.prepare(
            r#"SELECT f.id, f.path FROM files f
               JOIN event_files ef ON ef.file_id = f.id
               WHERE ef.event_id = ?1"#,
        )?;
        let rows: Vec<(i64, String)> = st
            .query_map(params![event_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        let file_ids: Vec<i64> = rows.iter().map(|(i, _)| *i).collect();
        let file_paths: Vec<String> = rows.iter().map(|(_, p)| p.clone()).collect();
        for id in &file_ids { assigned_ids.insert(*id); }
        proposals.push(OrganizeProposal {
            event_id,
            folder_name,
            file_ids,
            file_paths,
        });
    }

    let unassigned_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM files",
        [],
        |r| r.get::<_, i64>(0),
    )? - assigned_ids.len() as i64;

    Ok(OrganizePlan {
        base_dir: base_dir.to_string(),
        proposals,
        unassigned_count,
    })
}

#[tauri::command]
pub async fn build_organize_plan_cmd(
    base_dir: String,
    state: tauri::State<'_, crate::runtime::AppState>,
) -> Result<OrganizePlan, String> {
    let db = state.db_path.clone();
    tokio::task::spawn_blocking(move || build_organize_plan(&db, &base_dir))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}
```

Register `organize::build_organize_plan_cmd` in `lib.rs` invoke_handler.

- [ ] **Step 2: Test against empty DB**

Append test:
```rust
#[test]
fn build_organize_plan_empty() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("t.db");
    init_db(&db).unwrap();
    let p = build_organize_plan(&db, "/tmp/out").unwrap();
    assert_eq!(p.proposals.len(), 0);
    assert_eq!(p.unassigned_count, 0);
}
```

Run: `cargo test build_organize_plan_empty` — pass.

- [ ] **Step 3: Commit**

```bash
git add sherlock/desktop/src-tauri/src/organize.rs sherlock/desktop/src-tauri/src/lib.rs
git commit -m "feat(organize): build_organize_plan enumerates event folders"
```

---

## Task 8: Backend — execute_organize_plan (atomic move/copy)

**Files:**
- Modify: `sherlock/desktop/src-tauri/src/organize.rs` — execute engine

- [ ] **Step 1: Add types + function**

Append:
```rust
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeRequest {
    pub base_dir: String,
    pub mode: String, // "copy" or "move"
    pub proposals: Vec<OrganizeProposalInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeProposalInput {
    pub folder_name: String,
    pub file_ids: Vec<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeResult {
    pub processed: i64,
    pub skipped: i64,
    pub errors: Vec<String>,
}

pub fn execute_organize_plan(db_path: &Path, req: &OrganizeRequest) -> AppResult<OrganizeResult> {
    use std::fs;
    let base = std::path::PathBuf::from(&req.base_dir);
    fs::create_dir_all(&base)?;

    let mut conn = open_conn(db_path)?;
    let tx = conn.transaction()?;
    let mut processed = 0i64;
    let mut skipped = 0i64;
    let mut errors: Vec<String> = Vec::new();
    let mut rollback: Vec<(std::path::PathBuf, std::path::PathBuf)> = Vec::new();

    for p in &req.proposals {
        let folder = base.join(sanitize_folder(&p.folder_name));
        fs::create_dir_all(&folder)?;
        for id in &p.file_ids {
            let src: String = match tx.query_row(
                "SELECT path FROM files WHERE id = ?1",
                params![id],
                |r| r.get(0),
            ) {
                Ok(s) => s,
                Err(_) => { skipped += 1; continue; }
            };
            let src_pb = std::path::PathBuf::from(&src);
            let fname = match src_pb.file_name() {
                Some(n) => n.to_os_string(),
                None => { skipped += 1; continue; }
            };
            let dst = folder.join(&fname);
            if dst.exists() { skipped += 1; continue; }

            let r = if req.mode == "copy" {
                fs::copy(&src_pb, &dst).map(|_| ())
            } else {
                fs::rename(&src_pb, &dst)
            };
            match r {
                Ok(()) => {
                    if req.mode == "move" {
                        let new_path = dst.to_string_lossy().to_string();
                        tx.execute(
                            "UPDATE files SET path = ?1 WHERE id = ?2",
                            params![new_path, id],
                        )?;
                        rollback.push((src_pb, dst.clone()));
                    }
                    processed += 1;
                }
                Err(e) => errors.push(format!("{}: {}", src, e)),
            }
        }
    }

    if !errors.is_empty() && req.mode == "move" {
        // Best-effort rollback
        for (orig, moved) in rollback.iter().rev() {
            let _ = fs::rename(moved, orig);
        }
        return Err(crate::error::AppError::Other(format!(
            "organize failed, rolled back: {}", errors.join("; ")
        )));
    }

    tx.commit()?;
    Ok(OrganizeResult { processed, skipped, errors })
}

fn sanitize_folder(name: &str) -> String {
    name.chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .collect()
}

#[tauri::command]
pub async fn execute_organize_plan_cmd(
    req: OrganizeRequest,
    state: tauri::State<'_, crate::runtime::AppState>,
) -> Result<OrganizeResult, String> {
    let db = state.db_path.clone();
    tokio::task::spawn_blocking(move || execute_organize_plan(&db, &req))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}
```

> **Note:** The exact variant name for `AppError` varies — if `AppError::Other` doesn't exist, check `error.rs` and use whatever the "generic string error" variant is (commonly `AppError::Msg` or `AppError::Generic`). If none exists, construct an `anyhow` equivalent or add one.

Register `organize::execute_organize_plan_cmd` in `lib.rs`.

- [ ] **Step 2: Add unit test for sanitize_folder**

```rust
#[test]
fn sanitize_folder_strips_fs_reserved() {
    assert_eq!(sanitize_folder("2024-07 Beach/Trip"), "2024-07 Beach_Trip");
    assert_eq!(sanitize_folder("a:b*c?d"), "a_b_c_d");
}
```

Run: `cargo test sanitize_folder_strips_fs_reserved` — pass.

- [ ] **Step 3: Integration test for execute with empty plan**

```rust
#[test]
fn execute_organize_empty_plan_ok() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("t.db");
    init_db(&db).unwrap();
    let req = OrganizeRequest {
        base_dir: dir.path().join("out").to_string_lossy().to_string(),
        mode: "copy".into(),
        proposals: vec![],
    };
    let r = execute_organize_plan(&db, &req).unwrap();
    assert_eq!(r.processed, 0);
}
```

Run: pass.

- [ ] **Step 4: Commit**

```bash
git add sherlock/desktop/src-tauri/src/organize.rs sherlock/desktop/src-tauri/src/lib.rs
git commit -m "feat(organize): atomic execute_organize_plan with rollback"
```

---

## Task 9: Frontend — OrganizeWizard modal

**Files:**
- Create: `sherlock/desktop/src/components/modals/OrganizeWizard.tsx`
- Create: `sherlock/desktop/src/components/modals/OrganizeWizard.css`
- Modify: `sherlock/desktop/src/api.ts` + `types.ts` — wire commands
- Modify: `sherlock/desktop/src/App.tsx` — add `organizeOpen` state and render

- [ ] **Step 1: Types + API**

`types.ts`:
```ts
export type OrganizeProposal = {
  eventId: number;
  folderName: string;
  fileIds: number[];
  filePaths: string[];
};
export type OrganizePlan = {
  baseDir: string;
  proposals: OrganizeProposal[];
  unassignedCount: number;
};
export type OrganizeRequest = {
  baseDir: string;
  mode: "copy" | "move";
  proposals: { folderName: string; fileIds: number[] }[];
};
export type OrganizeResult = {
  processed: number;
  skipped: number;
  errors: string[];
};
```

`api.ts`:
```ts
export async function buildOrganizePlan(baseDir: string): Promise<OrganizePlan> {
  return invoke<OrganizePlan>("build_organize_plan_cmd", { baseDir });
}
export async function executeOrganizePlan(req: OrganizeRequest): Promise<OrganizeResult> {
  return invoke<OrganizeResult>("execute_organize_plan_cmd", { req });
}
```

Add to the type imports at top.

- [ ] **Step 2: Create `OrganizeWizard.tsx`**

```tsx
import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import ModalOverlay from "./ModalOverlay";
import { buildOrganizePlan, executeOrganizePlan } from "../../api";
import { errorMessage } from "../../utils/errorMessage";
import type { OrganizePlan, OrganizeResult } from "../../types";
import "./shared-modal.css";
import "./OrganizeWizard.css";

type Props = { onClose: () => void };
type Stage = "pick" | "review" | "running" | "done";

export default function OrganizeWizard({ onClose }: Props) {
  const [stage, setStage] = useState<Stage>("pick");
  const [baseDir, setBaseDir] = useState<string>("");
  const [plan, setPlan] = useState<OrganizePlan | null>(null);
  const [mode, setMode] = useState<"copy" | "move">("copy");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OrganizeResult | null>(null);
  const [rename, setRename] = useState<Record<number, string>>({});
  const [skip, setSkip] = useState<Set<number>>(new Set());

  async function pickFolder() {
    const folder = await openDialog({ directory: true, multiple: false });
    if (typeof folder !== "string") return;
    setBaseDir(folder);
    try {
      const p = await buildOrganizePlan(folder);
      setPlan(p);
      setStage("review");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function runExecute() {
    if (!plan) return;
    setStage("running");
    try {
      const req = {
        baseDir,
        mode,
        proposals: plan.proposals
          .filter((p) => !skip.has(p.eventId))
          .map((p) => ({
            folderName: rename[p.eventId] ?? p.folderName,
            fileIds: p.fileIds,
          })),
      };
      const r = await executeOrganizePlan(req);
      setResult(r);
      setStage("done");
    } catch (err) {
      setError(errorMessage(err));
      setStage("review");
    }
  }

  return (
    <ModalOverlay onBackdropClick={onClose}>
      <div className="modal-base organize-wizard" onClick={(e) => e.stopPropagation()}>
        <h3>Organize by Events</h3>

        {stage === "pick" && (
          <>
            <p>Pick a destination folder. Frank Sherlock will suggest a folder per event based on AI-detected tags, location, and dates.</p>
            <button type="button" onClick={pickFolder}>Choose folder…</button>
          </>
        )}

        {stage === "review" && plan && (
          <>
            <p>Destination: <code>{baseDir}</code></p>
            <p>
              <label>
                <input type="radio" checked={mode === "copy"} onChange={() => setMode("copy")} />
                Copy (safe — originals stay)
              </label>{" "}
              <label>
                <input type="radio" checked={mode === "move"} onChange={() => setMode("move")} />
                Move (faster, atomic with DB)
              </label>
            </p>
            <div className="organize-list">
              {plan.proposals.map((p) => (
                <div key={p.eventId} className={`organize-row ${skip.has(p.eventId) ? "skipped" : ""}`}>
                  <input
                    type="checkbox"
                    checked={!skip.has(p.eventId)}
                    onChange={(e) => {
                      const next = new Set(skip);
                      if (e.target.checked) next.delete(p.eventId); else next.add(p.eventId);
                      setSkip(next);
                    }}
                  />
                  <input
                    type="text"
                    value={rename[p.eventId] ?? p.folderName}
                    onChange={(e) => setRename({ ...rename, [p.eventId]: e.target.value })}
                  />
                  <span className="organize-count">{p.fileIds.length} files</span>
                </div>
              ))}
            </div>
            {plan.unassignedCount > 0 && (
              <p className="organize-note">{plan.unassignedCount} files not in any event will stay in place.</p>
            )}
            <div className="modal-actions">
              <button type="button" onClick={onClose}>Cancel</button>
              <button type="button" onClick={runExecute}>Execute ({mode})</button>
            </div>
          </>
        )}

        {stage === "running" && <p>Organizing…</p>}

        {stage === "done" && result && (
          <>
            <h4>Done</h4>
            <p>Processed: <strong>{result.processed}</strong> · Skipped: {result.skipped}</p>
            {result.errors.length > 0 && (
              <details>
                <summary>{result.errors.length} errors</summary>
                <ul>{result.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
              </details>
            )}
            <div className="modal-actions">
              <button type="button" onClick={onClose}>Close</button>
            </div>
          </>
        )}

        {error && <div className="organize-error">{error}</div>}
      </div>
    </ModalOverlay>
  );
}
```

- [ ] **Step 3: Create `OrganizeWizard.css`**

```css
.organize-wizard { max-width: 720px; width: 90vw; max-height: 80vh; overflow-y: auto; }
.organize-list { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; }
.organize-row { display: flex; align-items: center; gap: 8px; padding: 6px; border: 1px solid var(--border-primary); border-radius: var(--radius-sm); }
.organize-row.skipped { opacity: 0.5; }
.organize-row input[type="text"] { flex: 1; padding: 4px 8px; }
.organize-count { font-size: var(--font-size-sm); color: var(--text-secondary); white-space: nowrap; }
.organize-note { font-size: var(--font-size-sm); color: var(--text-secondary); }
.organize-error { color: var(--danger); margin-top: 12px; }
```

- [ ] **Step 4: Wire into App.tsx**

Add at top:
```tsx
import OrganizeWizard from "./components/modals/OrganizeWizard";
```

Add state:
```tsx
const [organizeOpen, setOrganizeOpen] = useState(false);
```

In render tree (near other modals):
```tsx
{organizeOpen && <OrganizeWizard onClose={() => setOrganizeOpen(false)} />}
```

- [ ] **Step 5: Build**

Run: `cd sherlock/desktop && npm run build` — clean tsc.

- [ ] **Step 6: Commit**

```bash
git add sherlock/desktop/src/components/modals/OrganizeWizard.* sherlock/desktop/src/api.ts sherlock/desktop/src/types.ts sherlock/desktop/src/App.tsx
git commit -m "feat(ui): OrganizeWizard modal with analyze→review→execute flow"
```

---

## Task 10: Query tokens `event:<id>` and `trip:<id>`

**Files:**
- Modify: `sherlock/desktop/src-tauri/src/query_parser.rs` — parse `event:` + `trip:`
- Modify: `sherlock/desktop/src-tauri/src/filters.rs` — apply WHERE clause

- [ ] **Step 1: Parser — add event and trip token handling**

In `query_parser.rs`, find where `album:` is parsed (search `"album:"`). Add analogous arms:
```rust
} else if let Some(rest) = tok.strip_prefix("event:") {
    if let Ok(id) = rest.parse::<i64>() { filters.event_id = Some(id); }
} else if let Some(rest) = tok.strip_prefix("trip:") {
    if let Ok(id) = rest.parse::<i64>() { filters.trip_id = Some(id); }
}
```

Add fields to the filters struct (same file or `filters.rs` where the struct lives):
```rust
pub event_id: Option<i64>,
pub trip_id: Option<i64>,
```
Initialize them to `None` in the default/new constructor.

- [ ] **Step 2: Apply in SQL builder**

In `filters.rs` WHERE-clause assembly:
```rust
if let Some(id) = filters.event_id {
    where_clauses.push("id IN (SELECT file_id FROM event_files WHERE event_id = ?)".into());
    params.push(Box::new(id));
}
if let Some(id) = filters.trip_id {
    where_clauses.push(
        "id IN (SELECT file_id FROM event_files ef JOIN events e ON e.id = ef.event_id WHERE e.trip_id = ?)".into()
    );
    params.push(Box::new(id));
}
```

> **Note:** Match the real `event_files`/`events` member column names used by your migrations. If `events.trip_id` doesn't exist, check migration that creates the trips table — the column may be in a join table.

- [ ] **Step 3: Build**

Run: `cargo build` — clean.

- [ ] **Step 4: Commit**

```bash
git add sherlock/desktop/src-tauri/src/query_parser.rs sherlock/desktop/src-tauri/src/filters.rs
git commit -m "feat(search): event: and trip: query tokens filter by cluster membership"
```

---

# Phase D — Burst review

## Task 11: Backend — pick best-of-burst

**Files:**
- Modify: `sherlock/desktop/src-tauri/src/clustering.rs` — extend `find_bursts` (or add a new command `find_bursts_with_best`)

- [ ] **Step 1: Add `BurstWithBest` type and enrichment**

Append to `clustering.rs`:
```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BurstWithBest {
    pub best_file_id: i64,
    pub member_ids: Vec<i64>,
    pub reason: String,
}

pub fn find_bursts_with_best(db_path: &Path) -> AppResult<Vec<BurstWithBest>> {
    let conn = open_conn(db_path)?;
    let bursts = _find_bursts(&conn)?;
    let mut out = Vec::with_capacity(bursts.len());
    for b in bursts {
        let ids_csv = b.member_ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");
        let sql = format!(
            r#"SELECT id, COALESCE(blur_score, 999999.0) FROM files
               WHERE id IN ({}) ORDER BY blur_score ASC NULLS LAST LIMIT 1"#,
            ids_csv
        );
        let best: i64 = conn.query_row(&sql, [], |r| r.get::<_, i64>(0)).unwrap_or(b.cover_file_id);
        out.push(BurstWithBest {
            best_file_id: best,
            member_ids: b.member_ids,
            reason: "sharpest (lowest blur_score)".into(),
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn find_bursts_with_best_cmd(
    state: tauri::State<'_, crate::runtime::AppState>,
) -> Result<Vec<BurstWithBest>, String> {
    let db = state.db_path.clone();
    tokio::task::spawn_blocking(move || find_bursts_with_best(&db))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}
```

Register `clustering::find_bursts_with_best_cmd` in `lib.rs`.

- [ ] **Step 2: Build**

Run: `cargo build` — clean.

- [ ] **Step 3: Commit**

```bash
git add sherlock/desktop/src-tauri/src/clustering.rs sherlock/desktop/src-tauri/src/lib.rs
git commit -m "feat(bursts): find_bursts_with_best picks sharpest per burst"
```

---

## Task 12: Frontend — BurstReviewView

**Files:**
- Create: `sherlock/desktop/src/components/Content/BurstReviewView.tsx` + `.css`
- Modify: `api.ts` + `types.ts` — add `findBurstsWithBest` + `BurstWithBest`
- Modify: Sidebar + App.tsx — add Bursts mode

- [ ] **Step 1: Types + API**

`types.ts`:
```ts
export type BurstWithBest = {
  bestFileId: number;
  memberIds: number[];
  reason: string;
};
```

`api.ts`:
```ts
export async function findBurstsWithBest(): Promise<BurstWithBest[]> {
  return invoke<BurstWithBest[]>("find_bursts_with_best_cmd");
}
```

- [ ] **Step 2: Create `BurstReviewView.tsx`**

```tsx
import { useEffect, useState } from "react";
import { findBurstsWithBest, deleteFiles } from "../../api";
import { errorMessage } from "../../utils/errorMessage";
import type { BurstWithBest } from "../../types";
import "./shared-tool-view.css";
import "./BurstReviewView.css";

type Props = { onBack: () => void };

export default function BurstReviewView({ onBack }: Props) {
  const [bursts, setBursts] = useState<BurstWithBest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [keep, setKeep] = useState<Record<number, number>>({}); // burstIdx -> chosen file id

  useEffect(() => {
    (async () => {
      try {
        const list = await findBurstsWithBest();
        setBursts(list);
        const def: Record<number, number> = {};
        list.forEach((b, i) => { def[i] = b.bestFileId; });
        setKeep(def);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function deleteOthers() {
    const toDelete: number[] = [];
    bursts.forEach((b, i) => {
      b.memberIds.forEach((id) => { if (id !== keep[i]) toDelete.push(id); });
    });
    if (toDelete.length === 0) return;
    if (!confirm(`Delete ${toDelete.length} burst duplicates (not the ones you marked keep)?`)) return;
    try {
      await deleteFiles(toDelete);
      const refreshed = await findBurstsWithBest();
      setBursts(refreshed);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="tool-view bursts-view">
      <div className="tool-toolbar">
        <div className="tool-toolbar-stats">
          <strong>{bursts.length}</strong> burst{bursts.length !== 1 ? "s" : ""} detected
        </div>
        <button type="button" onClick={deleteOthers} disabled={bursts.length === 0}>
          Delete non-keepers
        </button>
        <button type="button" onClick={onBack}>Close</button>
      </div>
      <div className="tool-body">
        {loading && <div className="tool-loading">Analyzing bursts…</div>}
        {error && <div className="tool-empty">{error}</div>}
        {!loading && !error && bursts.length === 0 && (
          <div className="tool-empty">No bursts found (need ≥3 shots &lt;2s apart).</div>
        )}
        {bursts.map((b, i) => (
          <div key={i} className="burst-card">
            <div className="burst-header">
              AI picked <strong>file {b.bestFileId}</strong> ({b.reason})
            </div>
            <div className="burst-members">
              {b.memberIds.map((id) => (
                <label key={id} className={`burst-pick ${keep[i] === id ? "chosen" : ""}`}>
                  <input
                    type="radio"
                    name={`burst-${i}`}
                    checked={keep[i] === id}
                    onChange={() => setKeep({ ...keep, [i]: id })}
                  />
                  <img src={`thumb://${id}`} alt="" />
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

> **Note:** Confirm the actual thumbnail URL scheme used in the codebase (check `ImageTile.tsx`). If it's not `thumb://{id}`, swap in the real one.

- [ ] **Step 3: Create `BurstReviewView.css`**

```css
.burst-card { margin-bottom: 16px; padding: 10px; border: 1px solid var(--border-primary); border-radius: var(--radius-md); }
.burst-header { margin-bottom: 8px; font-size: var(--font-size-sm); color: var(--text-secondary); }
.burst-members { display: flex; gap: 8px; flex-wrap: wrap; }
.burst-pick { cursor: pointer; border: 3px solid transparent; border-radius: var(--radius-sm); }
.burst-pick.chosen { border-color: var(--accent); }
.burst-pick input { display: none; }
.burst-pick img { width: 120px; height: 120px; object-fit: cover; display: block; }
```

- [ ] **Step 4: Wire into Sidebar + App.tsx**

Sidebar: add `onOpenBursts?: () => void` prop and a "Bursts" button next to "Events".

App.tsx: add `const [burstsMode, setBurstsMode] = useState(false);`, a matching `enterBurstsMode()` helper that clears all other modes, and `setBurstsMode(false)` in every existing mode-switch. Subtitle: `if (burstsMode) return "Bursts";`. Render tree: `) : burstsMode ? <BurstReviewView onBack={() => setBurstsMode(false)} /> : ...`.

- [ ] **Step 5: Build**

Run: `npm run build` — clean.

- [ ] **Step 6: Commit**

```bash
git add sherlock/desktop/src/components/Content/BurstReviewView.* sherlock/desktop/src/api.ts sherlock/desktop/src/types.ts sherlock/desktop/src/components/Sidebar/Sidebar.tsx sherlock/desktop/src/App.tsx
git commit -m "feat(ui): BurstReviewView lets user keep AI-picked sharpest shot"
```

---

# Phase E — Batch rename by template

## Task 13: Backend — rename_by_template

**Files:**
- Modify: `sherlock/desktop/src-tauri/src/organize.rs` — rename engine

- [ ] **Step 1: Add rename function**

Append to `organize.rs`:
```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameRequest {
    pub file_ids: Vec<i64>,
    pub template: String, // e.g. "{date_taken:%Y-%m-%d}_{event_name}_{counter:03}"
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameResult {
    pub processed: i64,
    pub errors: Vec<String>,
}

pub fn rename_by_template(db_path: &Path, req: &RenameRequest) -> AppResult<RenameResult> {
    use std::fs;
    let mut conn = open_conn(db_path)?;
    let tx = conn.transaction()?;
    let mut processed = 0i64;
    let mut errors: Vec<String> = Vec::new();

    for (i, id) in req.file_ids.iter().enumerate() {
        let (path_str, date_taken, event_name): (String, Option<i64>, Option<String>) = match tx.query_row(
            r#"SELECT f.path, f.date_taken,
                 (SELECT e.suggested_name FROM events e
                  JOIN event_files ef ON ef.event_id = e.id
                  WHERE ef.file_id = f.id LIMIT 1)
               FROM files f WHERE f.id = ?1"#,
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ) { Ok(x) => x, Err(_) => { errors.push(format!("id {} not found", id)); continue; } };

        let p = std::path::PathBuf::from(&path_str);
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_string();
        let dir = p.parent().map(|d| d.to_path_buf()).unwrap_or_default();

        let new_stem = render_template(&req.template, date_taken, event_name.as_deref(), i);
        let new_name = if ext.is_empty() { new_stem } else { format!("{}.{}", new_stem, ext) };
        let new_path = dir.join(&new_name);
        if new_path == p { continue; }

        match fs::rename(&p, &new_path) {
            Ok(()) => {
                tx.execute(
                    "UPDATE files SET path = ?1 WHERE id = ?2",
                    params![new_path.to_string_lossy().to_string(), id],
                )?;
                processed += 1;
            }
            Err(e) => errors.push(format!("{}: {}", path_str, e)),
        }
    }
    tx.commit()?;
    Ok(RenameResult { processed, errors })
}

fn render_template(t: &str, date_taken: Option<i64>, event: Option<&str>, counter: usize) -> String {
    let mut out = t.to_string();

    // {date_taken:FMT}
    if let Some(ts) = date_taken {
        if let Some(dt) = chrono::DateTime::<chrono::Utc>::from_timestamp(ts, 0) {
            while let Some(start) = out.find("{date_taken:") {
                if let Some(end) = out[start..].find('}') {
                    let fmt = &out[start + 12..start + end];
                    let rendered = dt.format(fmt).to_string();
                    out.replace_range(start..start + end + 1, &rendered);
                } else { break; }
            }
        }
    }
    out = out.replace("{event_name}", event.unwrap_or("event"));

    // {counter:03}
    while let Some(start) = out.find("{counter:") {
        if let Some(end) = out[start..].find('}') {
            let pad: usize = out[start + 9..start + end].parse().unwrap_or(0);
            let rendered = format!("{:0>width$}", counter + 1, width = pad);
            out.replace_range(start..start + end + 1, &rendered);
        } else { break; }
    }
    out = out.replace("{counter}", &(counter + 1).to_string());

    crate::organize::sanitize_folder(&out)
}

#[tauri::command]
pub async fn rename_by_template_cmd(
    req: RenameRequest,
    state: tauri::State<'_, crate::runtime::AppState>,
) -> Result<RenameResult, String> {
    let db = state.db_path.clone();
    tokio::task::spawn_blocking(move || rename_by_template(&db, &req))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}
```

Register `organize::rename_by_template_cmd` in `lib.rs`.

- [ ] **Step 2: Test template rendering**

```rust
#[test]
fn render_template_basic() {
    let dt = Some(1720000000); // 2024-07-03
    let r = render_template("{date_taken:%Y-%m-%d}_{event_name}_{counter:03}", dt, Some("Beach"), 4);
    assert_eq!(r, "2024-07-03_Beach_005");
}

#[test]
fn render_template_no_date() {
    let r = render_template("{event_name}_{counter}", None, None, 0);
    assert_eq!(r, "event_1");
}
```

Run: `cargo test render_template` — both pass.

- [ ] **Step 3: Commit**

```bash
git add sherlock/desktop/src-tauri/src/organize.rs sherlock/desktop/src-tauri/src/lib.rs
git commit -m "feat(organize): rename_by_template with date/event/counter placeholders"
```

---

## Task 14: Frontend — rename modal (simple)

**Files:**
- Create: `sherlock/desktop/src/components/modals/RenameModal.tsx` + `.css`
- Modify: `api.ts` + `types.ts`
- Modify: `ContextMenu.tsx` — add "Batch rename…" when selection > 1

- [ ] **Step 1: Types + API**

`types.ts`:
```ts
export type RenameRequest = { fileIds: number[]; template: string };
export type RenameResult = { processed: number; errors: string[] };
```

`api.ts`:
```ts
export async function renameByTemplate(req: RenameRequest): Promise<RenameResult> {
  return invoke<RenameResult>("rename_by_template_cmd", { req });
}
```

- [ ] **Step 2: Create `RenameModal.tsx`**

```tsx
import { useState } from "react";
import ModalOverlay from "./ModalOverlay";
import { renameByTemplate } from "../../api";
import { errorMessage } from "../../utils/errorMessage";
import "./shared-modal.css";

type Props = { fileIds: number[]; onClose: () => void };

export default function RenameModal({ fileIds, onClose }: Props) {
  const [template, setTemplate] = useState("{date_taken:%Y-%m-%d}_{event_name}_{counter:03}");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const r = await renameByTemplate({ fileIds, template });
      setStatus(`Renamed ${r.processed}${r.errors.length ? `, ${r.errors.length} errors` : ""}`);
    } catch (err) {
      setStatus(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalOverlay onBackdropClick={onClose}>
      <div className="modal-base" onClick={(e) => e.stopPropagation()}>
        <h3>Batch rename ({fileIds.length} files)</h3>
        <p>Template placeholders:</p>
        <ul>
          <li><code>{`{date_taken:%Y-%m-%d}`}</code> — date (strftime)</li>
          <li><code>{`{event_name}`}</code> — suggested event name</li>
          <li><code>{`{counter:03}`}</code> — sequential padded</li>
        </ul>
        <input
          type="text"
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          style={{ width: "100%", padding: "6px 8px" }}
        />
        {status && <p>{status}</p>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Close</button>
          <button type="button" onClick={run} disabled={busy}>Run</button>
        </div>
      </div>
    </ModalOverlay>
  );
}
```

- [ ] **Step 3: Wire into ContextMenu + App.tsx**

`ContextMenu.tsx`:
Add prop `onBatchRename?: () => void;`. In the button list, when `selectedCount > 1`:
```tsx
{selectedCount > 1 && onBatchRename && (
  <button className="context-menu-item" role="menuitem" onClick={onBatchRename}>
    <span>Batch rename…</span>
  </button>
)}
```

`App.tsx`:
```tsx
import RenameModal from "./components/modals/RenameModal";
const [renameIds, setRenameIds] = useState<number[] | null>(null);
```
ContextMenu JSX: `onBatchRename={() => setRenameIds([...selectedFileIds])}` (use whatever variable holds the selected file ids — usually derived from `selectedIndices` + `items`).

Render:
```tsx
{renameIds && <RenameModal fileIds={renameIds} onClose={() => setRenameIds(null)} />}
```

- [ ] **Step 4: Build**

Run: `npm run build` — clean.

- [ ] **Step 5: Commit**

```bash
git add sherlock/desktop/src/components/modals/RenameModal.tsx sherlock/desktop/src/components/Content/ContextMenu.tsx sherlock/desktop/src/App.tsx sherlock/desktop/src/api.ts sherlock/desktop/src/types.ts
git commit -m "feat(ui): RenameModal batch-renames selection via template"
```

---

# Phase F — Resumable face scan

> **Current state:** face detection already persists per-file via `files.face_count` (0 = not scanned, -1 = scanned no-faces, >0 = faces). Crash safety for the per-file update works. **What's missing:** (1) a job-checkpoint row so the app knows a scan was in progress and can auto-resume on startup, (2) incremental clustering so clustering results aren't lost when the run crashes mid-way.

## Task 15: Backend — face scan job checkpoint table

**Files:**
- Modify: `sherlock/desktop/src-tauri/src/db.rs` — migration 24 + checkpoint CRUD

- [ ] **Step 1: Add migration 24**

Append to the `migrations()` vec in `db.rs`:
```rust
M::up(r#"
    CREATE TABLE IF NOT EXISTS face_scan_jobs (
        root_id INTEGER PRIMARY KEY,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        total INTEGER NOT NULL DEFAULT 0,
        processed INTEGER NOT NULL DEFAULT 0,
        faces_found INTEGER NOT NULL DEFAULT 0,
        last_file_id INTEGER
    );
"#),
```

Update both schema-version asserts in the two tests from `24` to `25`.

- [ ] **Step 2: Add CRUD helpers**

Append to `db.rs`:
```rust
pub fn face_scan_job_start(db_path: &Path, root_id: i64, total: i64) -> AppResult<()> {
    let conn = open_conn(db_path)?;
    let now = chrono::Utc::now().timestamp();
    conn.execute(
        r#"INSERT INTO face_scan_jobs (root_id, started_at, updated_at, total, processed, faces_found)
           VALUES (?1, ?2, ?2, ?3, 0, 0)
           ON CONFLICT(root_id) DO UPDATE SET
             started_at = excluded.started_at,
             updated_at = excluded.updated_at,
             total = excluded.total,
             processed = 0,
             faces_found = 0,
             last_file_id = NULL"#,
        params![root_id, now, total],
    )?;
    Ok(())
}

pub fn face_scan_job_tick(
    db_path: &Path,
    root_id: i64,
    processed: i64,
    faces_found: i64,
    last_file_id: i64,
) -> AppResult<()> {
    let conn = open_conn(db_path)?;
    conn.execute(
        r#"UPDATE face_scan_jobs
           SET updated_at = ?1, processed = ?2, faces_found = ?3, last_file_id = ?4
           WHERE root_id = ?5"#,
        params![chrono::Utc::now().timestamp(), processed, faces_found, last_file_id, root_id],
    )?;
    Ok(())
}

pub fn face_scan_job_clear(db_path: &Path, root_id: i64) -> AppResult<()> {
    let conn = open_conn(db_path)?;
    conn.execute("DELETE FROM face_scan_jobs WHERE root_id = ?1", params![root_id])?;
    Ok(())
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceScanJob {
    pub root_id: i64,
    pub started_at: i64,
    pub updated_at: i64,
    pub total: i64,
    pub processed: i64,
    pub faces_found: i64,
}

pub fn face_scan_jobs_list(db_path: &Path) -> AppResult<Vec<FaceScanJob>> {
    let conn = open_conn(db_path)?;
    let mut stmt = conn.prepare(
        r#"SELECT root_id, started_at, updated_at, total, processed, faces_found
           FROM face_scan_jobs ORDER BY updated_at DESC"#,
    )?;
    let rows: Vec<FaceScanJob> = stmt
        .query_map([], |r| Ok(FaceScanJob {
            root_id: r.get(0)?,
            started_at: r.get(1)?,
            updated_at: r.get(2)?,
            total: r.get(3)?,
            processed: r.get(4)?,
            faces_found: r.get(5)?,
        }))?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}
```

- [ ] **Step 3: Tests**

```rust
#[test]
fn face_scan_job_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("t.db");
    init_db(&db).unwrap();
    face_scan_job_start(&db, 1, 100).unwrap();
    face_scan_job_tick(&db, 1, 50, 12, 999).unwrap();
    let jobs = face_scan_jobs_list(&db).unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].processed, 50);
    assert_eq!(jobs[0].faces_found, 12);
    face_scan_job_clear(&db, 1).unwrap();
    assert!(face_scan_jobs_list(&db).unwrap().is_empty());
}
```

Run: `cargo test face_scan_job_roundtrip` — pass.

- [ ] **Step 4: Commit**

```bash
git add sherlock/desktop/src-tauri/src/db.rs
git commit -m "feat(db): migration 24 + face_scan_jobs checkpoint CRUD"
```

---

## Task 16: Wire checkpoint into run_face_detection + incremental clustering

**Files:**
- Modify: `sherlock/desktop/src-tauri/src/lib.rs` — `run_face_detection`

- [ ] **Step 1: Call `face_scan_job_start` before the loop**

Right after `let total = files.len() as u64;` and before the first progress assignment, add:
```rust
let _ = db::face_scan_job_start(db_path, root_id, total as i64);
```

- [ ] **Step 2: Call `face_scan_job_tick` at the end of each iteration**

Inside the `for file in &files` loop, after the existing `processed += 1;`, add:
```rust
let _ = db::face_scan_job_tick(
    db_path,
    root_id,
    processed as i64,
    faces_found as i64,
    file.id,
);
```

- [ ] **Step 3: Incremental clustering every 500 processed files**

Also inside the loop, right after the tick:
```rust
if processed % 500 == 0 && faces_found > 0 {
    if let Err(e) = db::cluster_faces(db_path, 0.30) {
        log::warn!("Incremental face clustering failed at {processed}: {e}");
    }
}
```

- [ ] **Step 4: Clear job on normal completion**

After the final `cluster_faces` block (after the loop), add:
```rust
let _ = db::face_scan_job_clear(db_path, root_id);
```

(Keep it outside the `if faces_found > 0` block so it clears even when no faces were found.)

- [ ] **Step 5: Build**

Run: `cd sherlock/desktop/src-tauri && cargo build` — clean.

- [ ] **Step 6: Commit**

```bash
git add sherlock/desktop/src-tauri/src/lib.rs
git commit -m "feat(face): checkpoint + incremental clustering every 500 files"
```

---

## Task 17: Frontend — detect unfinished scans on startup + resume

**Files:**
- Modify: `sherlock/desktop/src-tauri/src/lib.rs` — expose `list_face_scan_jobs_cmd`
- Modify: `sherlock/desktop/src/api.ts` + `types.ts`
- Modify: `sherlock/desktop/src/App.tsx` — on mount, query unfinished jobs; show resume toast

- [ ] **Step 1: Tauri command**

Append to `lib.rs` near other commands:
```rust
#[tauri::command]
async fn list_face_scan_jobs_cmd(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<db::FaceScanJob>, String> {
    let db_path = state.db_path.clone();
    tokio::task::spawn_blocking(move || db::face_scan_jobs_list(&db_path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}
```

Register `list_face_scan_jobs_cmd` in the `invoke_handler![...]` macro.

- [ ] **Step 2: Types + API**

`types.ts`:
```ts
export type FaceScanJob = {
  rootId: number;
  startedAt: number;
  updatedAt: number;
  total: number;
  processed: number;
  facesFound: number;
};
```

`api.ts`:
```ts
export async function listFaceScanJobs(): Promise<FaceScanJob[]> {
  return invoke<FaceScanJob[]>("list_face_scan_jobs_cmd");
}
```

- [ ] **Step 3: App.tsx — auto-resume check**

Find the existing `useEffect(() => { ... }, [])` that runs on mount (where initial scan / setup status loads). After the existing calls, add:
```tsx
listFaceScanJobs().then((jobs) => {
  if (jobs.length > 0) {
    const j = jobs[0];
    const pct = j.total > 0 ? Math.round((j.processed / j.total) * 100) : 0;
    setNotice(
      `Unfinished face scan detected (${j.processed}/${j.total} = ${pct}%). Click Faces → Scan to resume.`,
    );
  }
}).catch(() => {});
```

Import `listFaceScanJobs` at the top of the file.

> **Note:** Because `list_files_needing_face_scan` already skips files with `face_count != 0`, simply pressing "Scan" again resumes from where it stopped — no special resume command needed.

- [ ] **Step 4: Build**

Run: `cd sherlock/desktop && npm run build` — clean tsc.

- [ ] **Step 5: Commit**

```bash
git add sherlock/desktop/src-tauri/src/lib.rs sherlock/desktop/src/api.ts sherlock/desktop/src/types.ts sherlock/desktop/src/App.tsx
git commit -m "feat(face): surface unfinished scans on startup to enable resume"
```

---

# Phase G — Polish & ship

## Task 18: HelpModal docs

**Files:**
- Modify: `sherlock/desktop/src/components/modals/HelpModal.tsx`

- [ ] **Step 1: Document new tokens + features**

After the "Blur / focus" help section, insert:

```tsx
<div className="help-section">
  <h4>Event / Trip filter</h4>
  <div className="help-examples">
    <code>event:42</code>
    <code>trip:7 sunset</code>
  </div>
  <p className="help-note-inline">Open the Events or Trips tool to see cluster IDs.</p>
</div>
```

- [ ] **Step 2: Build + commit**

```bash
cd sherlock/desktop && npm run build
git add sherlock/desktop/src/components/modals/HelpModal.tsx
git commit -m "docs(help): document event: and trip: search tokens"
```

---

## Task 19: Release notes v0.18.0

**Files:**
- Create: `releases/v0.18.0.md`
- Modify: `sherlock/desktop/package.json` + `sherlock/desktop/src-tauri/tauri.conf.json` + `sherlock/desktop/src-tauri/Cargo.toml` — bump versions to `0.18.0`

- [ ] **Step 1: Bump versions**

Search for `"version": "0.17.0"` in all three files and replace with `0.18.0`. In `Cargo.toml` look for `version = "0.17.0"`.

- [ ] **Step 2: Write release notes**

```markdown
# Frank Sherlock v0.18.0 — Auto-Organize & AI Event Suggestions

## What's New

### Events & Trips (finally, UI!)
- **Events tool** in the sidebar browses auto-detected events (DBSCAN-lite by time + GPS gap > 6h)
- **Trips tool** groups events across multi-day travel (gap > 7 days)
- **AI-suggested event names** aggregate top location + top LLM tag + year-month: e.g. `2024-07 Praia Florianópolis`
- Click an event/trip card to filter the grid to just that cluster via `event:<id>` / `trip:<id>` tokens

### Organize Wizard
- **Analyze → Review → Execute** flow: picks a destination folder, shows suggested event folders, you rename / skip / merge, then Copy or Move
- **Atomic execution** — SQLite transaction + rename rollback: if any file fails, all prior moves revert and DB stays consistent
- **Move mode** also updates `files.path` in place — search keeps working after organization

### Burst Review
- New **Bursts** tool detects shot-bursts (≥3 shots within 2s, same camera)
- AI picks the sharpest shot (lowest `blur_score`) per burst
- You override with a radio click; "Delete non-keepers" bulk-removes the rest

### Batch Rename
- Right-click a selection of 2+ files → **Batch rename…**
- Template syntax: `{date_taken:%Y-%m-%d}_{event_name}_{counter:03}` (strftime + event + sequential counter)

### Resumable Face Scan
- Face detection now writes a **job checkpoint** per-file to the new `face_scan_jobs` table
- If the app crashes/closes mid-scan, the next launch shows a notice with progress (`Unfinished face scan detected (12340/60000 = 20%)`)
- Pressing "Scan" again on Faces picks up exactly where it left off — already-scanned files are skipped via `files.face_count != 0`
- **Incremental clustering** — instead of clustering only after the full run (previously all-or-nothing), clustering now runs every 500 files so partial results survive crashes

## Changes

### Backend
- **Migration 23** — `events.suggested_name TEXT`
- **Migration 24** — `face_scan_jobs` checkpoint table
- New commands: `suggest_event_names_cmd`, `build_organize_plan_cmd`, `execute_organize_plan_cmd`, `rename_by_template_cmd`, `find_bursts_with_best_cmd`, `list_face_scan_jobs_cmd`
- New module `organize.rs` — event-name suggestions + atomic move/copy engine + template rename
- **EXIF → mtime** — scan now applies `EXIF:DateTimeOriginal` to the OS file mtime via the `filetime` crate
- **Sort by `date_taken`** — new sort option; falls back to mtime when EXIF date is missing
- New query tokens: `event:<id>` and `trip:<id>`

### Frontend
- `EventsView`, `TripsView`, `BurstReviewView`, `OrganizeWizard`, `RenameModal` — all new
- `MapView` — pins now cluster natively via maplibre-gl (handles 100k+ GPS files smoothly)
- `Toolbar` — "Date taken" sort option
- `HelpModal` — documented `event:` and `trip:` tokens
- `ContextMenu` — "Batch rename…" appears when multiple files are selected

## Breaking Changes
- Database schema updated (migrations 23 + 24 applied on first launch)
```

- [ ] **Step 3: Commit**

```bash
git add releases/v0.18.0.md sherlock/desktop/package.json sherlock/desktop/src-tauri/tauri.conf.json sherlock/desktop/src-tauri/Cargo.toml
git commit -m "chore(release): v0.18.0"
```

- [ ] **Step 4: Full test pass**

Run:
```bash
cd sherlock/desktop/src-tauri && cargo test
cd ../ && npm run build
```

Both must be green before proceeding to PR.

- [ ] **Step 5: Push + PR**

```bash
git push -u origin feat/auto-organize
gh pr create --repo felvieira/FrankSherlock --base master --head feat/auto-organize \
  --title "feat: Auto-organize, AI event suggestions, burst review, batch rename (v0.18.0)" \
  --body "$(cat releases/v0.18.0.md)"
```

---

## Self-Review notes

**Spec coverage check:**
- EventsView ✅ (Task 6), TripsView ✅ (Task 6), BurstReviewView ✅ (Task 12)
- Organize wizard (analyze→review→execute, copy/move) ✅ (Tasks 7–9)
- AI suggested event names ✅ (Task 5)
- Map clustering ✅ (Task 3)
- EXIF mtime fix ✅ (Task 1)
- Sort by date_taken ✅ (Task 2)
- Batch rename by template ✅ (Tasks 13–14)
- Best-of-burst AI picker ✅ (Tasks 11–12)

**Type consistency:**
- `OrganizePlan.proposals: OrganizeProposal[]` matches backend
- `OrganizeRequest.proposals` uses a stripped-down shape (folderName + fileIds only) — backend input type `OrganizeProposalInput` matches
- `BurstWithBest` shape identical in both sides
- `SuggestedName` shape identical

**Known assumptions to verify during execution:**
- Column `event_files(event_id, file_id)` — verify actual name in migration that creates events
- `AppError::Other` variant — check `error.rs`
- Thumbnail URL scheme in `BurstReviewView` — check existing `ImageTile.tsx`
- `openDialog` import path `@tauri-apps/plugin-dialog` — check existing usage

Each of these has a `> **Note:**` callout in its task.
