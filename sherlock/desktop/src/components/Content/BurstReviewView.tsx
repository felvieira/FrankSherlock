import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { deleteFiles, findBurstsWithBest, getFileProperties } from "../../api";
import { errorMessage } from "../../utils";
import type { BurstWithBest } from "../../types";
import "./shared-tool-view.css";
import "./BurstReviewView.css";

type Props = { onBack: () => void };

type BurstFileInfo = {
  id: number;
  absPath: string;
};

export default function BurstReviewView({ onBack }: Props) {
  const [bursts, setBursts] = useState<BurstWithBest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [keep, setKeep] = useState<Record<number, number>>({});
  const [filePaths, setFilePaths] = useState<Record<number, string>>({});

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const list = await findBurstsWithBest();
      setBursts(list);
      const def: Record<number, number> = {};
      list.forEach((b, i) => {
        def[i] = b.bestFileId;
      });
      setKeep(def);

      const allIds = Array.from(new Set(list.flatMap((b) => b.memberIds)));
      const entries: BurstFileInfo[] = [];
      await Promise.all(
        allIds.map(async (id) => {
          try {
            const props = await getFileProperties(id);
            entries.push({ id, absPath: props.absPath });
          } catch {
            /* ignore per-file failure */
          }
        }),
      );
      const map: Record<number, string> = {};
      entries.forEach((e) => {
        map[e.id] = e.absPath;
      });
      setFilePaths(map);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function deleteOthers() {
    const toDelete: number[] = [];
    bursts.forEach((b, i) => {
      b.memberIds.forEach((id) => {
        if (id !== keep[i]) toDelete.push(id);
      });
    });
    if (toDelete.length === 0) return;
    if (
      !confirm(
        `Delete ${toDelete.length} burst duplicate${toDelete.length !== 1 ? "s" : ""} (keeping the shot you marked in each burst)?`,
      )
    ) {
      return;
    }
    try {
      await deleteFiles(toDelete);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="tool-view bursts-view">
      <div className="tool-toolbar">
        <div className="tool-toolbar-stats">
          <strong>{bursts.length}</strong> burst{bursts.length !== 1 ? "s" : ""} detected
        </div>
        <button type="button" onClick={deleteOthers} disabled={bursts.length === 0 || loading}>
          Delete non-keepers
        </button>
        <button type="button" onClick={onBack}>
          Close
        </button>
      </div>
      <div className="tool-body">
        {loading && <div className="tool-loading">Analyzing bursts…</div>}
        {error && <div className="tool-empty">{error}</div>}
        {!loading && !error && bursts.length === 0 && (
          <div className="tool-empty">No bursts found (need ≥3 shots &lt;2s apart).</div>
        )}
        {!loading &&
          !error &&
          bursts.map((b, i) => (
            <div key={i} className="burst-card">
              <div className="burst-header">
                AI picked <strong>file {b.bestFileId}</strong> ({b.reason})
              </div>
              <div className="burst-members">
                {b.memberIds.map((id) => {
                  const path = filePaths[id];
                  const isChosen = keep[i] === id;
                  return (
                    <label
                      key={id}
                      className={`burst-pick ${isChosen ? "chosen" : ""}`}
                    >
                      <input
                        type="radio"
                        name={`burst-${i}`}
                        checked={isChosen}
                        onChange={() => setKeep({ ...keep, [i]: id })}
                      />
                      {path ? (
                        <img src={convertFileSrc(path)} alt="" loading="lazy" />
                      ) : (
                        <span className="burst-pick-placeholder">#{id}</span>
                      )}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
