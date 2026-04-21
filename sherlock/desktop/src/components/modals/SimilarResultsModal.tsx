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
