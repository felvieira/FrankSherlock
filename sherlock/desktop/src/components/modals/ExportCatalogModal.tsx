import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { errorMessage } from "../../utils";
import { formatBytes } from "../../utils/format";
import ModalOverlay from "./ModalOverlay";
import "./shared-modal.css";
import "./ExportCatalogModal.css";

interface ExportReport {
  zipPath: string;
  entries: number;
  bytes: number;
}

type Props = { onClose: () => void };

function parentDir(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(0, i) : p;
}

export default function ExportCatalogModal({ onClose }: Props) {
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ExportReport | null>(null);
  // Prevent React StrictMode double-invocation from firing two save dialogs.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;

    (async () => {
      try {
        const target = await save({
          defaultPath: "frank_sherlock_catalog.zip",
          filters: [{ name: "Zip", extensions: ["zip"] }],
        });
        if (cancelled) return;
        if (!target) {
          onClose();
          return;
        }
        const result = await invoke<ExportReport>("export_catalog_cmd", { outZip: target });
        if (cancelled) return;
        setReport(result);
      } catch (e) {
        if (cancelled) return;
        setError(errorMessage(e));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [onClose]);

  async function handleOpenFolder() {
    if (!report) return;
    try {
      await openPath(parentDir(report.zipPath));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <ModalOverlay onBackdropClick={busy ? undefined : onClose}>
      <div
        className="modal-base export-catalog-modal"
        role="dialog"
        aria-label="Export catalog"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Export Catalog</h3>
        {busy && !error && !report && (
          <p className="export-catalog-status">Exporting catalog…</p>
        )}
        {report && (
          <>
            <p className="export-catalog-status">
              Exported <strong>{report.entries.toLocaleString()}</strong> file
              {report.entries === 1 ? "" : "s"} ({formatBytes(report.bytes)}).
            </p>
            <p className="export-catalog-path">
              <code>{report.zipPath}</code>
            </p>
          </>
        )}
        {error && (
          <div role="alert" className="export-catalog-error">
            {error}
          </div>
        )}
        <div className="modal-actions">
          {report && (
            <button type="button" onClick={handleOpenFolder}>
              Open folder
            </button>
          )}
          <button type="button" onClick={onClose} disabled={busy}>
            {report || error ? "Close" : "Cancel"}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
