import { useEffect, useRef } from "react";
import { toast } from "../toast";
import { formatRange } from "./format";
import type { MagNetwork } from "./types";

/** More detections than this starting in one answer share a toast. */
const MAX_SEPARATE_TOASTS = 3;

/**
 * A toast when a magnetometer starts detecting, so a detection is noticed
 * wherever the map is scrolled. Events already open when the page loads, or
 * when the layer is turned back on, are not announced: only ones that begin
 * while you watch.
 *
 * What has been seen is the events of the last answer, and belongs to one
 * run of the server. A restarted server begins its events again, and all of
 * them began while the page watched, so a new run starts with nothing seen.
 */
export function useMagnetometerAlerts(network: MagNetwork | null) {
  const seen = useRef<{ run: string; ids: Set<string> } | null>(null);
  useEffect(() => {
    if (!network) {
      seen.current = null;
      return;
    }
    const ids = new Set(network.events.map((e) => e.event_id));
    const last = seen.current;
    seen.current = { run: network.run_id, ids };
    if (last === null) return;
    const known = last.run === network.run_id ? last.ids : new Set<string>();
    const started = network.events.filter((event) => event.active && !known.has(event.event_id));
    // As long as the map's emergency-squawk alert: this one is read, not glanced at.
    const opts = { tone: "warn" as const, durationMs: 6000 };
    if (started.length > MAX_SEPARATE_TOASTS) {
      // A storm with the common mode left in can set off much of the network
      // in one second; one toast says so rather than a column of them.
      const hosts = started.slice(0, MAX_SEPARATE_TOASTS).map((e) => e.host_node_id).join(", ");
      toast(
        `${started.length} magnetometers started detecting: beside ${hosts} and ${started.length - MAX_SEPARATE_TOASTS} more`,
        opts,
      );
      return;
    }
    for (const event of started) {
      toast(
        `Magnetometer beside ${event.host_node_id}: ${Math.round(event.strength_nt)} nT, UAP ${formatRange(event.range_km)} away`,
        opts,
      );
    }
  }, [network]);
}
