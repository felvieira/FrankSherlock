import { useEffect, useState } from "react";
import { listTrips, detectTrips } from "../../api";
import { errorMessage } from "../../utils";
import type { TripSummary } from "../../types";
import "./shared-tool-view.css";
import "./TripsView.css";

type Props = {
  onBack: () => void;
  onOpenTrip: (tripId: number) => void;
};

export default function TripsView({ onBack, onOpenTrip }: Props) {
  const [trips, setTrips] = useState<TripSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        let list = await listTrips();
        if (list.length === 0) list = await detectTrips();
        setTrips(list);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="tool-view trips-view">
      <div className="tool-toolbar">
        <div className="tool-toolbar-stats">
          <strong>{trips.length}</strong> trips detected
        </div>
        <button type="button" onClick={onBack}>Close</button>
      </div>
      <div className="tool-body">
        {loading && <div className="tool-loading">Detecting trips…</div>}
        {error && <div className="tool-empty">{error}</div>}
        {!loading && !error && trips.length === 0 && (
          <div className="tool-empty">No trips detected yet.</div>
        )}
        <ul className="trips-list">
          {trips.map((t) => (
            <li key={t.id} className="trip-card" onClick={() => onOpenTrip(t.id)}>
              <div className="trip-name">{t.name}</div>
              <div className="trip-meta">
                {new Date(t.startedAt * 1000).toLocaleDateString()} –{" "}
                {new Date(t.endedAt * 1000).toLocaleDateString()} ·{" "}
                {t.eventCount} event{t.eventCount !== 1 ? "s" : ""}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
