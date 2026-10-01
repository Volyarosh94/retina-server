import { request } from "@retina/shared";
import { usePolling } from "../../../hooks/usePolling";
import { API_BASE } from "../constants";
import type { MagDetail, MagNetwork } from "./types";

/**
 * The simulated magnetometer network, polled every 2 s while `enabled`.
 *
 * Its own admin endpoint rather than a field on the aircraft websocket: the
 * socket is unauthenticated and broadcast only when the aircraft change, and
 * magnetometer data is simulation-only. Disabled (null, and no requests) on
 * every page but /sim with the fleet running.
 */
export function useMagnetometers(enabled: boolean): MagNetwork | null {
  const { data } = usePolling<MagNetwork | null>(
    () => (enabled ? request(`${API_BASE}/sim/magnetometers`).then(asNetwork) : Promise.resolve(null)),
    enabled ? 2_000 : 0,
    enabled ? "on" : "off",
  );
  return enabled ? data : null;
}

/**
 * The response if it has the shape the layer draws, otherwise null. A server
 * without the route, or a proxy's error page, must leave the map exactly as it
 * is rather than take it down.
 */
export function asNetwork(body: unknown): MagNetwork | null {
  const b = body as MagNetwork | null;
  if (!b || !Array.isArray(b.nodes) || !Array.isArray(b.events) || !b.stats || !b.settings) return null;
  return b;
}

/**
 * The detail if it has what the panel charts: a series with its times and
 * the residual and score beside them. A server from before the measured
 * field (bx, by, bz, b) is still charted, without that field: the panel
 * shows the gap rather than the map going down with it.
 */
export function asDetail(body: unknown): MagDetail | null {
  const b = body as MagDetail | null;
  const series = b?.series;
  if (!b || typeof b.node_id !== "string" || !series || !Array.isArray(series.t)) return null;
  for (const key of ["x", "y", "z", "residual", "score"] as const) if (!Array.isArray(series[key])) return null;
  return Array.isArray(b.events) ? b : { ...b, events: [] };
}

/**
 * One magnetometer's last ten minutes, while its panel is open.
 *
 * usePolling keeps its last answer across a change of key until the next
 * lands, and for good if that fails, so an answer counts only while it is
 * the asked-for magnetometer's: otherwise the panel would chart one
 * magnetometer under another's name. `failed` is true when the request for
 * this one has failed and nothing of it is in hand.
 */
export function useMagnetometerDetail(nodeId: string | null): { detail: MagDetail | null; failed: boolean } {
  const { data, pending, error } = usePolling<MagDetail | null>(
    () =>
      nodeId
        ? request(`${API_BASE}/sim/magnetometers/${encodeURIComponent(nodeId)}?window=600`).then((body) => {
            const detail = asDetail(body);
            // Charted as a failed answer, rather than read past its end.
            if (!detail) throw new Error("The magnetometer's detail came back in a shape the panel cannot chart");
            return detail;
          })
        : Promise.resolve(null),
    nodeId ? 2_000 : 0,
    nodeId ?? "",
  );
  const detail = nodeId !== null && data?.node_id === nodeId ? data : null;
  return { detail, failed: nodeId !== null && detail === null && !pending && error !== null };
}
