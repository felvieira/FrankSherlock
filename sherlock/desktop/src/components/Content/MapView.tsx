import { useEffect, useRef, useState, useCallback } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { GpsFile, NearbyResult } from "../../types";
import { listGpsFiles } from "../../api";
import "./MapView.css";

type Props = {
  onBack: () => void;
  onSelectFiles: (ids: number[]) => void;
  onFindNearby: (lat: number, lon: number) => Promise<void>;
};

const OSM_STYLE = {
  version: 8 as const,
  sources: {
    osm: {
      type: "raster" as const,
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
      maxzoom: 19,
    },
  },
  layers: [{ id: "osm", type: "raster" as const, source: "osm" }],
};

// Exported for testing; not actually used in the module
export type { NearbyResult };

export default function MapView({ onBack, onSelectFiles, onFindNearby }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [gpsFiles, setGpsFiles] = useState<GpsFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const files = await listGpsFiles();
      setGpsFiles(files);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  useEffect(() => {
    if (!containerRef.current || loading || error) return;
    if (mapRef.current) return; // already initialized

    // Dynamic import to avoid issues with SSR/test environments
    import("maplibre-gl").then(({ Map, NavigationControl, Marker, Popup }) => {
      if (!containerRef.current) return;

      const map = new Map({
        container: containerRef.current,
        style: OSM_STYLE,
        center: gpsFiles.length > 0
          ? [gpsFiles[0].lon, gpsFiles[0].lat]
          : [0, 20],
        zoom: gpsFiles.length > 0 ? 4 : 2,
      });

      map.addControl(new NavigationControl(), "top-right");

      // Add markers
      for (const file of gpsFiles) {
        const el = document.createElement("div");
        el.className = "map-pin";
        el.title = file.filename;

        const thumbHtml = file.thumbPath
          ? `<img src="asset://localhost/${encodeURIComponent(file.thumbPath.replace(/\\/g, "/"))}" alt="" />`
          : "";

        const popup = new Popup({ offset: 16, closeButton: false })
          .setHTML(
            `<div class="map-popup">
               ${thumbHtml}
               <div class="map-popup-name">${file.filename}</div>
               <button class="map-popup-nearby" data-lat="${file.lat}" data-lon="${file.lon}">Find nearby</button>
             </div>`
          );

        const marker = new Marker({ element: el })
          .setLngLat([file.lon, file.lat])
          .setPopup(popup)
          .addTo(map);

        el.addEventListener("click", () => {
          setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(file.id)) {
              next.delete(file.id);
            } else {
              next.add(file.id);
            }
            return next;
          });
        });

        marker.getPopup().on("open", () => {
          const btn = document.querySelector<HTMLButtonElement>(".map-popup-nearby");
          if (btn) {
            btn.onclick = () => {
              const lat = parseFloat(btn.dataset.lat ?? "0");
              const lon = parseFloat(btn.dataset.lon ?? "0");
              void onFindNearby(lat, lon);
            };
          }
        });
      }

      mapRef.current = map;

      // Auto-fit to all markers
      if (gpsFiles.length > 1) {
        const lats = gpsFiles.map((f) => f.lat);
        const lons = gpsFiles.map((f) => f.lon);
        map.fitBounds(
          [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
          { padding: 60, maxZoom: 12 }
        );
      }
    }).catch(() => setError("Failed to load map library"));

    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, error, gpsFiles.length]);

  return (
    <div className="map-view">
      <div className="map-view-header">
        <button className="map-back-btn" onClick={onBack}>← Back</button>
        <span className="map-view-title">
          Map — {gpsFiles.length} file{gpsFiles.length !== 1 ? "s" : ""} with GPS
        </span>
        {selectedIds.size > 0 && (
          <button
            className="map-select-btn"
            onClick={() => onSelectFiles([...selectedIds])}
          >
            Show {selectedIds.size} selected
          </button>
        )}
      </div>

      {loading && <div className="map-loading">Loading GPS data…</div>}
      {error && <div className="map-error">{error}</div>}
      {!loading && !error && gpsFiles.length === 0 && (
        <div className="map-empty">No files with GPS coordinates found. Scan photos with EXIF location data to see them here.</div>
      )}

      <div
        ref={containerRef}
        className="map-container"
        style={{ visibility: loading || error || gpsFiles.length === 0 ? "hidden" : "visible" }}
      />
    </div>
  );
}
