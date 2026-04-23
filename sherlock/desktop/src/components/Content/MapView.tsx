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
    import("maplibre-gl").then(({ Map, NavigationControl, Popup }) => {
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

      map.on("load", () => {
        map.addSource("photos", {
          type: "geojson",
          cluster: true,
          clusterRadius: 50,
          clusterMaxZoom: 14,
          data: {
            type: "FeatureCollection",
            features: gpsFiles.map((f) => ({
              type: "Feature",
              geometry: { type: "Point", coordinates: [f.lon, f.lat] },
              properties: {
                id: f.id,
                filename: f.filename,
                thumbPath: f.thumbPath ?? "",
              },
            })),
          },
        });

        map.addLayer({
          id: "clusters",
          type: "circle",
          source: "photos",
          filter: ["has", "point_count"],
          paint: {
            "circle-color": "#1e88e5",
            "circle-radius": ["step", ["get", "point_count"], 15, 10, 20, 100, 28],
            "circle-stroke-width": 2,
            "circle-stroke-color": "#fff",
          },
        });

        map.addLayer({
          id: "cluster-count",
          type: "symbol",
          source: "photos",
          filter: ["has", "point_count"],
          layout: {
            "text-field": "{point_count_abbreviated}",
            "text-size": 12,
          },
          paint: { "text-color": "#fff" },
        });

        map.addLayer({
          id: "unclustered",
          type: "circle",
          source: "photos",
          filter: ["!", ["has", "point_count"]],
          paint: {
            "circle-color": "#e53935",
            "circle-radius": 6,
            "circle-stroke-width": 2,
            "circle-stroke-color": "#fff",
          },
        });

        // Cursor feedback
        map.on("mouseenter", "clusters", () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", "clusters", () => { map.getCanvas().style.cursor = ""; });
        map.on("mouseenter", "unclustered", () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", "unclustered", () => { map.getCanvas().style.cursor = ""; });

        // Click on a cluster: zoom into it
        map.on("click", "clusters", (e) => {
          const features = map.queryRenderedFeatures(e.point, { layers: ["clusters"] });
          const f = features[0];
          if (!f) return;
          const clusterId = f.properties!.cluster_id;
          const source = map.getSource("photos") as unknown as {
            getClusterExpansionZoom: (id: number, cb: (err: unknown, zoom: number) => void) => void;
          };
          source.getClusterExpansionZoom(clusterId, (err, zoom) => {
            if (err) return;
            const coords = (f.geometry as { coordinates: [number, number] }).coordinates;
            map.easeTo({ center: coords, zoom });
          });
        });

        // Click on an unclustered point: select it + show a popup with "Find nearby"
        map.on("click", "unclustered", (e) => {
          const feature = e.features?.[0];
          if (!feature) return;
          const props = feature.properties as
            | { id?: number; filename?: string; thumbPath?: string }
            | null;
          if (!props || typeof props.id !== "number") return;
          const fileId = props.id;
          const coords = (feature.geometry as { coordinates: [number, number] }).coordinates;

          setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(fileId)) {
              next.delete(fileId);
            } else {
              next.add(fileId);
            }
            return next;
          });

          const thumbHtml = props.thumbPath
            ? `<img src="asset://localhost/${encodeURIComponent(String(props.thumbPath).replace(/\\/g, "/"))}" alt="" />`
            : "";
          const filename = String(props.filename ?? "");
          const popup = new Popup({ offset: 16, closeButton: true })
            .setLngLat(coords)
            .setHTML(
              `<div class="map-popup">
                 ${thumbHtml}
                 <div class="map-popup-name">${filename}</div>
                 <button class="map-popup-nearby" data-lat="${coords[1]}" data-lon="${coords[0]}">Find nearby</button>
               </div>`
            )
            .addTo(map);
          popup.on("open", () => {
            const btn = document.querySelector<HTMLButtonElement>(".map-popup-nearby");
            if (btn) {
              btn.onclick = () => {
                const lat = parseFloat(btn.dataset.lat ?? "0");
                const lon = parseFloat(btn.dataset.lon ?? "0");
                void onFindNearby(lat, lon);
              };
            }
          });
        });

        // Auto-fit to all points
        if (gpsFiles.length > 1) {
          const lats = gpsFiles.map((f) => f.lat);
          const lons = gpsFiles.map((f) => f.lon);
          map.fitBounds(
            [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
            { padding: 60, maxZoom: 12 }
          );
        }
      });

      mapRef.current = map;
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
