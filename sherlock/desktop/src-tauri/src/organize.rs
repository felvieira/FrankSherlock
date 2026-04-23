//! Auto-organize: AI-suggested event names + (future) atomic move/copy engine.
//!
//! Aggregates per-event metadata (top `canonical_mentions` token, most common
//! `location_text`, event month) into human-readable folder names and persists
//! them on `events.suggested_name` for later use by the OrganizeWizard.

use crate::db::open_conn;
use crate::error::AppResult;
use rusqlite::params;
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestedName {
    pub event_id: i64,
    pub suggested: String,
}

/// Aggregates top canonical mention + location_text + YYYY-MM of each event
/// into a single suggested folder name, persists it on `events.suggested_name`,
/// and returns the list.
pub fn suggest_event_names(db_path: &Path) -> AppResult<Vec<SuggestedName>> {
    let conn = open_conn(db_path)?;

    // Pull all events with their time window for the YYYY-MM prefix.
    let mut stmt = conn.prepare(
        "SELECT id, started_at FROM events ORDER BY started_at ASC",
    )?;
    let events: Vec<(i64, i64)> = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?
        .filter_map(Result::ok)
        .collect();
    drop(stmt);

    let mut out = Vec::with_capacity(events.len());

    for (event_id, started_at) in events {
        // Most common non-empty location_text for this event.
        let location: Option<String> = conn
            .query_row(
                r#"SELECT f.location_text FROM files f
                   JOIN event_files ef ON ef.file_id = f.id
                   WHERE ef.event_id = ?1 AND f.location_text IS NOT NULL AND f.location_text != ''
                   GROUP BY f.location_text
                   ORDER BY COUNT(*) DESC
                   LIMIT 1"#,
                params![event_id],
                |r| r.get::<_, String>(0),
            )
            .ok();

        // Top canonical mention: files.canonical_mentions is a comma-separated
        // string. We aggregate the first token of each file's list and pick the
        // most frequent.
        let mut stmt2 = conn.prepare(
            "SELECT f.canonical_mentions FROM files f
             JOIN event_files ef ON ef.file_id = f.id
             WHERE ef.event_id = ?1 AND f.canonical_mentions IS NOT NULL AND f.canonical_mentions != ''",
        )?;
        let mut tag_counts: HashMap<String, i64> = HashMap::new();
        let mentions_iter = stmt2.query_map(params![event_id], |r| r.get::<_, String>(0))?;
        for m in mentions_iter.flatten() {
            if let Some(first) = m.split(',').next() {
                let tok = first.trim();
                if !tok.is_empty() {
                    *tag_counts.entry(tok.to_string()).or_insert(0) += 1;
                }
            }
        }
        drop(stmt2);
        let top_tag: Option<String> = tag_counts
            .into_iter()
            .max_by_key(|(_, c)| *c)
            .map(|(tag, _)| tag);

        // YYYY-MM prefix from started_at (unix seconds).
        let ym = format_year_month(started_at);

        // Compose: prefer location, else tag, else just the month.
        let label = match (location.as_deref(), top_tag.as_deref()) {
            (Some(loc), _) => format!("{ym} {loc}"),
            (None, Some(tag)) => format!("{ym} {tag}"),
            (None, None) => ym,
        };
        let label = sanitize_folder_name(&label);

        conn.execute(
            "UPDATE events SET suggested_name = ?1 WHERE id = ?2",
            params![label, event_id],
        )?;
        out.push(SuggestedName { event_id, suggested: label });
    }

    Ok(out)
}

fn format_year_month(unix_secs: i64) -> String {
    // Compute YYYY-MM from a unix timestamp without depending on chrono.
    // Use the days-since-1970 / civil-from-days algorithm (Howard Hinnant).
    let days = unix_secs.div_euclid(86_400);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}", year, m)
}

fn sanitize_folder_name(s: &str) -> String {
    // Keep it portable across Win/macOS/Linux: strip path separators and a few
    // characters Windows disallows in folder names.
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => out.push('-'),
            _ => out.push(c),
        }
    }
    out.trim().to_string()
}

// ── Organize plan ─────────────────────────────────────────────────────

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeProposal {
    pub event_id: i64,
    pub folder_name: String,
    pub file_ids: Vec<i64>,
    pub file_paths: Vec<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizePlan {
    pub base_dir: String,
    pub proposals: Vec<OrganizeProposal>,
    pub unassigned_count: i64,
}

pub fn build_organize_plan(db_path: &Path, base_dir: &str) -> AppResult<OrganizePlan> {
    let conn = open_conn(db_path)?;
    let mut stmt = conn.prepare(
        r#"SELECT id, COALESCE(NULLIF(suggested_name, ''), name) FROM events ORDER BY started_at"#,
    )?;
    let events: Vec<(i64, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    drop(stmt);

    let mut proposals = Vec::new();
    let mut assigned_ids: std::collections::HashSet<i64> = std::collections::HashSet::new();

    for (event_id, folder_name) in events {
        let mut st = conn.prepare(
            r#"SELECT f.id, f.abs_path FROM files f
               JOIN event_files ef ON ef.file_id = f.id
               WHERE ef.event_id = ?1"#,
        )?;
        let rows: Vec<(i64, String)> = st
            .query_map(params![event_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        let file_ids: Vec<i64> = rows.iter().map(|(i, _)| *i).collect();
        let file_paths: Vec<String> = rows.iter().map(|(_, p)| p.clone()).collect();
        for id in &file_ids {
            assigned_ids.insert(*id);
        }
        proposals.push(OrganizeProposal {
            event_id,
            folder_name,
            file_ids,
            file_paths,
        });
    }

    let total: i64 = conn.query_row("SELECT COUNT(*) FROM files", [], |r| r.get::<_, i64>(0))?;
    let unassigned_count = total - assigned_ids.len() as i64;

    Ok(OrganizePlan {
        base_dir: base_dir.to_string(),
        proposals,
        unassigned_count,
    })
}

// ── Tauri commands ────────────────────────────────────────────────────

#[tauri::command]
pub async fn suggest_event_names_cmd(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<SuggestedName>, String> {
    suggest_event_names(&state.paths.db_file).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn build_organize_plan_cmd(
    base_dir: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<OrganizePlan, String> {
    let db = state.paths.db_file.clone();
    tauri::async_runtime::spawn_blocking(move || build_organize_plan(&db, &base_dir))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_database;

    #[test]
    fn suggest_event_names_empty_db_returns_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("test.sqlite");
        init_database(&db).unwrap();
        let result = suggest_event_names(&db).unwrap();
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn format_year_month_known_timestamps() {
        // 2021-01-01 00:00:00 UTC = 1609459200
        assert_eq!(format_year_month(1_609_459_200), "2021-01");
        // 2024-07-15 12:00:00 UTC = 1721044800
        assert_eq!(format_year_month(1_721_044_800), "2024-07");
        // Epoch
        assert_eq!(format_year_month(0), "1970-01");
    }

    #[test]
    fn sanitize_folder_name_strips_path_separators() {
        assert_eq!(sanitize_folder_name("a/b\\c:d*e?f"), "a-b-c-d-e-f");
        assert_eq!(sanitize_folder_name("  2024-07 Paris  "), "2024-07 Paris");
    }

    #[test]
    fn build_organize_plan_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("t.db");
        init_database(&db).unwrap();
        let p = build_organize_plan(&db, "/tmp/out").unwrap();
        assert_eq!(p.proposals.len(), 0);
        assert_eq!(p.unassigned_count, 0);
        assert_eq!(p.base_dir, "/tmp/out");
    }

}
