import { useEffect, useState } from "react";
import { listEvents, recomputeEvents, suggestEventNames } from "../../api";
import { errorMessage } from "../../utils";
import type { EventSummary } from "../../types";
import "./shared-tool-view.css";
import "./EventsView.css";

type Props = {
  onBack: () => void;
  onOpenEvent: (eventId: number) => void;
  onOrganize?: () => void;
};

export default function EventsView({ onBack, onOpenEvent, onOrganize }: Props) {
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        let list = await listEvents();
        if (list.length === 0) list = await recomputeEvents();
        await suggestEventNames();
        list = await listEvents();
        setEvents(list);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="tool-view events-view">
      <div className="tool-toolbar">
        <div className="tool-toolbar-stats">
          <strong>{events.length}</strong> events detected
        </div>
        {onOrganize && (
          <button type="button" onClick={onOrganize} disabled={events.length === 0}>
            Organize…
          </button>
        )}
        <button type="button" onClick={onBack}>Close</button>
      </div>
      <div className="tool-body">
        {loading && <div className="tool-loading">Detecting events…</div>}
        {error && <div className="tool-empty">{error}</div>}
        {!loading && !error && events.length === 0 && (
          <div className="tool-empty">No events detected yet. Scan a library first.</div>
        )}
        <ul className="events-list">
          {events.map((e) => (
            <li key={e.id} className="event-card" onClick={() => onOpenEvent(e.id)}>
              <div className="event-name">{e.name}</div>
              <div className="event-meta">
                {new Date(e.startedAt * 1000).toLocaleDateString()} ·{" "}
                {e.fileCount} photo{e.fileCount !== 1 ? "s" : ""}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
