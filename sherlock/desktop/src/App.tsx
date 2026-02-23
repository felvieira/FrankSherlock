import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  appHealth,
  cancelScan,
  cleanupOllamaModels,
  copyFilesToClipboard,
  ensureDatabase,
  getRuntimeStatus,
  getScanJob,
  getSetupStatus,
  listActiveScans,
  listRoots,
  loadUserConfig,
  removeRoot,
  saveUserConfig,
  searchImages,
  startScan,
  startSetupDownload
} from "./api";
import type {
  DbStats,
  RootInfo,
  RuntimeStatus,
  ScanJobStatus,
  SearchItem,
  SearchResponse,
  SetupStatus
} from "./types";

const PAGE_SIZE = 80;
const MAX_ITEMS = 400;
const POLL_MS = 1200;
const appWindow = getCurrentWindow();

export default function App() {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SearchItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dbStats, setDbStats] = useState<DbStats | null>(null);

  const [selectedMediaType, setSelectedMediaType] = useState("");
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [activeScans, setActiveScans] = useState<ScanJobStatus[]>([]);
  const [trackedJobIds, setTrackedJobIds] = useState<number[]>([]);
  const [completedJobs, setCompletedJobs] = useState<ScanJobStatus[]>([]);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const [zoom, setZoom] = useState(1.25);
  const [roots, setRoots] = useState<RootInfo[]>([]);
  const [selectedRootId, setSelectedRootId] = useState<number | null>(null);
  const [confirmDeleteRoot, setConfirmDeleteRoot] = useState<RootInfo | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [showResumeModal, setShowResumeModal] = useState(false);
  const requestIdRef = useRef(0);
  const configRef = useRef<Record<string, unknown>>({});
  const lastProcessedRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const columnsRef = useRef(1);

  const canLoadMore = items.length < total;
  const mediaTypeOptions = useMemo(
    () => ["", "document", "anime", "screenshot", "photo", "artwork", "manga", "other"],
    []
  );

  const previewItems: SearchItem[] = previewOpen
    ? [...selectedIndices].sort((a, b) => a - b).slice(0, 4).filter(i => i < items.length).map(i => items[i])
    : [];

  const singlePreviewIndex = selectedIndices.size === 1 ? [...selectedIndices][0] : null;

  const isScanning = activeScans.some((s) => s.status === "running");
  const runningScans = activeScans.filter((s) => s.status === "running");
  const interruptedScans = activeScans.filter((s) => s.status === "interrupted");
  const showSummary = trackedJobIds.length === 0 && completedJobs.length > 0;

  // Load user config (zoom) on mount
  useEffect(() => {
    let mounted = true;
    loadUserConfig()
      .then((cfg) => {
        if (!mounted) return;
        configRef.current = cfg;
        const savedZoom = typeof cfg.zoom === "number" ? cfg.zoom : 1.25;
        setZoom(Math.max(0.5, Math.min(3.0, savedZoom)));
      })
      .catch(() => {});
    return () => { mounted = false; };
  }, []);

  // Apply zoom to root font-size
  useEffect(() => {
    document.documentElement.style.fontSize = `${14 * zoom}px`;
  }, [zoom]);

  // Keyboard: Ctrl+Shift+= (zoom in), Ctrl+Shift+- (zoom out)
  useEffect(() => {
    function handleZoomKey(e: KeyboardEvent) {
      if (!e.ctrlKey || !e.shiftKey) return;
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        setZoom((prev) => {
          const next = Math.min(3.0, +(prev + 0.1).toFixed(2));
          persistZoom(next);
          return next;
        });
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setZoom((prev) => {
          const next = Math.max(0.5, +(prev - 0.1).toFixed(2));
          persistZoom(next);
          return next;
        });
      }
    }
    window.addEventListener("keydown", handleZoomKey);
    return () => window.removeEventListener("keydown", handleZoomKey);
  }, []);

  function persistZoom(value: number) {
    const cfg = { ...configRef.current, zoom: value };
    configRef.current = cfg;
    saveUserConfig(cfg).catch(() => {});
  }

  const refreshRoots = useCallback(async () => {
    try {
      const r = await listRoots();
      setRoots(r);
    } catch {
      // Silently ignore — roots will refresh on next poll
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [db, setupStatus, runtimeStatus, scans, rootList, health] = await Promise.all([
          ensureDatabase(),
          getSetupStatus(),
          getRuntimeStatus(),
          listActiveScans(),
          listRoots(),
          appHealth()
        ]);
        if (!mounted) return;
        setDbStats(db);
        setSetup(setupStatus);
        setRuntime(runtimeStatus);
        setActiveScans(scans);
        setRoots(rootList);
        setReadOnly(health.readOnly);
        const runningIds = scans.filter((s) => s.status === "running").map((s) => s.id);
        if (runningIds.length > 0) {
          setTrackedJobIds(runningIds);
        }
        const interrupted = scans.filter((s) => s.status === "interrupted");
        if (interrupted.length > 0) {
          setShowResumeModal(true);
        }
      } catch (err) {
        if (!mounted) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      void pollRuntimeAndScans();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [trackedJobIds]);

  useEffect(() => {
    if (setup && !setup.isReady) return;
    const timer = setTimeout(() => {
      void runSearch(0, false);
    }, 260);
    return () => clearTimeout(timer);
  }, [query, selectedMediaType, selectedRootId, setup?.isReady]);

  // IntersectionObserver for infinite scroll
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          void onLoadMore();
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [items.length, total, loadingMore]);

  // ResizeObserver on grid to calculate columns
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const gap = 6;
    const minItemWidth = 220;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        columnsRef.current = Math.max(1, Math.floor((w + gap) / (minItemWidth + gap)));
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Unified keyboard handler: navigation, preview toggle, escape, copy, select-all
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

      if (e.key === "Escape") {
        if (showSummary) {
          setCompletedJobs([]);
        } else if (showResumeModal) {
          setShowResumeModal(false);
        } else if (confirmDeleteRoot) {
          setConfirmDeleteRoot(null);
        } else if (previewOpen) {
          setPreviewOpen(false);
        } else if (selectedIndices.size > 0) {
          setSelectedIndices(new Set());
          setFocusIndex(null);
          setAnchorIndex(null);
        }
        return;
      }

      // Ignore nav keys when non-preview modals are open
      if (showResumeModal || confirmDeleteRoot || (setup && !setup.isReady)) return;

      // Ctrl+C: copy selected file paths to clipboard
      if ((e.ctrlKey || e.metaKey) && e.key === "c") {
        e.preventDefault();
        const paths = [...selectedIndices].sort((a, b) => a - b)
          .filter(i => i < items.length)
          .map(i => items[i].absPath);
        if (paths.length > 0) {
          copyFilesToClipboard(paths).catch(() => {});
          setNotice(`Copied ${paths.length} file path(s)`);
        }
        return;
      }

      // Ctrl+A: select all loaded items
      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        setSelectedIndices(new Set(items.map((_, i) => i)));
        return;
      }

      const cols = columnsRef.current;
      const isShift = e.shiftKey;

      if (e.key === "ArrowRight") {
        e.preventDefault();
        const next = focusIndex == null ? 0 : Math.min(focusIndex + 1, items.length - 1);
        if (isShift && anchorIndex != null) {
          rangeSelect(anchorIndex, next);
        } else {
          selectOnly(next);
        }
        scrollTileIntoView(next);
        autoLoadIfNeeded(next);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        const next = focusIndex == null ? 0 : Math.max(focusIndex - 1, 0);
        if (isShift && anchorIndex != null) {
          rangeSelect(anchorIndex, next);
        } else {
          selectOnly(next);
        }
        scrollTileIntoView(next);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = focusIndex == null ? 0 : Math.min(focusIndex + cols, items.length - 1);
        if (isShift && anchorIndex != null) {
          rangeSelect(anchorIndex, next);
        } else {
          selectOnly(next);
        }
        scrollTileIntoView(next);
        autoLoadIfNeeded(next);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const next = focusIndex == null ? 0 : Math.max(focusIndex - cols, 0);
        if (isShift && anchorIndex != null) {
          rangeSelect(anchorIndex, next);
        } else {
          selectOnly(next);
        }
        scrollTileIntoView(next);
      } else if (e.key === " ") {
        e.preventDefault();
        if (selectedIndices.size > 0) {
          setPreviewOpen((prev) => !prev);
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [focusIndex, anchorIndex, selectedIndices, previewOpen, items.length, showSummary, showResumeModal, confirmDeleteRoot, setup?.isReady]);

  function scrollTileIntoView(index: number) {
    const grid = gridRef.current;
    if (!grid) return;
    const tile = grid.children[index] as HTMLElement | undefined;
    tile?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function autoLoadIfNeeded(index: number) {
    const cols = columnsRef.current;
    if (index >= items.length - cols * 2 && canLoadMore) {
      void onLoadMore();
    }
  }

  // Auto-dismiss toasts
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 10000);
    return () => clearTimeout(t);
  }, [error]);

  async function pollRuntimeAndScans() {
    try {
      const ids = trackedJobIds;
      const [setupStatus, runtimeStatus, scans, ...trackedResults] = await Promise.all([
        getSetupStatus(),
        getRuntimeStatus(),
        listActiveScans(),
        ...ids.map((id) => getScanJob(id).catch(() => null))
      ]);
      setSetup(setupStatus);
      setRuntime(runtimeStatus);
      setActiveScans(scans);

      if (ids.length === 0) return;

      const trackedJobs = trackedResults.filter((j): j is ScanJobStatus => j !== null);

      const stillTracked: number[] = [];
      const justCompleted: ScanJobStatus[] = [];
      let maxProcessed = 0;
      let anyRunning = false;

      for (const job of trackedJobs) {
        if (job.status === "running" || job.status === "pending" || job.status === "interrupted") {
          stillTracked.push(job.id);
          if (job.status === "running") {
            anyRunning = true;
            if (job.processedFiles > maxProcessed) maxProcessed = job.processedFiles;
          }
        } else if (job.status === "completed") {
          justCompleted.push(job);
        } else if (job.status === "failed") {
          setError(job.errorText || `Scan failed for ${job.rootPath.split("/").pop()}`);
        }
      }

      // Live-refresh grid when files are being processed
      if (anyRunning && maxProcessed > lastProcessedRef.current) {
        lastProcessedRef.current = maxProcessed;
        const liveLimit = Math.max(PAGE_SIZE, Math.min(items.length, MAX_ITEMS));
        void runSearch(0, false, liveLimit);
        void refreshRoots();
      }

      if (justCompleted.length > 0) {
        lastProcessedRef.current = 0;
        setCompletedJobs((prev) => [...prev, ...justCompleted]);
        const stats = await ensureDatabase();
        setDbStats(stats);
        await refreshRoots();
        await runSearch(0, false);
      }

      setTrackedJobIds(stillTracked);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function runSearch(offset: number, append: boolean, limitOverride?: number) {
    const reqId = ++requestIdRef.current;
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const response = await searchImages({
        query,
        limit: limitOverride ?? PAGE_SIZE,
        offset,

        mediaTypes: selectedMediaType ? [selectedMediaType] : undefined,
        rootScope: selectedRootId ? [selectedRootId] : undefined
      });
      if (reqId !== requestIdRef.current) return;
      applySearchResponse(response, append);
    } catch (err) {
      if (reqId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (reqId !== requestIdRef.current) return;
      setLoading(false);
      setLoadingMore(false);
    }
  }

  function applySearchResponse(response: SearchResponse, append: boolean) {
    setTotal(response.total);
    if (append) {
      setItems((prev) => [...prev, ...response.items]);
    } else {
      setItems(response.items);
      setSelectedIndices(new Set());
      setFocusIndex(null);
      setAnchorIndex(null);
    }
  }

  async function onLoadMore() {
    if (!canLoadMore || loadingMore) return;
    await runSearch(items.length, true);
  }

  async function onPickAndScan() {
    if (readOnly) return;
    if (setup && !setup.isReady) {
      setError("Setup is incomplete. Finish Ollama setup before starting scans.");
      return;
    }
    try {
      const selected = await open({ directory: true, multiple: false, title: "Select folder to scan" });
      if (!selected) return;
      setError(null);
      setCompletedJobs([]);
      const job = await startScan(selected as string);
      setTrackedJobIds((prev) => [...prev, job.id]);
      lastProcessedRef.current = 0;
      setNotice(`Scan started for ${job.rootPath.split("/").pop()}`);
      await refreshRoots();
      await pollRuntimeAndScans();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onCancelScan(scan: ScanJobStatus) {
    if (readOnly) return;
    try {
      await cancelScan(scan.id);
      setNotice(`Cancelling scan for ${scan.rootPath.split("/").pop()}...`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onResumeScan(scan: ScanJobStatus) {
    if (readOnly) return;
    try {
      const job = await startScan(scan.rootPath);
      setTrackedJobIds((prev) => [...prev, job.id]);
      setCompletedJobs([]);
      lastProcessedRef.current = 0;
      setNotice(`Resuming scan for ${job.rootPath.split("/").pop()}`);
      await pollRuntimeAndScans();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onResumeAllInterrupted() {
    setShowResumeModal(false);
    const newIds: number[] = [];
    for (const scan of activeScans.filter((s) => s.status === "interrupted")) {
      try {
        const job = await startScan(scan.rootPath);
        newIds.push(job.id);
        lastProcessedRef.current = 0;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    if (newIds.length > 0) {
      setTrackedJobIds((prev) => [...prev, ...newIds]);
      setCompletedJobs([]);
    }
    await pollRuntimeAndScans();
  }

  async function onDeleteRoot(root: RootInfo) {
    if (readOnly) return;
    setConfirmDeleteRoot(null);
    try {
      const result = await removeRoot(root.id);
      if (selectedRootId === root.id) setSelectedRootId(null);
      setNotice(`Removed "${root.rootName}": ${result.filesRemoved} files purged.`);
      await refreshRoots();
      const stats = await ensureDatabase();
      setDbStats(stats);
      await runSearch(0, false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onCleanupOllama() {
    try {
      const result = await cleanupOllamaModels();
      setNotice(`Unloaded ${result.stoppedModels}/${result.runningModels} model(s).`);
      await pollRuntimeAndScans();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onSetupDownload() {
    try {
      setError(null);
      await startSetupDownload();
      await pollRuntimeAndScans();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onRecheckSetup() {
    await pollRuntimeAndScans();
  }

  function onWindowClose() {
    // Fire cleanup best-effort, don't wait — ollama commands can hang
    cleanupOllamaModels().catch(() => {});
    void appWindow.destroy();
  }

  function thumbnailSrc(item: SearchItem): string | null {
    if (item.thumbnailPath) {
      return convertFileSrc(item.thumbnailPath);
    }
    return null;
  }

  function scanForRoot(rootId: number): ScanJobStatus | undefined {
    return activeScans.find((s) => s.rootId === rootId && s.status === "running");
  }

  function selectOnly(idx: number) {
    setSelectedIndices(new Set([idx]));
    setFocusIndex(idx);
    setAnchorIndex(idx);
  }

  function toggleSelect(idx: number) {
    setSelectedIndices(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
    setFocusIndex(idx);
    setAnchorIndex(idx);
  }

  function rangeSelect(from: number, to: number) {
    const lo = Math.min(from, to), hi = Math.max(from, to);
    setSelectedIndices(prev => {
      const next = new Set(prev);
      for (let i = lo; i <= hi; i++) next.add(i);
      return next;
    });
    setFocusIndex(to);
  }

  function onTileClick(idx: number, e: React.MouseEvent) {
    if (e.ctrlKey || e.metaKey) {
      toggleSelect(idx);
    } else if (e.shiftKey && anchorIndex != null) {
      rangeSelect(anchorIndex, idx);
    } else {
      selectOnly(idx);
    }
  }

  function onTileDoubleClick(idx: number) {
    selectOnly(idx);
    setPreviewOpen(true);
  }

  function fileName(relPath: string): string {
    const i = relPath.lastIndexOf("/");
    return i >= 0 ? relPath.slice(i + 1) : relPath;
  }

  function formatElapsed(startedAt: number, completedAt: number | null | undefined): string {
    if (!completedAt) return "n/a";
    const totalSecs = completedAt - startedAt;
    if (totalSecs < 60) return `${totalSecs}s`;
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    if (mins < 60) return `${mins}m ${secs}s`;
    const hours = Math.floor(mins / 60);
    return `${hours}h ${mins % 60}m`;
  }

  return (
    <div className="app-shell">
      {/* ── Setup Modal ── */}
      {setup && !setup.isReady && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="setup-modal">
            <h2>First-Time Setup</h2>
            <p>Sherlock needs local Ollama service and required model(s) before scanning.</p>
            <div className="setup-status-grid">
              <div>
                <strong>Ollama</strong>
                <p>{setup.ollamaAvailable ? "Running" : "Not detected"}</p>
              </div>
              <div>
                <strong>Required</strong>
                <p>{setup.requiredModels.join(", ")}</p>
              </div>
              <div>
                <strong>Missing</strong>
                <p>{setup.missingModels.length ? setup.missingModels.join(", ") : "None"}</p>
              </div>
            </div>
            <ul className="setup-instructions">
              {setup.instructions.map((instruction) => (
                <li key={instruction}>{instruction}</li>
              ))}
            </ul>
            <div className="progress-wrap">
              <progress value={setup.download.progressPct} max={100} />
              <span>{setup.download.progressPct.toFixed(1)}%</span>
            </div>
            <p className="setup-download-text">{setup.download.message}</p>
            <div className="setup-actions">
              <button type="button" onClick={onRecheckSetup}>Recheck</button>
              <button
                type="button"
                onClick={onSetupDownload}
                disabled={
                  !setup.ollamaAvailable ||
                  setup.missingModels.length === 0 ||
                  setup.download.status === "running"
                }
              >
                {setup.download.status === "running" ? "Downloading..." : "Download model"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Resume Interrupted Scans Modal ── */}
      {showResumeModal && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="resume-modal">
            <h2>Interrupted Scans</h2>
            <p>The following scans were interrupted and can be resumed:</p>
            <ul className="resume-scan-list">
              {activeScans
                .filter((s) => s.status === "interrupted")
                .map((scan) => (
                  <li key={scan.id}>
                    <strong>{scan.rootPath.split("/").pop()}</strong>
                    <span> — {scan.processedFiles}/{scan.totalFiles} files processed</span>
                  </li>
                ))}
            </ul>
            <div className="resume-actions">
              <button type="button" onClick={() => setShowResumeModal(false)}>Later</button>
              <button type="button" onClick={onResumeAllInterrupted}>Resume Now</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Scan Summary Modal ── */}
      {showSummary && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="summary-modal">
            <h2>Scan Complete</h2>
            <table className="summary-table">
              <thead>
                <tr>
                  <th>Folder</th>
                  <th>Files</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {completedJobs.map((job) => (
                  <tr key={job.id}>
                    <td title={job.rootPath}>{job.rootPath.split("/").pop()}</td>
                    <td>{job.processedFiles}</td>
                    <td>{formatElapsed(job.startedAt, job.completedAt)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td><strong>Total</strong></td>
                  <td><strong>{completedJobs.reduce((s, j) => s + j.processedFiles, 0)}</strong></td>
                  <td>
                    <strong>
                      {formatElapsed(
                        Math.min(...completedJobs.map((j) => j.startedAt)),
                        Math.max(...completedJobs.map((j) => j.completedAt ?? j.updatedAt))
                      )}
                    </strong>
                  </td>
                </tr>
              </tfoot>
            </table>
            <div className="summary-actions">
              <button type="button" onClick={() => setCompletedJobs([])}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Preview Modal ── */}
      {previewItems.length > 0 && (
        <div className="modal-overlay preview-overlay" onClick={() => setPreviewOpen(false)} role="dialog" aria-modal="true">
          <div className="preview-modal" onClick={(e) => e.stopPropagation()}>
            <button className="preview-close" onClick={() => setPreviewOpen(false)} type="button" aria-label="Close preview">
              &times;
            </button>
            {/* Nav buttons only for single-select preview */}
            {previewItems.length === 1 && singlePreviewIndex != null && singlePreviewIndex > 0 && (
              <button
                className="preview-nav preview-nav-left"
                onClick={() => {
                  const next = Math.max(0, singlePreviewIndex - 1);
                  selectOnly(next);
                }}
                type="button"
                aria-label="Previous image"
              >&#8249;</button>
            )}
            {previewItems.length === 1 && singlePreviewIndex != null && singlePreviewIndex < items.length - 1 && (
              <button
                className="preview-nav preview-nav-right"
                onClick={() => {
                  const next = Math.min(items.length - 1, singlePreviewIndex + 1);
                  selectOnly(next);
                  autoLoadIfNeeded(next);
                }}
                type="button"
                aria-label="Next image"
              >&#8250;</button>
            )}
            {/* Single image preview */}
            {previewItems.length === 1 && (
              <div className="preview-image-wrap">
                <img src={convertFileSrc(previewItems[0].absPath)} alt={previewItems[0].relPath} />
              </div>
            )}
            {/* Collage preview (2-4 images) */}
            {previewItems.length >= 2 && (
              <div className="preview-collage" data-count={previewItems.length}>
                {previewItems.map(item => (
                  <div key={item.id} className="preview-collage-cell">
                    <img src={convertFileSrc(item.absPath)} alt={item.relPath} />
                  </div>
                ))}
              </div>
            )}
            <div className="preview-info">
              {previewItems.length === 1 ? (
                <>
                  <h3 title={previewItems[0].relPath}>{previewItems[0].relPath}</h3>
                  <p className="preview-desc">{previewItems[0].description || "No description"}</p>
                  <div className="preview-meta">
                    <span className="badge">{previewItems[0].mediaType}</span>
                    <span>Confidence: {previewItems[0].confidence.toFixed(2)}</span>
                    <span>{(previewItems[0].sizeBytes / 1024).toFixed(0)} KB</span>
                  </div>
                </>
              ) : (
                <h3>{selectedIndices.size} files selected</h3>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Root Confirmation ── */}
      {confirmDeleteRoot && (
        <div className="modal-overlay" onClick={() => setConfirmDeleteRoot(null)} role="dialog" aria-modal="true">
          <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Remove folder?</h3>
            <p>
              This will remove <strong>{confirmDeleteRoot.rootName}</strong> and
              all {confirmDeleteRoot.fileCount} indexed files from the database and cache.
            </p>
            <p className="confirm-path">{confirmDeleteRoot.rootPath}</p>
            <p className="confirm-note">Original files on disk will not be touched.</p>
            <div className="confirm-actions">
              <button type="button" onClick={() => setConfirmDeleteRoot(null)}>Cancel</button>
              <button type="button" className="danger-btn" onClick={() => onDeleteRoot(confirmDeleteRoot)}>
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Titlebar ── */}
      <div className="titlebar" data-tauri-drag-region>
        <span>Frank Sherlock</span>
        <div className="titlebar-controls">
          <button type="button" onClick={() => appWindow.minimize()} aria-label="Minimize">&#x2500;</button>
          <button type="button" onClick={() => appWindow.toggleMaximize()} aria-label="Maximize">&#x25A1;</button>
          <button type="button" className="close" onClick={onWindowClose} aria-label="Close">&#x2715;</button>
        </div>
      </div>

      {/* ── Read-Only Banner ── */}
      {readOnly && (
        <div className="readonly-banner">
          Read-only mode — database cannot be modified
        </div>
      )}

      {/* ── Main Area ── */}
      <div className="main-area">
        {/* ── Sidebar ── */}
        <aside className="sidebar">
          <div className="sidebar-section">
            <span>Folders</span>
            {!readOnly && (
              <button
                type="button"
                className="sidebar-add-btn"
                onClick={onPickAndScan}
                disabled={setup ? !setup.isReady : true}
                title="Add folder to scan"
              >+</button>
            )}
          </div>

          {roots.length === 0 && (
            <div className="sidebar-empty">No folders scanned yet</div>
          )}

          <div className="root-list">
            {roots.map((root) => {
              const scan = scanForRoot(root.id);
              const isSelected = selectedRootId === root.id;
              const progress = scan?.totalFiles
                ? Math.min(100, (scan.processedFiles / Math.max(1, scan.totalFiles)) * 100)
                : 0;
              return (
                <div
                  key={root.id}
                  className={`root-card${isSelected ? " selected" : ""}`}
                  onClick={() => setSelectedRootId(isSelected ? null : root.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedRootId(isSelected ? null : root.id);
                    }
                  }}
                >
                  <div className="root-card-header">
                    <span className="root-card-icon">&#128193;</span>
                    <span className="root-card-name" title={root.rootPath}>{root.rootName}</span>
                    {!readOnly && (
                      <button
                        type="button"
                        className="root-card-delete"
                        onClick={(e) => { e.stopPropagation(); setConfirmDeleteRoot(root); }}
                        title="Remove folder"
                        aria-label={`Remove ${root.rootName}`}
                      >&times;</button>
                    )}
                  </div>
                  <div className="root-card-meta">
                    <span>{root.fileCount.toLocaleString()} files</span>
                  </div>
                  {scan && (
                    <div className="root-card-scan">
                      <progress value={progress} max={100} />
                      <span>{scan.processedFiles}/{scan.totalFiles}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Running scans */}
          {runningScans.map((scan) => {
            const pct = scan.totalFiles
              ? Math.min(100, (scan.processedFiles / Math.max(1, scan.totalFiles)) * 100)
              : 0;
            return (
              <div key={scan.id} className="sidebar-scan-progress">
                <div className="sidebar-scan-progress-header">
                  {scan.rootPath.split("/").pop()}: {scan.processedFiles} / {scan.totalFiles} ({pct.toFixed(1)}%)
                </div>
                <progress value={pct} max={100} />
                <div className="sidebar-scan-meta">
                  +{scan.added} new, {scan.modified} mod, {scan.moved} moved
                </div>
                {!readOnly && <button type="button" onClick={() => onCancelScan(scan)}>Cancel</button>}
              </div>
            );
          })}
          {/* Interrupted scans */}
          {interruptedScans.map((scan) => (
            <div key={scan.id} className="sidebar-scan-progress">
              <div>Interrupted: {scan.rootPath.split("/").pop()} at {scan.processedFiles} / {scan.totalFiles}</div>
              {!readOnly && <button type="button" onClick={() => onResumeScan(scan)}>Resume</button>}
            </div>
          ))}

          <div className="sidebar-spacer" />

          <div className="sidebar-section"><span>Info</span></div>
          <div className="sidebar-item">Files: <span>{dbStats?.files ?? "..."}</span></div>
          <div className="sidebar-item">Roots: <span>{dbStats?.roots ?? "..."}</span></div>

          <div className="sidebar-section"><span>Actions</span></div>
          <button
            type="button"
            className="sidebar-action-btn"
            onClick={onCleanupOllama}
            disabled={isScanning || (runtime?.loadedModels?.length ?? 0) === 0}
            title={isScanning ? "Cannot unload during scan" : (runtime?.loadedModels?.length ?? 0) === 0 ? "No models loaded" : "Unload all loaded models"}
          >Unload Models</button>
        </aside>

        {/* ── Content ── */}
        <div className="content">
          <div className="toolbar">
            <input
              type="search"
              placeholder="Search images..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search query"
            />
            <select
              value={selectedMediaType}
              onChange={(e) => setSelectedMediaType(e.target.value)}
              aria-label="Media type filter"
            >
              {mediaTypeOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt ? opt : "all types"}
                </option>
              ))}
            </select>
          </div>

          <div className="content-body">
            <div className="results-meta">
              <span>
                {items.length} of {total} results
                {selectedRootId != null && roots.length > 0 && (
                  <> in <strong>{roots.find((r) => r.id === selectedRootId)?.rootName ?? "..."}</strong></>
                )}
              </span>
              {loading && <span>Searching...</span>}
              {isScanning && <span className="scanning-indicator">Scanning...</span>}
            </div>

            <div className="grid" role="list" ref={gridRef}>
              {items.map((item, idx) => {
                const thumb = thumbnailSrc(item);
                return (
                  <article
                    key={item.id}
                    className={`tile${selectedIndices.has(idx) ? " tile-selected" : ""}${focusIndex === idx ? " tile-focused" : ""}`}
                    role="listitem"
                    onClick={(e) => onTileClick(idx, e)}
                    onDoubleClick={() => onTileDoubleClick(idx)}
                  >
                    <div className="tile-thumb">
                      {thumb ? (
                        <img
                          src={thumb}
                          alt={item.relPath}
                          loading="lazy"
                        />
                      ) : (
                        <div className="tile-thumb-placeholder">
                          <span className="badge">{item.mediaType}</span>
                        </div>
                      )}
                    </div>
                    <div className="tile-filename">
                      <span>{fileName(item.relPath)}</span>
                    </div>
                    <div className="tile-hover-overlay">
                      <h3>{fileName(item.relPath)}</h3>
                      <p>{item.description || "No description yet"}</p>
                      <div className="tile-meta">
                        <span className="badge">{item.mediaType}</span>
                        <span>{item.confidence.toFixed(2)}</span>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>

            {canLoadMore && (
              <div ref={sentinelRef} className="load-sentinel">
                {loadingMore && <span>Loading...</span>}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Status Bar ── */}
      <div className="statusbar">
        <span>
          VRAM:{" "}
          {runtime?.vramUsedMib != null && runtime?.vramTotalMib != null
            ? `${runtime.vramUsedMib}/${runtime.vramTotalMib} MiB`
            : "n/a"}
        </span>
        <span>Files: {dbStats?.files ?? "..."}</span>
        {isScanning && (
          <span>Scanning: {runningScans.length} active job(s)</span>
        )}
        {selectedIndices.size > 0 && (
          <span>{selectedIndices.size} selected</span>
        )}
        <span className="spacer" />
        <span>Model: {runtime?.currentModel || "none"}</span>
      </div>

      {/* ── Toasts ── */}
      <div className="toast-container">
        {notice && <div className="toast notice">{notice}</div>}
        {error && <div className="toast error">{error}</div>}
      </div>
    </div>
  );
}
