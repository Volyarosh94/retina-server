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

/** One magnetometer's last ten minutes, while its panel is open. */
export function useMagnetometerDetail(nodeId: string | null): MagDetail | null {
  const { data } = usePolling<MagDetail | null>(
    () => (nodeId ? request(`${API_BASE}/sim/magnetometers/${encodeURIComponent(nodeId)}?window=600`) : Promise.resolve(null)),
    nodeId ? 2_000 : 0,
    nodeId ?? "",
  );
  return nodeId ? data : null;
}
