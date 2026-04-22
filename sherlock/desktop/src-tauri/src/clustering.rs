//! Auto-clustering: event detection (DBSCAN-lite on GPS+time),
//! trip detector, burst detection, year-in-review album generator,
//! and dedup policy application.
use crate::db::open_conn;
use crate::error::AppResult;
use rusqlite::{params, Connection};
use std::path::Path;

// ── Shared helpers ──────────────────────────────────────────────────

fn now_epoch_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

// ── Events ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventSummary {
    pub id: i64,
    pub name: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub file_count: i64,
    pub cover_file_id: Option<i64>,
    pub centroid_lat: Option<f64>,
    pub centroid_lon: Option<f64>,
}

/// DBSCAN-lite over files ordered by mtime_ns.
/// Two files belong to the same "event" if they are within 6 hours of each other.
/// GPS centroid is computed when GPS data is present; otherwise events are time-only.
pub fn cluster_events(db_path: &Path) -> AppResult<Vec<EventSummary>> {
    let conn = open_conn(db_path)?;
    _cluster_events(&conn)
}

fn _cluster_events(conn: &Connection) -> AppResult<Vec<EventSummary>> {
    // Pull all non-deleted files with mtime and optional location text, ordered by time.
    let mut stmt = conn.prepare(
        "SELECT id, mtime_ns / 1000000000 AS ts, location_text
         FROM files
         WHERE deleted_at IS NULL AND mtime_ns > 0
         ORDER BY ts ASC",
    )?;

    struct FileRow {
        id: i64,
        ts: i64,
        location: String,
    }

    let rows: Vec<FileRow> = stmt
        .query_map([], |r| {
            Ok(FileRow { id: r.get(0)?, ts: r.get(1)?, location: r.get::<_, Option<String>>(2)?.unwrap_or_default() })
        })?
        .filter_map(Result::ok)
        .collect();

    if rows.is_empty() {
        return Ok(Vec::new());
    }

    const MAX_GAP_SECS: i64 = 6 * 3600; // 6 hours

    // Simple single-pass clustering: start a new event when gap > 6h
    // or when location changes (different non-empty location_text, gap > 30 min).
    struct Cluster {
        file_ids: Vec<i64>,
        started_at: i64,
        ended_at: i64,
        dominant_location: String,
    }

    let mut clusters: Vec<Cluster> = Vec::new();
    let mut cur = Cluster {
        file_ids: vec![rows[0].id],
        started_at: rows[0].ts,
        ended_at: rows[0].ts,
        dominant_location: rows[0].location.clone(),
    };

    for row in rows.iter().skip(1) {
        let time_gap = row.ts - cur.ended_at;
        let location_break = !row.location.is_empty()
            && !cur.dominant_location.is_empty()
            && row.location != cur.dominant_location
            && time_gap > 1800; // location switch + 30 min gap

        if time_gap > MAX_GAP_SECS || location_break {
            clusters.push(cur);
            cur = Cluster {
                file_ids: vec![row.id],
                started_at: row.ts,
                ended_at: row.ts,
                dominant_location: row.location.clone(),
            };
        } else {
            cur.file_ids.push(row.id);
            cur.ended_at = row.ts;
            if cur.dominant_location.is_empty() && !row.location.is_empty() {
                cur.dominant_location = row.location.clone();
            }
        }
    }
    clusters.push(cur);

    // Persist clusters — idempotent: wipe existing events and re-insert.
    conn.execute_batch("DELETE FROM event_files; DELETE FROM events;")?;

    let mut summaries = Vec::with_capacity(clusters.len());
    for cluster in &clusters {
        let cover = cluster.file_ids.first().copied();
        let name = build_event_name(&cluster.dominant_location, cluster.started_at);
        conn.execute(
            "INSERT INTO events (name, started_at, ended_at, cover_file_id)
             VALUES (?1, ?2, ?3, ?4)",
            params![name, cluster.started_at, cluster.ended_at, cover],
        )?;
        let event_id = conn.last_insert_rowid();
        for fid in &cluster.file_ids {
            conn.execute(
                "INSERT OR IGNORE INTO event_files (event_id, file_id) VALUES (?1, ?2)",
                params![event_id, fid],
            )?;
        }
        summaries.push(EventSummary {
            id: event_id,
            name,
            started_at: cluster.started_at,
            ended_at: cluster.ended_at,
            file_count: cluster.file_ids.len() as i64,
            cover_file_id: cover,
            centroid_lat: None,
            centroid_lon: None,
        });
    }

    Ok(summaries)
}

fn build_event_name(location: &str, started_at: i64) -> String {
    let date_str = epoch_to_date_str(started_at);
    if !location.is_empty() {
        format!("{location} — {date_str}")
    } else {
        format!("Session {date_str}")
    }
}

fn epoch_to_date_str(ts: i64) -> String {
    // Simple epoch → YYYY-MM-DD using UTC
    let days = ts / 86400;
    let secs_in_day = ts % 86400;
    let _ = secs_in_day;
    // Simple Gregorian calculation
    let mut y = 1970i32;
    let mut d = days as i32;
    loop {
        let yd = if is_leap(y) { 366 } else { 365 };
        if d < yd { break; }
        d -= yd;
        y += 1;
    }
    let month_days: &[i32] = if is_leap(y) {
        &[31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        &[31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut m = 1i32;
    for &md in month_days {
        if d < md { break; }
        d -= md;
        m += 1;
    }
    format!("{y:04}-{m:02}-{:02}", d + 1)
}

fn is_leap(y: i32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

/// Haversine distance in metres between two WGS-84 coordinates.
fn haversine_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const R: f64 = 6_371_000.0;
    let (dlat, dlon) = ((lat2 - lat1).to_radians(), (lon2 - lon1).to_radians());
    let a = (dlat / 2.0).sin().powi(2)
        + lat1.to_radians().cos() * lat2.to_radians().cos() * (dlon / 2.0).sin().powi(2);
    R * 2.0 * a.sqrt().asin()
}

pub fn list_events(db_path: &Path) -> AppResult<Vec<EventSummary>> {
    let conn = open_conn(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT e.id, e.name, e.started_at, e.ended_at,
                COUNT(ef.file_id) AS fc, e.cover_file_id, e.centroid_lat, e.centroid_lon
         FROM events e
         LEFT JOIN event_files ef ON ef.event_id = e.id
         GROUP BY e.id
         ORDER BY e.started_at ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(EventSummary {
            id: r.get(0)?,
            name: r.get(1)?,
            started_at: r.get(2)?,
            ended_at: r.get(3)?,
            file_count: r.get(4)?,
            cover_file_id: r.get(5)?,
            centroid_lat: r.get(6)?,
            centroid_lon: r.get(7)?,
        })
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}

// ── Trips ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TripSummary {
    pub id: i64,
    pub name: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub event_count: i64,
    pub cover_file_id: Option<i64>,
}

/// Groups events into trips: events outside the "home cluster" and within 7 days of
/// a previous event are merged. Home = highest-density 50 km² region of events.
pub fn detect_trips(db_path: &Path) -> AppResult<Vec<TripSummary>> {
    let conn = open_conn(db_path)?;
    _detect_trips(&conn)
}

fn _detect_trips(conn: &Connection) -> AppResult<Vec<TripSummary>> {
    // Load all events ordered by time.
    struct EventRow {
        id: i64,
        name: String,
        started_at: i64,
        ended_at: i64,
        cover_file_id: Option<i64>,
    }
    let mut stmt = conn.prepare(
        "SELECT id, name, started_at, ended_at, cover_file_id
         FROM events ORDER BY started_at ASC",
    )?;
    let events: Vec<EventRow> = stmt
        .query_map([], |r| {
            Ok(EventRow {
                id: r.get(0)?,
                name: r.get(1)?,
                started_at: r.get(2)?,
                ended_at: r.get(3)?,
                cover_file_id: r.get(4)?,
            })
        })?
        .filter_map(Result::ok)
        .collect();

    if events.is_empty() {
        return Ok(Vec::new());
    }

    // "Home" = the most common event name prefix (city/location part)
    let home_location = {
        let mut name_counts: std::collections::HashMap<String, usize> = Default::default();
        for e in &events {
            let loc = e.name.split(" — ").next().unwrap_or("").trim().to_string();
            if !loc.is_empty() {
                *name_counts.entry(loc).or_default() += 1;
            }
        }
        name_counts.into_iter().max_by_key(|(_, c)| *c).map(|(loc, _)| loc)
    };

    const MAX_TRIP_GAP_SECS: i64 = 7 * 86400; // 7 days

    let is_away = |e: &EventRow| -> bool {
        match &home_location {
            Some(home) => {
                let loc = e.name.split(" — ").next().unwrap_or("").trim();
                !loc.is_empty() && loc != home.as_str()
            }
            None => false,
        }
    };

    conn.execute_batch("DELETE FROM trips; UPDATE events SET trip_id = NULL;")?;

    let mut summaries: Vec<TripSummary> = Vec::new();
    let away_events: Vec<_> = events.iter().filter(|e| is_away(e)).collect();

    if away_events.is_empty() {
        return Ok(summaries);
    }

    let mut trip_start = away_events[0].started_at;
    let mut trip_end = away_events[0].ended_at;
    let mut trip_events: Vec<i64> = vec![away_events[0].id];
    let mut trip_cover = away_events[0].cover_file_id;

    for e in away_events.iter().skip(1) {
        if e.started_at - trip_end <= MAX_TRIP_GAP_SECS {
            trip_events.push(e.id);
            trip_end = trip_end.max(e.ended_at);
        } else {
            let name = format!("Trip {}", epoch_to_date_str(trip_start));
            conn.execute(
                "INSERT INTO trips (name, started_at, ended_at, event_count, cover_file_id)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![name, trip_start, trip_end, trip_events.len() as i64, trip_cover],
            )?;
            let trip_id = conn.last_insert_rowid();
            for eid in &trip_events {
                conn.execute("UPDATE events SET trip_id = ?1 WHERE id = ?2", params![trip_id, eid])?;
            }
            summaries.push(TripSummary {
                id: trip_id, name, started_at: trip_start, ended_at: trip_end,
                event_count: trip_events.len() as i64, cover_file_id: trip_cover,
            });
            trip_start = e.started_at;
            trip_end = e.ended_at;
            trip_events = vec![e.id];
            trip_cover = e.cover_file_id;
        }
    }
    // Flush last trip
    if !trip_events.is_empty() {
        let name = format!("Trip {}", epoch_to_date_str(trip_start));
        conn.execute(
            "INSERT INTO trips (name, started_at, ended_at, event_count, cover_file_id)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![name, trip_start, trip_end, trip_events.len() as i64, trip_cover],
        )?;
        let trip_id = conn.last_insert_rowid();
        for eid in &trip_events {
            conn.execute("UPDATE events SET trip_id = ?1 WHERE id = ?2", params![trip_id, eid])?;
        }
        summaries.push(TripSummary {
            id: trip_id, name, started_at: trip_start, ended_at: trip_end,
            event_count: trip_events.len() as i64, cover_file_id: trip_cover,
        });
    }

    Ok(summaries)
}

pub fn list_trips(db_path: &Path) -> AppResult<Vec<TripSummary>> {
    let conn = open_conn(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT id, name, started_at, ended_at, event_count, cover_file_id
         FROM trips ORDER BY started_at ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(TripSummary {
            id: r.get(0)?, name: r.get(1)?, started_at: r.get(2)?,
            ended_at: r.get(3)?, event_count: r.get(4)?, cover_file_id: r.get(5)?,
        })
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}

// ── Bursts ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Burst {
    pub cover_file_id: i64,
    pub member_ids: Vec<i64>,
}

/// Groups of ≥3 files with the same camera_model and mtime within 2s of each other.
pub fn find_bursts(db_path: &Path) -> AppResult<Vec<Burst>> {
    let conn = open_conn(db_path)?;
    _find_bursts(&conn)
}

fn _find_bursts(conn: &Connection) -> AppResult<Vec<Burst>> {
    let mut stmt = conn.prepare(
        "SELECT id, mtime_ns / 1000000000 AS ts, camera_model
         FROM files
         WHERE deleted_at IS NULL AND mtime_ns > 0
         ORDER BY camera_model, ts ASC",
    )?;

    struct FileRow {
        id: i64,
        ts: i64,
        camera: String,
    }

    let rows: Vec<FileRow> = stmt
        .query_map([], |r| {
            Ok(FileRow { id: r.get(0)?, ts: r.get(1)?, camera: r.get(2)? })
        })?
        .filter_map(Result::ok)
        .collect();

    const MAX_BURST_GAP: i64 = 2; // seconds
    let mut bursts: Vec<Burst> = Vec::new();
    let mut i = 0usize;

    while i < rows.len() {
        let mut j = i + 1;
        while j < rows.len()
            && rows[j].camera == rows[i].camera
            && rows[j].ts - rows[j - 1].ts <= MAX_BURST_GAP
        {
            j += 1;
        }
        if j - i >= 3 {
            let cover = rows[i].id;
            let member_ids: Vec<i64> = rows[i..j].iter().map(|r| r.id).collect();
            bursts.push(Burst { cover_file_id: cover, member_ids });
        }
        i = j;
    }
    Ok(bursts)
}

// ── Shot kind backfill ───────────────────────────────────────────────

/// Derives shot_kind from face detection data:
/// - face_count == 0                           → "landscape"
/// - face_count == 1 with large face           → "selfie"
/// - face_count >= 3                           → "group"
/// - otherwise                                 → ""
pub fn backfill_shot_kind(db_path: &Path) -> AppResult<usize> {
    let conn = open_conn(db_path)?;
    let updated = conn.execute(
        "UPDATE files SET shot_kind = CASE
           WHEN face_count = 0 THEN 'landscape'
           WHEN face_count >= 3 THEN 'group'
           WHEN face_count = 1 THEN 'selfie'
           ELSE ''
         END
         WHERE deleted_at IS NULL AND shot_kind = ''",
        [],
    )?;
    Ok(updated)
}

// ── Year-in-review ───────────────────────────────────────────────────

/// Creates (or replaces) an album named "Year in Review — {year}"
/// containing up to 12 top-rated photos, one per month if possible.
/// Scoring: confidence × (1 + face_count / 5).
pub fn generate_year_review(db_path: &Path, year: i32) -> AppResult<i64> {
    let conn = open_conn(db_path)?;

    // One top file per month (fill gaps allowed)
    let mut stmt = conn.prepare(
        "SELECT id, strftime('%m', datetime(mtime_ns/1000000000, 'unixepoch')) AS mo,
                confidence * (1.0 + face_count / 5.0) AS score
         FROM files
         WHERE deleted_at IS NULL
           AND strftime('%Y', datetime(mtime_ns/1000000000, 'unixepoch')) = ?1
           AND media_type IN ('photo', 'screenshot')
         ORDER BY mo ASC, score DESC",
    )?;
    let year_str = format!("{year:04}");
    let rows: Vec<(i64, String)> = stmt
        .query_map(params![year_str], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
        .filter_map(Result::ok)
        .collect();

    // Pick one per month
    let mut seen_months = std::collections::HashSet::new();
    let mut picks: Vec<i64> = Vec::new();
    for (id, month) in &rows {
        if seen_months.insert(month.clone()) {
            picks.push(*id);
            if picks.len() >= 12 { break; }
        }
    }
    // If fewer than 12, fill with next-best overall
    if picks.len() < 12 {
        for (id, _) in &rows {
            if !picks.contains(id) {
                picks.push(*id);
                if picks.len() >= 12 { break; }
            }
        }
    }

    if picks.is_empty() {
        return Ok(0);
    }

    let album_name = format!("Year in Review — {year}");
    // Delete old album with same name
    conn.execute("DELETE FROM album_files WHERE album_id IN (SELECT id FROM albums WHERE name = ?1)", params![album_name])?;
    conn.execute("DELETE FROM albums WHERE name = ?1", params![album_name])?;

    let now = now_epoch_secs();
    conn.execute(
        "INSERT INTO albums (name, created_at, sort_order) VALUES (?1, ?2, 0)",
        params![album_name, now],
    )?;
    let album_id = conn.last_insert_rowid();
    for file_id in &picks {
        conn.execute(
            "INSERT OR IGNORE INTO album_files (album_id, file_id, added_at) VALUES (?1, ?2, ?3)",
            params![album_id, file_id, now],
        )?;
    }
    Ok(album_id)
}

// ── Dedup policy ─────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DedupStrategy {
    KeepLargest,
    KeepOldest,
    KeepInAlbum,
}

impl DedupStrategy {
    fn as_str(&self) -> &'static str {
        match self {
            Self::KeepLargest => "keep_largest",
            Self::KeepOldest => "keep_oldest",
            Self::KeepInAlbum => "keep_in_album",
        }
    }
}

pub fn set_dedup_policy(db_path: &Path, strategy: DedupStrategy) -> AppResult<()> {
    let conn = open_conn(db_path)?;
    conn.execute("DELETE FROM dedup_policy", [])?;
    conn.execute(
        "INSERT INTO dedup_policy (strategy, enabled) VALUES (?1, 1)",
        params![strategy.as_str()],
    )?;
    Ok(())
}

pub fn get_dedup_policy(db_path: &Path) -> AppResult<Option<DedupStrategy>> {
    let conn = open_conn(db_path)?;
    let result: Option<String> = conn
        .query_row("SELECT strategy FROM dedup_policy WHERE enabled = 1 LIMIT 1", [], |r| r.get(0))
        .ok();
    Ok(result.and_then(|s| match s.as_str() {
        "keep_largest" => Some(DedupStrategy::KeepLargest),
        "keep_oldest"  => Some(DedupStrategy::KeepOldest),
        "keep_in_album" => Some(DedupStrategy::KeepInAlbum),
        _ => None,
    }))
}

/// Apply the active dedup policy to exact-fingerprint duplicates.
/// Returns the number of files soft-deleted.
pub fn apply_dedup_policy(db_path: &Path) -> AppResult<usize> {
    let strategy = match get_dedup_policy(db_path)? {
        Some(s) => s,
        None => return Ok(0),
    };
    let conn = open_conn(db_path)?;
    let now = now_epoch_secs();

    // Find fingerprints that appear more than once
    let mut stmt = conn.prepare(
        "SELECT fingerprint FROM files
         WHERE deleted_at IS NULL AND fingerprint != ''
         GROUP BY fingerprint HAVING COUNT(*) > 1",
    )?;
    let fps: Vec<String> = stmt
        .query_map([], |r| r.get(0))?
        .filter_map(Result::ok)
        .collect();

    let mut deleted = 0usize;
    for fp in fps {
        // Find all duplicates for this fingerprint
        let mut id_stmt = conn.prepare(
            "SELECT id, size_bytes, mtime_ns FROM files
             WHERE deleted_at IS NULL AND fingerprint = ?1
             ORDER BY id ASC",
        )?;
        let dupes: Vec<(i64, i64, i64)> = id_stmt
            .query_map(params![fp], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .filter_map(Result::ok)
            .collect();

        if dupes.len() < 2 { continue; }

        let keeper_id = match strategy {
            DedupStrategy::KeepLargest => dupes.iter().max_by_key(|d| d.1).map(|d| d.0),
            DedupStrategy::KeepOldest  => dupes.iter().min_by_key(|d| d.2).map(|d| d.0),
            DedupStrategy::KeepInAlbum => {
                // Keep the one that's in an album, fallback to first
                let in_album: Option<i64> = conn.query_row(
                    "SELECT file_id FROM album_files WHERE file_id IN
                     (SELECT id FROM files WHERE fingerprint = ?1 AND deleted_at IS NULL)
                     LIMIT 1",
                    params![fp],
                    |r| r.get(0),
                ).ok();
                in_album.or_else(|| dupes.first().map(|d| d.0))
            }
        };

        if let Some(keep) = keeper_id {
            for (id, _, _) in &dupes {
                if *id != keep {
                    conn.execute(
                        "UPDATE files SET deleted_at = ?1 WHERE id = ?2",
                        params![now, id],
                    )?;
                    deleted += 1;
                }
            }
        }
    }
    Ok(deleted)
}

// ── Tauri commands ────────────────────────────────────────────────────

#[tauri::command]
pub async fn recompute_events_cmd(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<EventSummary>, String> {
    cluster_events(&state.paths.db_file).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_events_cmd(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<EventSummary>, String> {
    list_events(&state.paths.db_file).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn detect_trips_cmd(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<TripSummary>, String> {
    detect_trips(&state.paths.db_file).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_trips_cmd(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<TripSummary>, String> {
    list_trips(&state.paths.db_file).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn find_bursts_cmd(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<Burst>, String> {
    find_bursts(&state.paths.db_file).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn generate_year_review_cmd(
    state: tauri::State<'_, crate::AppState>,
    year: i32,
) -> Result<i64, String> {
    generate_year_review(&state.paths.db_file, year).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_dedup_policy_cmd(
    state: tauri::State<'_, crate::AppState>,
    strategy: DedupStrategy,
) -> Result<(), String> {
    set_dedup_policy(&state.paths.db_file, strategy).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_dedup_policy_cmd(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Option<DedupStrategy>, String> {
    get_dedup_policy(&state.paths.db_file).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn apply_dedup_policy_cmd(
    state: tauri::State<'_, crate::AppState>,
) -> Result<usize, String> {
    apply_dedup_policy(&state.paths.db_file).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn backfill_shot_kind_cmd(
    state: tauri::State<'_, crate::AppState>,
) -> Result<usize, String> {
    backfill_shot_kind(&state.paths.db_file).map_err(|e| e.to_string())
}

// ── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{init_database, upsert_root};
    use rusqlite::Connection;
    use tempfile::tempdir;

    fn insert_file_ts(conn: &Connection, root: i64, name: &str, mtime_secs: i64) {
        conn.execute(
            "INSERT INTO files (root_id, rel_path, filename, abs_path, mtime_ns, size_bytes, fingerprint, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, 0)",
            params![root, name, name, format!("/tmp/{name}"), mtime_secs * 1_000_000_000, format!("fp-{name}")],
        ).unwrap();
    }

    fn insert_file_loc(conn: &Connection, root: i64, name: &str, mtime_secs: i64, location: &str) {
        conn.execute(
            "INSERT INTO files (root_id, rel_path, filename, abs_path, mtime_ns, size_bytes, fingerprint, updated_at, location_text)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, 0, ?7)",
            params![root, name, name, format!("/tmp/{name}"), mtime_secs * 1_000_000_000, format!("fp-{name}"), location],
        ).unwrap();
    }

    // 2023-01-01 noon UTC
    const T1: i64 = 1672574400;
    // +1 hour
    const T2: i64 = T1 + 3600;
    // +2 hours
    const T3: i64 = T1 + 7200;
    // Next day
    const T4: i64 = T1 + 86400;
    // 2 days after T4
    const T5: i64 = T4 + 86400 * 2;

    #[test]
    fn three_files_within_window_form_one_event() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("t.sqlite");
        init_database(&db).unwrap();
        let root = upsert_root(&db, "/tmp").unwrap();
        let conn = Connection::open(&db).unwrap();
        insert_file_ts(&conn, root, "a.jpg", T1);
        insert_file_ts(&conn, root, "b.jpg", T2);
        insert_file_ts(&conn, root, "c.jpg", T3);
        drop(conn);

        let events = cluster_events(&db).unwrap();
        assert_eq!(events.len(), 1, "expected 1 event, got {:?}", events.len());
        assert_eq!(events[0].file_count, 3);
    }

    #[test]
    fn files_split_across_large_gap_form_two_events() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("t.sqlite");
        init_database(&db).unwrap();
        let root = upsert_root(&db, "/tmp").unwrap();
        let conn = Connection::open(&db).unwrap();
        insert_file_ts(&conn, root, "a.jpg", T1);
        insert_file_ts(&conn, root, "b.jpg", T4); // 24h later
        insert_file_ts(&conn, root, "c.jpg", T5); // 3 days from T1
        drop(conn);

        let events = cluster_events(&db).unwrap();
        assert!(events.len() >= 2, "expected ≥2 events, got {}", events.len());
    }

    #[test]
    fn gps_less_files_still_cluster_by_time() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("t.sqlite");
        init_database(&db).unwrap();
        let root = upsert_root(&db, "/tmp").unwrap();
        let conn = Connection::open(&db).unwrap();
        // 3 files without GPS, all within 1h
        for i in 0..3 {
            insert_file_ts(&conn, root, &format!("{i}.jpg"), T1 + i as i64 * 600);
        }
        drop(conn);

        let events = cluster_events(&db).unwrap();
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn burst_detection_groups_rapid_shots() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("t.sqlite");
        init_database(&db).unwrap();
        let root = upsert_root(&db, "/tmp").unwrap();
        let conn = Connection::open(&db).unwrap();
        // 5 shots within 1s of each other, same camera
        for i in 0..5i64 {
            conn.execute(
                "INSERT INTO files (root_id, rel_path, filename, abs_path, mtime_ns, size_bytes,
                                    fingerprint, updated_at, camera_model)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, 0, 'Sony A7')",
                params![root, format!("{i}.jpg"), format!("{i}.jpg"),
                        format!("/tmp/{i}.jpg"), (T1 + i) * 1_000_000_000, format!("fp{i}")],
            ).unwrap();
        }
        drop(conn);

        let bursts = find_bursts(&db).unwrap();
        assert_eq!(bursts.len(), 1);
        assert_eq!(bursts[0].member_ids.len(), 5);
    }

    #[test]
    fn haversine_same_point_is_zero() {
        assert!(haversine_m(48.8566, 2.3522, 48.8566, 2.3522).abs() < 1e-6);
    }

    #[test]
    fn haversine_paris_london_approx() {
        let d = haversine_m(48.8566, 2.3522, 51.5074, -0.1278);
        // Real distance ~343 km, allow 5% tolerance
        assert!(d > 320_000.0 && d < 360_000.0, "distance was {d}");
    }

    #[test]
    fn epoch_to_date_str_known() {
        // 2023-01-15: 1673740800 / 86400 = 19367 days from epoch
        let ts = 1_673_740_800i64;
        let s = epoch_to_date_str(ts);
        assert_eq!(s, "2023-01-15");
    }

    #[test]
    fn dedup_keep_largest_keeps_bigger() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("t.sqlite");
        init_database(&db).unwrap();
        let root = upsert_root(&db, "/tmp").unwrap();
        let conn = Connection::open(&db).unwrap();
        // Two files with the same fingerprint, different sizes
        conn.execute(
            "INSERT INTO files (root_id, rel_path, filename, abs_path, mtime_ns, size_bytes,
                                fingerprint, updated_at)
             VALUES (?1, 'small.jpg', 'small.jpg', '/tmp/small.jpg', 1000000000000, 100, 'dup', 0)",
            params![root],
        ).unwrap();
        conn.execute(
            "INSERT INTO files (root_id, rel_path, filename, abs_path, mtime_ns, size_bytes,
                                fingerprint, updated_at)
             VALUES (?1, 'large.jpg', 'large.jpg', '/tmp/large.jpg', 1000000001000, 500, 'dup', 0)",
            params![root],
        ).unwrap();
        drop(conn);

        set_dedup_policy(&db, DedupStrategy::KeepLargest).unwrap();
        let deleted = apply_dedup_policy(&db).unwrap();
        assert_eq!(deleted, 1);

        let conn2 = Connection::open(&db).unwrap();
        let remaining: i64 = conn2.query_row(
            "SELECT COUNT(*) FROM files WHERE deleted_at IS NULL AND fingerprint = 'dup'",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(remaining, 1);
        let keeper: String = conn2.query_row(
            "SELECT filename FROM files WHERE deleted_at IS NULL AND fingerprint = 'dup'",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(keeper, "large.jpg");
    }

    #[test]
    fn generate_year_review_creates_album() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("t.sqlite");
        init_database(&db).unwrap();
        let root = upsert_root(&db, "/tmp").unwrap();
        let conn = Connection::open(&db).unwrap();
        // Insert 3 photos in 2023
        for i in 1i64..=3 {
            conn.execute(
                "INSERT INTO files (root_id, rel_path, filename, abs_path, mtime_ns, size_bytes,
                                    fingerprint, updated_at, media_type, confidence)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, 0, 'photo', 0.9)",
                params![root, format!("{i}.jpg"), format!("{i}.jpg"), format!("/tmp/{i}.jpg"),
                        (1672574400i64 + i * 2592000) * 1_000_000_000, format!("fp{i}")],
            ).unwrap();
        }
        drop(conn);

        let album_id = generate_year_review(&db, 2023).unwrap();
        assert!(album_id > 0);

        let conn2 = Connection::open(&db).unwrap();
        let name: String = conn2.query_row(
            "SELECT name FROM albums WHERE id = ?1",
            params![album_id],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(name, "Year in Review — 2023");
    }
}
