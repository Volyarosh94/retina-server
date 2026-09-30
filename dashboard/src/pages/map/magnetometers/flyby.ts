import { request } from "@retina/shared";
import { API_BASE } from "../constants";

/**
 * A UAP pass as POST /api/sim/magnetometers/flyby takes it
 * (backend/services/sim_magnetometer.py, validate_flyby): a 1e9 A·m² dipole
 * on a straight, level track past one magnetometer.
 */
export interface FlybyPass {
  closest_approach_m: number;
  altitude_m: number;
  speed_mps: number;
  lead_s: number;
}

/** The server's defaults: a pass the default sensor is sure to catch. */
export const DEFAULT_PASS: FlybyPass = { closest_approach_m: 600, altitude_m: 300, speed_mps: 120, lead_s: 60 };

/** The fleet reads its config every 5 s, and times the pass from then. */
export const FLEET_POLL_S = 5;

/**
 * Ask the fleet to fly a UAP past a magnetometer, or past one it picks when
 * `nodeId` is empty. Returns the request's sequence number and the config
 * stamp the write produced.
 */
export async function requestFlyby(
  nodeId: string | null,
  pass: FlybyPass,
): Promise<{ seq: number | null; updatedAt: number | null }> {
  const body = await request(`${API_BASE}/sim/magnetometers/flyby`, {
    method: "POST",
    body: JSON.stringify({ ...pass, node_id: nodeId || undefined }),
  });
  return {
    seq: typeof body?.flyby?.seq === "number" ? body.flyby.seq : null,
    updatedAt: typeof body?.updated_at === "number" ? body.updated_at : null,
  };
}
