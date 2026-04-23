import { useState } from "react";
import ModalOverlay from "./ModalOverlay";
import { renameByTemplate } from "../../api";
import { errorMessage } from "../../utils";
import "./shared-modal.css";
import "./BatchRenameModal.css";

type Props = { fileIds: number[]; onClose: () => void };

export default function BatchRenameModal({ fileIds, onClose }: Props) {
  const [template, setTemplate] = useState(
    "{date_taken:%Y-%m-%d}_{event_name}_{counter:03}",
  );
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const r = await renameByTemplate({ fileIds, template });
      setStatus(
        `Renamed ${r.processed}${r.errors.length ? `, ${r.errors.length} errors` : ""}`,
      );
    } catch (err) {
      setStatus(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalOverlay onBackdropClick={onClose}>
      <div className="modal-base batch-rename-modal" onClick={(e) => e.stopPropagation()}>
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
          aria-label="Rename template"
        />
        {status && <p className="batch-rename-status">{status}</p>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Close</button>
          <button type="button" onClick={run} disabled={busy}>Run</button>
        </div>
      </div>
    </ModalOverlay>
  );
}
