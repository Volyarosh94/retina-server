import { useEffect, useRef } from "react";
import { toast } from "../toast";
import { formatRange } from "./format";
import type { MagNetwork } from "./types";

/**
 * A toast when a magnetometer starts detecting, so a detection is noticed
 * wherever the map is scrolled. Events already open when the page loads are
 * not announced: only ones that begin while you watch.
 */
export function useMagnetometerAlerts(network: MagNetwork | null) {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!network) return;
    const active = network.events.filter((e) => e.active);
    if (seen.current === null) {
      seen.current = new Set(network.events.map((e) => e.event_id));
      return;
    }
    for (const event of active) {
      if (seen.current.has(event.event_id)) continue;
      seen.current.add(event.event_id);
      toast(
        `Magnetometer beside ${event.host_node_id}: ${Math.round(event.strength_nt)} nT, UAP ${formatRange(event.range_km)} away`,
        { tone: "warn" },
      );
    }
  }, [network]);
}
