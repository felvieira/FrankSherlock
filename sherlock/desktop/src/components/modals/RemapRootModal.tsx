import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "../../utils";
import ModalOverlay from "./ModalOverlay";
import "./shared-modal.css";
import "./RemapRootModal.css";

interface RemapReport {
  rootsUpdated: number;
  filesUpdated: number;
  scanJobsUpdated: number;
}

type Props = {
  oldPath: string;
  onClose: () => void;
  onRemapped: (report: RemapReport) => void;
};

export default function RemapRootModal({ oldPath, onClose, onRemapped }: Props) {
  const [newPath, setNewPath] = useState(oldPath);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<RemapReport | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const result = await invoke<RemapReport>("remap_root_cmd", { oldPath, newPath });
      setReport(result);
      onRemapped(result);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalOverlay onBackdropClick={busy ? undefined : onClose}>
      <div
        className="modal-base remap-root-modal"
        role="dialog"
        aria-label="Remap root"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Remap Root</h3>
        <p className="remap-root-subtle">
          Old path: <code>{oldPath}</code>
        </p>
        <label className="remap-root-field">
          <span>New path</span>
          <input
            aria-label="new path"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            disabled={busy}
            autoFocus
          />
        </label>
        <p className="remap-root-hint">
          Use this when you've changed a drive letter or moved the folder. The file index stays — no re-scan needed.
        </p>
        {error && (
          <div role="alert" className="remap-root-error">
            {error}
          </div>
        )}
        {report && (
          <div className="remap-root-success">
            Remap complete: {report.filesUpdated.toLocaleString()} file{report.filesUpdated === 1 ? "" : "s"} updated.
          </div>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            {report ? "Close" : "Cancel"}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !newPath || newPath === oldPath || report !== null}
          >
            {busy ? "Remapping…" : "Remap"}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
