# Find Similar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Right-click any image → "Find similar" shows the 20 most visually-and-semantically related files in the catalog, ranked.

**Architecture:** All primitives already exist. The app already stores `dhash` (u64 perceptual hash, from Migration 6) and text `description` (from the classification pipeline). `similarity.rs` already exposes `combined_similarity(dhash_a, dhash_b, desc_a, desc_b) -> f32` that weighs 85% visual (dHash Hamming) and 15% textual (Jaccard on description words). This task stitches those together into a ranked query, exposes it to the UI, and wires a context-menu entry + results view.

**Tech stack:** Rust (rusqlite, existing `similarity` helpers), React + TypeScript, Vitest.

---

## File structure

- **Create:** `sherlock/desktop/src-tauri/src/find_similar.rs` — the ranked-query module.
- **Modify:** `sherlock/desktop/src-tauri/src/lib.rs` — register the Tauri command + declare the module.
- **Create:** `sherlock/desktop/src/components/modals/SimilarResultsModal.tsx` — results grid.
- **Create:** `sherlock/desktop/src/components/modals/SimilarResultsModal.css` — thin per-dialog styles.
- **Create:** `sherlock/desktop/src/__tests__/components/SimilarResultsModal.test.tsx`.
- **Modify:** `sherlock/desktop/src/components/Content/` — wire a "Find similar" context-menu action on each thumbnail (look at the existing preview/delete action pattern).
- **Modify:** `sherlock/desktop/src/App.tsx` — host modal state.
- **Modify:** `sherlock/desktop/src/types.ts` — add `SimilarResult` interface.

---

## Task 1: Backend ranked query

**Files:**
- Create: `sherlock/desktop/src-tauri/src/find_similar.rs`
- Modify: `sherlock/desktop/src-tauri/src/lib.rs` (add `mod find_similar;`)

- [ ] **Step 1: Write the failing tests**

Create `find_similar.rs`:

```rust
//! Ranked "find similar" query using dHash + description similarity.
use crate::db::open_conn;
use crate::error::{AppError, AppResult};
use crate::similarity::{combined_similarity, hamming_distance};
use rusqlite::params;
use std::path::Path;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimilarResult {
    pub file_id: i64,
    pub root_id: i64,
    pub rel_path: String,
    pub abs_path: String,
    pub filename: String,
    pub media_type: String,
    pub description: String,
    pub thumb_path: Option<String>,
    pub score: f32,
}

/// Early-exit pruning: if visual alone can't exceed `min_score`, skip the row.
/// combined = 0.85 * visual + 0.15 * textual; textual ≤ 1.0, so:
///   visual ≥ (min_score - 0.15) / 0.85
///   hamming ≤ (1 - visual) * 64
fn max_hamming_for(min_score: f32) -> u32 {
    let visual_min = ((min_score - 0.15) / 0.85).max(0.0);
    ((1.0 - visual_min) * 64.0).floor() as u32
}

/// Rank all other files by `combined_similarity` to the source file.
/// Returns the top `limit` with `score ≥ min_score`, descending by score.
pub fn find_similar(
    db_path: &Path,
    source_file_id: i64,
    limit: usize,
    min_score: f32,
) -> AppResult<Vec<SimilarResult>> {
    let conn = open_conn(db_path)?;

    // Fetch the source row.
    let (src_dhash, src_desc, src_media_type): (Option<i64>, String, String) = conn
        .query_row(
            "SELECT dhash, description, media_type FROM files
             WHERE id = ?1 AND deleted_at IS NULL",
            params![source_file_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                AppError::InvalidPath(format!("no such file: {source_file_id}"))
            }
            other => other.into(),
        })?;

    let src_dhash = match src_dhash {
        Some(v) => v as u64,
        None => {
            // No dHash on source — fall back to description-only ranking via
            // FTS BM25, handled elsewhere. For now, return empty.
            return Ok(Vec::new());
        }
    };

    let max_h = max_hamming_for(min_score);

    // Load candidates: same media_type tier for precision, non-deleted, has dhash.
    let mut stmt = conn.prepare(
        "SELECT f.id, f.root_id, f.rel_path, f.filename, f.abs_path,
                f.media_type, f.description, f.thumb_path, f.dhash
         FROM files f
         WHERE f.id != ?1
           AND f.deleted_at IS NULL
           AND f.dhash IS NOT NULL
           AND f.media_type = ?2",
    )?;

    let mut scored: Vec<SimilarResult> = Vec::new();
    let rows = stmt.query_map(params![source_file_id, src_media_type], |row| {
        let dhash: i64 = row.get(8)?;
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, Option<String>>(7)?,
            dhash as u64,
        ))
    })?;

    for row in rows {
        let (file_id, root_id, rel_path, filename, abs_path, media_type, description, thumb_path, cand_dhash) = row?;
        if hamming_distance(src_dhash, cand_dhash) > max_h {
            continue;
        }
        let score = combined_similarity(src_dhash, cand_dhash, &src_desc, &description);
        if score < min_score {
            continue;
        }
        scored.push(SimilarResult {
            file_id,
            root_id,
            rel_path,
            abs_path,
            filename,
            media_type,
            description,
            thumb_path,
            score,
        });
    }

    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit);
    Ok(scored)
}

#[tauri::command]
pub async fn find_similar_cmd(
    state: tauri::State<'_, crate::AppState>,
    file_id: i64,
    limit: usize,
    min_score: f32,
) -> Result<Vec<SimilarResult>, String> {
    find_similar(&state.paths.db_file, file_id, limit, min_score).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{init_database, upsert_root};
    use rusqlite::Connection;
    use tempfile::tempdir;

    fn seed_file(
        conn: &Connection,
        root_id: i64,
        filename: &str,
        rel_path: &str,
        media_type: &str,
        description: &str,
        dhash: Option<i64>,
    ) -> i64 {
        conn.execute(
            "INSERT INTO files (root_id, rel_path, filename, abs_path, media_type, description,
                                mtime_ns, size_bytes, fingerprint, updated_at, dhash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, ?7, 0, ?8)",
            rusqlite::params![
                root_id,
                rel_path,
                filename,
                format!("D:\\Photos\\{rel_path}"),
                media_type,
                description,
                format!("fp-{filename}"),
                dhash,
            ],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn setup() -> (tempfile::TempDir, std::path::PathBuf, i64) {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.sqlite");
        init_database(&db_path).unwrap();
        let root_id = upsert_root(&db_path, "D:\\Photos").unwrap();
        (dir, db_path, root_id)
    }

    #[test]
    fn find_similar_returns_high_scoring_candidates() {
        let (_dir, db_path, root_id) = setup();
        let conn = Connection::open(&db_path).unwrap();
        // Source: dhash 0x00, media_type photo, description "sunset over beach"
        let src = seed_file(&conn, root_id, "a.jpg", "a.jpg", "photo", "sunset over beach", Some(0));
        // Very similar: 2 bit difference, same words
        let close = seed_file(&conn, root_id, "b.jpg", "b.jpg", "photo", "sunset over beach", Some(0b11));
        // Same media type, unrelated content, very different hash
        let far = seed_file(&conn, root_id, "c.jpg", "c.jpg", "photo", "car in parking lot", Some(i64::from_le_bytes(0xFFFFFFFFFFFFFFFFu64.to_le_bytes())));
        // Different media type — must be filtered out
        let _doc = seed_file(&conn, root_id, "d.jpg", "d.jpg", "document", "sunset over beach", Some(0));
        drop(conn);

        let out = find_similar(&db_path, src, 10, 0.5).unwrap();
        let ids: Vec<i64> = out.iter().map(|r| r.file_id).collect();
        assert!(ids.contains(&close), "expected close match included, got {ids:?}");
        assert!(!ids.contains(&far), "expected far match excluded by min_score 0.5, got {ids:?}");
        // Must not include the source itself.
        assert!(!ids.contains(&src));
        // Must not cross media_type.
        assert!(ids.iter().all(|id| *id != _doc));
        // Must be sorted descending by score.
        let mut scores: Vec<f32> = out.iter().map(|r| r.score).collect();
        let mut sorted = scores.clone();
        sorted.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
        assert_eq!(scores, sorted);
        scores.clear();
    }

    #[test]
    fn find_similar_respects_limit() {
        let (_dir, db_path, root_id) = setup();
        let conn = Connection::open(&db_path).unwrap();
        let src = seed_file(&conn, root_id, "src.jpg", "src.jpg", "photo", "cat on couch", Some(0));
        for i in 0..5 {
            seed_file(
                &conn,
                root_id,
                &format!("n{i}.jpg"),
                &format!("n{i}.jpg"),
                "photo",
                "cat on couch",
                Some(i as i64), // Hamming distances 1..5 bits.
            );
        }
        drop(conn);

        let out = find_similar(&db_path, src, 2, 0.5).unwrap();
        assert_eq!(out.len(), 2, "limit must cap results at 2");
    }

    #[test]
    fn find_similar_returns_empty_when_source_has_no_dhash() {
        let (_dir, db_path, root_id) = setup();
        let conn = Connection::open(&db_path).unwrap();
        let src = seed_file(&conn, root_id, "src.jpg", "src.jpg", "photo", "x", None);
        seed_file(&conn, root_id, "c.jpg", "c.jpg", "photo", "x", Some(0));
        drop(conn);

        let out = find_similar(&db_path, src, 10, 0.5).unwrap();
        assert!(out.is_empty(), "source without dhash should yield empty results");
    }

    #[test]
    fn find_similar_errors_on_unknown_source() {
        let (_dir, db_path, _root_id) = setup();
        let err = find_similar(&db_path, 9999, 10, 0.5);
        assert!(err.is_err());
    }

    #[test]
    fn find_similar_excludes_deleted_candidates() {
        let (_dir, db_path, root_id) = setup();
        let conn = Connection::open(&db_path).unwrap();
        let src = seed_file(&conn, root_id, "src.jpg", "src.jpg", "photo", "sunset", Some(0));
        let gone = seed_file(&conn, root_id, "gone.jpg", "gone.jpg", "photo", "sunset", Some(0));
        conn.execute("UPDATE files SET deleted_at = 1 WHERE id = ?1", rusqlite::params![gone]).unwrap();
        drop(conn);

        let out = find_similar(&db_path, src, 10, 0.5).unwrap();
        assert!(out.iter().all(|r| r.file_id != gone));
    }
}
```

- [ ] **Step 2: Register module**

In `lib.rs`, add `mod find_similar;` next to the other `mod` declarations.

- [ ] **Step 3: Run tests — confirm RED**

```
cd sherlock/desktop/src-tauri && cargo test find_similar --lib -- --test-threads=1
```

Expected: fails because `find_similar` module and helpers don't compile until Step 1 lands.

(The test file IS the implementation too in this case — Step 1 created both. Running the tests verifies GREEN.)

- [ ] **Step 4: Verify GREEN**

```
cargo test find_similar --lib -- --test-threads=1
```

Expected: 5 tests pass.

- [ ] **Step 5: Register the Tauri command**

In `lib.rs`, add `find_similar::find_similar_cmd,` to `tauri::generate_handler![...]`. Place near the existing `portability::*` commands so related surface area stays co-located.

- [ ] **Step 6: cargo check**

```
cargo check
```

Must be clean (pre-existing unrelated warnings allowed).

- [ ] **Step 7: Commit**

```bash
git -c user.email=felipe@local -c user.name=felipe commit -am "feat(find-similar): backend ranked-query using dHash + description"
```

---

## Task 2: Results modal UI

**Files:**
- Modify: `sherlock/desktop/src/types.ts` (add `SimilarResult`)
- Create: `sherlock/desktop/src/components/modals/SimilarResultsModal.tsx`
- Create: `sherlock/desktop/src/components/modals/SimilarResultsModal.css`
- Create: `sherlock/desktop/src/__tests__/components/SimilarResultsModal.test.tsx`

- [ ] **Step 1: Add the TS interface**

In `types.ts`, append:

```ts
export interface SimilarResult {
  fileId: number;
  rootId: number;
  relPath: string;
  absPath: string;
  filename: string;
  mediaType: string;
  description: string;
  thumbPath: string | null;
  score: number;
}
```

- [ ] **Step 2: Write the failing tests**

Create `__tests__/components/SimilarResultsModal.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import SimilarResultsModal from "../../components/modals/SimilarResultsModal";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

describe("SimilarResultsModal", () => {
  beforeEach(() => invokeMock.mockReset());

  it("invokes find_similar_cmd on mount and renders the results", async () => {
    invokeMock.mockResolvedValue([
      { fileId: 2, rootId: 1, relPath: "b.jpg", absPath: "D:/b.jpg", filename: "b.jpg",
        mediaType: "photo", description: "sunset", thumbPath: null, score: 0.97 },
      { fileId: 3, rootId: 1, relPath: "c.jpg", absPath: "D:/c.jpg", filename: "c.jpg",
        mediaType: "photo", description: "beach", thumbPath: null, score: 0.82 },
    ]);
    render(<SimilarResultsModal sourceFileId={1} sourceLabel="a.jpg" onClose={() => {}} />);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("find_similar_cmd", {
        fileId: 1, limit: 20, minScore: 0.5,
      })
    );
    await waitFor(() => expect(screen.getByText("b.jpg")).toBeInTheDocument());
    expect(screen.getByText("c.jpg")).toBeInTheDocument();
    // Scores rendered as percentages.
    expect(screen.getByText(/97%/)).toBeInTheDocument();
    expect(screen.getByText(/82%/)).toBeInTheDocument();
  });

  it("shows empty state when no matches", async () => {
    invokeMock.mockResolvedValue([]);
    render(<SimilarResultsModal sourceFileId={1} sourceLabel="a.jpg" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no similar/i)).toBeInTheDocument());
  });

  it("surfaces backend errors", async () => {
    invokeMock.mockRejectedValueOnce(new Error("no such file: 9999"));
    render(<SimilarResultsModal sourceFileId={9999} sourceLabel="missing" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/no such file/i));
  });
});
```

- [ ] **Step 3: Run tests — confirm RED**

```
cd sherlock/desktop && npx vitest run SimilarResultsModal
```

- [ ] **Step 4: Implement the modal**

Create `SimilarResultsModal.tsx`:

```tsx
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "../../utils";
import type { SimilarResult } from "../../types";
import ModalOverlay from "./ModalOverlay";
import "./shared-modal.css";
import "./SimilarResultsModal.css";

type Props = {
  sourceFileId: number;
  sourceLabel: string;
  onClose: () => void;
};

export default function SimilarResultsModal({ sourceFileId, sourceLabel, onClose }: Props) {
  const [results, setResults] = useState<SimilarResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const out = await invoke<SimilarResult[]>("find_similar_cmd", {
          fileId: sourceFileId,
          limit: 20,
          minScore: 0.5,
        });
        if (!cancelled) setResults(out);
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      }
    })();
    return () => { cancelled = true; };
  }, [sourceFileId]);

  return (
    <ModalOverlay onBackdropClick={onClose}>
      <div
        className="modal-base similar-results-modal"
        role="dialog"
        aria-label="Similar results"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Similar to {sourceLabel}</h3>
        {error && <div role="alert" className="similar-results-error">{error}</div>}
        {results === null && !error && (
          <p className="similar-results-status">Searching…</p>
        )}
        {results && results.length === 0 && (
          <p className="similar-results-empty">No similar items found above the 50% threshold.</p>
        )}
        {results && results.length > 0 && (
          <ul className="similar-results-grid">
            {results.map((r) => (
              <li key={r.fileId} className="similar-results-item">
                <div className="similar-results-thumb" aria-hidden="true">
                  {r.thumbPath ? <img src={r.thumbPath} alt="" /> : <span>📄</span>}
                </div>
                <div className="similar-results-meta">
                  <div className="similar-results-name" title={r.absPath}>{r.filename}</div>
                  <div className="similar-results-desc">{r.description}</div>
                  <div className="similar-results-score">{Math.round(r.score * 100)}%</div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </ModalOverlay>
  );
}
```

Create `SimilarResultsModal.css` with minimal thin styles for `.similar-results-*` classes (grid layout for thumbs, small metadata text, percentage score chip). Keep CSS small — reuse shared-modal where possible.

- [ ] **Step 5: GREEN**

```
cd sherlock/desktop && npx vitest run SimilarResultsModal
```

Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git -c user.email=felipe@local -c user.name=felipe commit -am "feat(ui): similar-results modal"
```

---

## Task 3: Content-grid wiring

**Files:**
- Modify: `sherlock/desktop/src/App.tsx`
- Modify: one or more files under `sherlock/desktop/src/components/Content/` (the thumbnail grid and its context menu) — read the existing structure first and mirror the pattern used for the "Delete" / "Open in Finder" / "Copy path" context-menu entries.

- [ ] **Step 1: Read the existing pattern**

Open `components/Content/` and identify:
- The thumbnail grid file (probably `Content.tsx` or `ThumbnailGrid.tsx`).
- Its right-click context menu — there should already be entries like "Preview", "Copy path", etc. Find where they live and how props flow from App.tsx.

- [ ] **Step 2: Add the handler prop**

In whichever hook or component owns the context menu, add an `onFindSimilar: (fileId: number, label: string) => void` prop/callback. Render a new menu entry "Find similar" that calls it.

- [ ] **Step 3: Wire state in App.tsx**

```tsx
const [similarSource, setSimilarSource] = useState<{ fileId: number; label: string } | null>(null);
// ... pass handler:
onFindSimilar={(fileId, label) => setSimilarSource({ fileId, label })}
// ... render near the other modals:
{similarSource && (
  <SimilarResultsModal
    sourceFileId={similarSource.fileId}
    sourceLabel={similarSource.label}
    onClose={() => setSimilarSource(null)}
  />
)}
```

- [ ] **Step 4: Type-check + full suite**

```
cd sherlock/desktop && npm run test
```

Must remain green (no regressions). Spot-check that existing tests covering the content-grid context menu still pass — if they mock props, they may need the new `onFindSimilar` added to their defaults.

- [ ] **Step 5: Commit**

```bash
git -c user.email=felipe@local -c user.name=felipe commit -am "feat(ui): Find similar context-menu entry on thumbnail grid"
```

---

## Task 4: Delivery note

- [ ] **Step 1:** Append a short entry to `releases/v0.9.0.md` or create `v0.10.0.md` summarizing the new "Find similar" menu entry + how the ranking works (85% visual / 15% textual). Include the Ollama-free nature (no model download required; uses existing dHash + description).

- [ ] **Step 2: Commit**

```bash
git -c user.email=felipe@local -c user.name=felipe commit -am "docs: release note for find-similar"
```

---

## Post-task checklist

- [ ] `cargo test find_similar --lib` green (5 tests).
- [ ] `npm run test` green (existing + 3 new).
- [ ] CLAUDE.md mentions `find_similar.rs` in the Key Rust Modules table.
- [ ] Release note drafted.
