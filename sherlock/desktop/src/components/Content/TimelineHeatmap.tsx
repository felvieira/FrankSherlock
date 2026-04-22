/**
 * TimelineHeatmap — compact vertical timeline sidebar widget.
 *
 * Shows one row per month (YYYY-MM), with bar width proportional to count.
 * Clicking a month injects a `from:YYYY-MM-01 to:YYYY-MM-last` token into the query.
 */
import { useEffect, useState } from "react";
import { listTimelineBuckets } from "../../api";
import type { TimelineBucket } from "../../types";
import "./TimelineHeatmap.css";

/** Return the last day of a YYYY-MM string. */
function lastDay(bucket: string): string {
  const [y, m] = bucket.split("-").map(Number);
  const d = new Date(y, m, 0); // day 0 of next month = last day of current month
  return `${bucket}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Short month label, e.g. "Jun '23". */
function monthLabel(bucket: string): string {
  const [y, m] = bucket.split("-").map(Number);
  const date = new Date(y, m - 1, 1);
  const short = date.toLocaleString("en", { month: "short" });
  return `${short} '${String(y).slice(-2)}`;
}

type Props = {
  onQueryChange: (query: string) => void;
};

export default function TimelineHeatmap({ onQueryChange }: Props) {
  const [buckets, setBuckets] = useState<TimelineBucket[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeBucket, setActiveBucket] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    listTimelineBuckets()
      .then(setBuckets)
      .catch(() => setBuckets([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="timeline-heatmap__empty">Loading…</p>;
  if (!buckets.length) return <p className="timeline-heatmap__empty">No photos yet</p>;

  const maxCount = Math.max(...buckets.map((b) => b.count), 1);

  const handleClick = (bucket: string) => {
    if (activeBucket === bucket) {
      // Deselect: clear the date range
      setActiveBucket(null);
      onQueryChange("");
    } else {
      setActiveBucket(bucket);
      const from = `${bucket}-01`;
      const to = lastDay(bucket);
      onQueryChange(`${from} ${to}`);
    }
  };

  return (
    <div className="timeline-heatmap" aria-label="Photo timeline">
      {buckets.map((b) => {
        const pct = Math.max(8, Math.round((b.count / maxCount) * 100));
        const isActive = activeBucket === b.bucket;
        return (
          <button
            key={b.bucket}
            className={`timeline-heatmap__row${isActive ? " timeline-heatmap__row--active" : ""}`}
            type="button"
            onClick={() => handleClick(b.bucket)}
            title={`${b.bucket}: ${b.count} photos`}
            aria-pressed={isActive}
          >
            <span className="timeline-heatmap__label">{monthLabel(b.bucket)}</span>
            <span className="timeline-heatmap__bar-wrap">
              <span
                className="timeline-heatmap__bar"
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="timeline-heatmap__count">{b.count}</span>
          </button>
        );
      })}
    </div>
  );
}
