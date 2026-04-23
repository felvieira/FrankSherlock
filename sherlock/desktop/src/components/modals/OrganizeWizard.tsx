import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import ModalOverlay from "./ModalOverlay";
import { buildOrganizePlan, executeOrganizePlan } from "../../api";
import { errorMessage } from "../../utils";
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
    setError(null);
    try {
      const folder = await openDialog({ directory: true, multiple: false });
      if (typeof folder !== "string") return;
      setBaseDir(folder);
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
    setError(null);
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
    <ModalOverlay onBackdropClick={onClose} onEscape={onClose}>
      <div className="modal-base organize-wizard" onClick={(e) => e.stopPropagation()}>
        <h3>Organize by Events</h3>

        {stage === "pick" && (
          <>
            <p>
              Pick a destination folder. Frank Sherlock will suggest a folder per event based on
              AI-detected tags, location, and dates.
            </p>
            <button type="button" onClick={pickFolder}>
              Choose folder…
            </button>
          </>
        )}

        {stage === "review" && plan && (
          <>
            <p>
              Destination: <code>{baseDir}</code>
            </p>
            <p>
              <label>
                <input
                  type="radio"
                  checked={mode === "copy"}
                  onChange={() => setMode("copy")}
                />{" "}
                Copy (safe — originals stay)
              </label>{" "}
              <label>
                <input
                  type="radio"
                  checked={mode === "move"}
                  onChange={() => setMode("move")}
                />{" "}
                Move (faster, atomic with DB)
              </label>
            </p>
            <div className="organize-list">
              {plan.proposals.map((p) => (
                <div
                  key={p.eventId}
                  className={`organize-row ${skip.has(p.eventId) ? "skipped" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={!skip.has(p.eventId)}
                    onChange={(e) => {
                      const next = new Set(skip);
                      if (e.target.checked) next.delete(p.eventId);
                      else next.add(p.eventId);
                      setSkip(next);
                    }}
                  />
                  <input
                    type="text"
                    value={rename[p.eventId] ?? p.folderName}
                    onChange={(e) =>
                      setRename({ ...rename, [p.eventId]: e.target.value })
                    }
                  />
                  <span className="organize-count">{p.fileIds.length} files</span>
                </div>
              ))}
            </div>
            {plan.unassignedCount > 0 && (
              <p className="organize-note">
                {plan.unassignedCount} files not in any event will stay in place.
              </p>
            )}
            <div className="modal-actions">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="button" onClick={runExecute}>
                Execute ({mode})
              </button>
            </div>
          </>
        )}

        {stage === "running" && <p>Organizing…</p>}

        {stage === "done" && result && (
          <>
            <h4>Done</h4>
            <p>
              Processed: <strong>{result.processed}</strong> · Skipped: {result.skipped}
            </p>
            {result.errors.length > 0 && (
              <details>
                <summary>{result.errors.length} errors</summary>
                <ul>
                  {result.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </details>
            )}
            <div className="modal-actions">
              <button type="button" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}

        {error && <div className="organize-error">{error}</div>}
      </div>
    </ModalOverlay>
  );
}
