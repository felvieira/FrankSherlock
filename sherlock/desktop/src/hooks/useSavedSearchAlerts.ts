import { useEffect, useRef } from "react";
import { checkSavedSearchAlerts } from "../api";

const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

type Callbacks = {
  onAlert: (name: string, count: number, query: string) => void;
};

/**
 * Polls check_saved_search_alerts every 15 minutes.
 * On matches, calls onAlert and emits a Web Notification (if permission granted).
 * The first check runs 15 minutes after mount — not immediately.
 */
export function useSavedSearchAlerts({ onAlert }: Callbacks) {
  const onAlertRef = useRef(onAlert);
  onAlertRef.current = onAlert;

  useEffect(() => {
    // Request notification permission on first mount (silently — no blocking prompt)
    if (typeof window !== "undefined" && "Notification" in window &&
        Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }

    const timerId = setInterval(async () => {
      try {
        const alerts = await checkSavedSearchAlerts();
        for (const alert of alerts) {
          // In-app callback
          onAlertRef.current(alert.name, alert.newCount, alert.query);

          // Desktop notification (best-effort)
          if (typeof window !== "undefined" && "Notification" in window &&
              Notification.permission === "granted") {
            const n = new Notification(`New matches: ${alert.name}`, {
              body: `${alert.newCount} new file(s) found for "${alert.query}"`,
              silent: false,
            });
            // Auto-close after 6 seconds
            setTimeout(() => n.close(), 6000);
          }
        }
      } catch {
        // Ignore errors — polling is best-effort
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(timerId);
  }, []);
}
