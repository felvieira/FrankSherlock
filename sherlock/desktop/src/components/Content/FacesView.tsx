import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { SearchItem } from "../../types";
import { listFilesWithFaces } from "../../api";
import { fileName } from "../../utils/format";
import "./FacesView.css";

type Props = {
  onBack: () => void;
  onPreview: (item: SearchItem) => void;
};

export default function FacesView({ onBack, onPreview }: Props) {
  const [items, setItems] = useState<SearchItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listFilesWithFaces([])
      .then((result) => {
        if (!cancelled) setItems(result);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const totalFaces = items.reduce((sum, item) => sum + (item.faceCount ?? 0), 0);

  return (
    <div className="faces-view">
      <div className="faces-toolbar">
        <div className="faces-stats">
          <strong>{items.length}</strong> image{items.length !== 1 ? "s" : ""} with faces,
          {" "}<strong>{totalFaces}</strong> face{totalFaces !== 1 ? "s" : ""} total
        </div>
        <button type="button" onClick={onBack}>Back</button>
      </div>

      <div className="faces-body">
        {loading && <div className="faces-loading">Loading...</div>}
        {!loading && items.length === 0 && (
          <div className="faces-empty">
            No faces detected yet. Right-click a folder and select &quot;Detect Faces&quot; to scan for faces.
          </div>
        )}
        {!loading && items.length > 0 && (
          <div className="faces-grid">
            {items.map((item) => (
              <div
                key={item.id}
                className="faces-tile"
                onClick={() => onPreview(item)}
                title={item.relPath}
              >
                {item.thumbnailPath ? (
                  <img src={convertFileSrc(item.thumbnailPath)} alt="" loading="lazy" />
                ) : (
                  <div className="faces-tile-placeholder">No thumb</div>
                )}
                {(item.faceCount ?? 0) > 0 && (
                  <span className="faces-tile-badge">{item.faceCount}</span>
                )}
                <div className="faces-tile-info">{fileName(item.relPath)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
