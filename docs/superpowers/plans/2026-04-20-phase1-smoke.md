# Phase 1 — Data Portability: Delivery Record & Smoke Recipe

**Branch:** `feat/portability` (parent: `master` @ `f3fd8b7`)
**Date:** 2026-04-20
**Plan:** [2026-04-20-frank-sherlock-improvements.md](./2026-04-20-frank-sherlock-improvements.md) — Phase 1 only.

---

## Commits (9)

| SHA | Message |
|-----|---------|
| `827a93d` | feat(db): add remap_root for drive-letter and path swaps |
| `b1106a6` | fix(db): address review feedback on remap_root |
| `ffd6322` | feat: expose remap_root_cmd to frontend |
| `458f229` | feat(ui): remap root modal wired into sidebar context menu |
| `79f9328` | feat(portability): zip-based catalog export |
| `25d6dbf` | feat(portability): import catalog from zip with zip-slip defense |
| `80f21de` | feat(ui): export and import catalog dialogs wired into sidebar tools |
| `2d6d03b` | feat(portability): portable mode — catalog under <root>/.frank_sherlock |
| `15f9348` | fix(scan): skip .frank_sherlock portable catalog during walks |

## Automated coverage

All nine tasks landed under TDD with code-review gating.

**Rust backend (`cargo test --lib`)** — 347 passed / 0 failed (baseline 329 → +18).

- `db::tests::remap_root_*` — 6 tests (happy path, collision rejection, prefix-only defense, scan_jobs counter, no-op shortcut, rollback on prefix mismatch).
- `portability::export_tests::*` — 3 tests (happy path, missing cache dirs graceful, refuse overwrite).
- `portability::import_tests::*` — 4 tests (happy path, refuse on existing catalog, zip-slip rejection, full roundtrip byte-equivalence).
- `config::tests::resolve_paths_portable_*` — 3 tests (portable uses `<root>/.frank_sherlock`, precedence over `DATA_DIR_ENV`, None falls back to env).
- `scan::tests::*frank_sherlock*` — 2 tests (helper unit + walker integration).

**Frontend (`npm run test`)** — 312 passed / 0 failed (baseline 299 → +13).

- `RemapRootModal.test.tsx` — 3 tests (happy path, error, disabled when equal).
- `ExportCatalogModal.test.tsx` — 4 tests (cancel, success, error, open-folder).
- `ImportCatalogModal.test.tsx` — 5 tests (confirm, cancel, re-pick, success, overwrite hint).
- Existing `RootCard.test.tsx` / `Sidebar.test.tsx` touched for the new optional props.

---

## Manual smoke recipe

The features below require a real Ollama + Windows/Linux/macOS window, so they are validated by a scripted manual walk. Run through once per release candidate.

### Prerequisites

```bash
# From project root
ollama serve   # separate terminal
cd sherlock/desktop
npm run tauri:dev
```

Have a scratch folder of ≥50 small images on drive `D:` (e.g. `D:\photo-test\`).

---

### Scenario A — remap after drive-letter change

1. First launch → "Add folder" → pick `D:\photo-test\` → let classify finish.
2. Close the app.
3. Swap the drive letter via Disk Management (Windows) or by renaming the folder on Linux/macOS: `D:\photo-test` → `E:\photo-test` (or `/mnt/a` → `/mnt/b`).
4. Launch Frank Sherlock. The root will appear with the old path and thumbnails broken.
5. Right-click the root card in the sidebar → **Remap Path…**
6. Input the new path (e.g. `E:\photo-test`), click **Remap**.
7. Expect toast: "Remapped …" and the `files_updated` count ≥ the number of images.
8. Expect thumbnails to load again without any rescan.
9. Reopen the classified gallery — search queries still work (FTS unchanged).

**Expected failure modes** (error paths to confirm):
- Remap onto a path already registered as another root → `remap target already exists as a root: …`.
- Remap typo that doesn't prefix any existing `abs_path` → `remap rewrote 0 of N file paths; abs_path prefix mismatch — aborting` (transaction rolled back; try again with correct path).

---

### Scenario B — export → wipe → import roundtrip

1. With a non-empty catalog, Sidebar → Tools → **Export Catalog…**
2. Native save dialog → save to `D:\bundle.zip`.
3. Expect success UI with entries count and byte size, plus **Open folder** button that opens the containing directory.
4. Quit the app.
5. Wipe the default data dir:
   - Windows: `rmdir /S /Q %LOCALAPPDATA%\frank_sherlock`
   - Linux: `rm -rf ~/.local/share/frank_sherlock`
   - macOS: `rm -rf ~/Library/Application\ Support/frank_sherlock`
6. Launch the app — it should start fresh (no roots, no thumbnails).
7. Sidebar → Tools → **Import Catalog…** → click "Choose file…" → pick `D:\bundle.zip`.
8. Expect success UI with the same entries count, then the hint "Restart recommended".
9. Restart the app. Verify:
   - All roots reappear in the sidebar with correct counts.
   - Thumbnails render immediately (no reclassify).
   - Search queries return the same results as before export.

**Expected failure modes:**
- Import into a directory that already contains `db/index.sqlite` → error "refusing to overwrite existing catalog" with a tip to export/move first.
- Import a zip containing a path-traversal entry → rejected with `"zip contains unsafe path: …"`. (Can't easily reproduce manually; fully covered by `import_rejects_path_traversal` Rust test.)

---

### Scenario C — portable mode (backend only; UI deferred)

1. Quit the app.
2. Edit `~/.config/frank_sherlock/config.json` (or the platform equivalent) and set:
   ```json
   { "portableRoot": "D:\\photo-test" }
   ```
3. Relaunch.
4. Expect the app to create `D:\photo-test\.frank_sherlock\db\index.sqlite` and `…\cache\thumbnails\` on first write. All new indexing data lives under the portable root.
5. Scan `D:\photo-test` and confirm the scanner does **not** index anything inside `.frank_sherlock/` (i.e. the thumbnails and db are not themselves classified).
6. Move the drive to another machine; set `portableRoot` on that machine to the new mount point.
7. The catalog is visible without rescan.

**Clearing portable mode:** remove the `portableRoot` field from `config.json` (or set it to `""`) and restart. Existing portable data stays on the drive; the app returns to the default location.

**Known rough edges (acceptable for MVP):**
- No UI toggle yet — power-user JSON edit only. UI toggle was intentionally scoped out of Phase 1.
- Changing `portableRoot` does not migrate existing data; it only redirects the next launch.
- `set_portable_root_cmd` validates the directory exists but is not atomic against concurrent writes to `user_config`.

---

## Known follow-ups (non-blocking for Phase 1 merge)

Captured from the code-review cycles, deferred to later phases:

1. **Phase 2 refactor** (already planned) — make `abs_path` a derived view over `roots.root_path || '/' || files.rel_path`. Eliminates the prefix-rewrite logic in `remap_root`.
2. Export/import: stream large files via `std::io::copy` instead of `Vec::with_capacity(zip_file.size())` to defend against declared-size DoS on imported zips. Low priority — import is a user-initiated action with a user-provided file.
3. Export/import: write-to-temp-then-rename for crash-safe atomicity.
4. Wrap export + import Tauri commands in `tauri::async_runtime::spawn_blocking` for large catalogs to avoid blocking the main runtime thread.
5. Portable mode UI: checkbox + path picker in a Settings modal (the Help modal is search-only, so a dedicated Settings modal is the right place).
6. `AppError::Io` / `AppError::Conflict` variants — several paths currently funnel through `AppError::Config` for I/O + data-conflict errors. Semantic cleanup opportunity.

---

## Verdict

Phase 1 delivers its promise: the user can change drive letters, migrate machines, and keep their catalog portable without reprocessing hours of Ollama classification. All 9 tasks passed both spec-compliance and code-quality review. Automated suites +31 tests, both green. Manual smoke recipe above is the last gate before merging `feat/portability` back to `master`.
