import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { errorMessage } from "../../utils";
import { formatBytes } from "../../utils/format";
import ModalOverlay from "./ModalOverlay";
import "./shared-modal.css";
import "./ImportCatalogModal.css";

interface ImportReport {
  entries: number;
  bytes: number;
}

type Props = { onClose: () => void };

type Step = "confirm" | "busy" | "success" | "error";

export default function ImportCatalogModal({ onClose }: Props) {
  const [step, setStep] = useState<Step>("confirm");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleChooseFile() {
    try {
      const picked = await open({
        filters: [{ name: "Zip", extensions: ["zip"] }],
        multiple: false,
      });
      const bundle = typeof picked === "string" ? picked : null;
      if (!bundle) {
        // Treat cancel as stay-on-confirm so the user can retry or cancel explicitly.
        return;
      }
      setStep("busy");
      setError(null);
      const result = await invoke<ImportReport>("import_catalog_cmd", { bundle });
      setReport(result);
      setStep("success");
    } catch (e) {
      setError(errorMessage(e));
      setStep("error");
    }
  }

  const showExistingCatalogHint =
    step === "error" && !!error && /refusing to overwrite existing catalog/i.test(error);

  return (
    <ModalOverlay onBackdropClick={step === "busy" ? undefined : onClose}>
      <div
        className="modal-base import-catalog-modal"
        role="dialog"
        aria-label="Import catalog"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Import Catalog</h3>

        {step === "confirm" && (
          <>
            <p className="import-catalog-warning">
              Importing will restore a catalog bundle into this installation. If a
              catalog already exists here, the import will be refused.
            </p>
            <div className="modal-actions">
              <button type="button" onClick={onClose}>Cancel</button>
              <button type="button" onClick={handleChooseFile}>Choose file…</button>
            </div>
          </>
        )}

        {step === "busy" && (
          <>
            <p className="import-catalog-status">Importing…</p>
            <div className="modal-actions">
              <button type="button" disabled>Close</button>
            </div>
          </>
        )}

        {step === "success" && report && (
          <>
            <p className="import-catalog-status">
              Imported <strong>{report.entries.toLocaleString()}</strong> file
              {report.entries === 1 ? "" : "s"} ({formatBytes(report.bytes)}).
            </p>
            <p className="import-catalog-hint">
              Restart recommended so the app picks up the restored catalog.
            </p>
            <div className="modal-actions">
              <button type="button" onClick={onClose}>Close</button>
            </div>
          </>
        )}

        {step === "error" && (
          <>
            <div role="alert" className="import-catalog-error">
              {error}
            </div>
            {showExistingCatalogHint && (
              <p className="import-catalog-hint">
                Tip: export or move the existing catalog first.
              </p>
            )}
            <div className="modal-actions">
              <button type="button" onClick={onClose}>Close</button>
              <button type="button" onClick={handleChooseFile}>Try another file…</button>
            </div>
          </>
        )}
      </div>
    </ModalOverlay>
  );
}
