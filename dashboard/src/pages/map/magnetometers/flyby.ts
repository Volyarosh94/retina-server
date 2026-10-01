import { request } from "@retina/shared";
import { API_BASE } from "../constants";
import type { MagState } from "./types";

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

export interface PassField {
  key: keyof FlybyPass;
  label: string;
  min: number;
  max: number;
  step: number;
}

/**
 * The pass's fields as the Physics tab's form shows them, each with the
 * bounds validate_flyby holds it to (its _FLYBY_RANGES), so a pass the server
 * would refuse is caught before it is sent.
 */
export const PASS_FIELDS: PassField[] = [
  { key: "closest_approach_m", label: "Closest approach (m)", min: 0, max: 20_000, step: 50 },
  { key: "altitude_m", label: "Altitude (m)", min: 50, max: 15_000, step: 50 },
  { key: "speed_mps", label: "Speed (m/s)", min: 5, max: 1_000, step: 5 },
  { key: "lead_s", label: "In (s)", min: 10, max: 600, step: 5 },
];

/** The form's text for each field. Text, not numbers: a field being retyped may be empty. */
export type PassText = Record<keyof FlybyPass, string>;

export function passText(pass: FlybyPass): PassText {
  return {
    closest_approach_m: String(pass.closest_approach_m),
    altitude_m: String(pass.altitude_m),
    speed_mps: String(pass.speed_mps),
    lead_s: String(pass.lead_s),
  };
}

/**
 * What is wrong with a field's text, in the form's words, or null if nothing.
 * The bounds are written as the server writes them in a refusal ("5–1000"),
 * so the two messages never disagree.
 */
export function passProblem(field: PassField, text: string): string | null {
  const range = `${field.min}–${field.max}`;
  const value = text.trim() === "" ? Number.NaN : Number(text);
  if (!Number.isFinite(value)) return `Enter a number, ${range}`;
  if (value < field.min || value > field.max) return `Must be ${range}`;
  return null;
}

/** The pass a valid form holds. */
export function parsePass(text: PassText): FlybyPass {
  return {
    closest_approach_m: Number(text.closest_approach_m),
    altitude_m: Number(text.altitude_m),
    speed_mps: Number(text.speed_mps),
    lead_s: Number(text.lead_s),
  };
}

/**
 * Why a pass past a magnetometer in this state may go unseen, or null if it
 * would be seen. A warning rather than a refusal, on the map and the Physics
 * page alike: a pass timed for after a warm-up is seen, and the server cannot
 * say when the warm-up will end.
 */
export function flybyCaveat(state: MagState): string | null {
  if (state === "warming_up") return "It is still warming up: a pass that arrives before it can score goes unseen.";
  if (state === "stale") return "It has stopped reporting: a pass goes unseen until its readings resume.";
  return null;
}

const LABELS: Record<string, string> = {
  ...Object.fromEntries(PASS_FIELDS.map((f) => [f.key, f.label])),
  node_id: "Magnetometer",
};

/**
 * A refusal from the server in the form's words: validate_flyby names the
 * API's keys ("lead_s must be 10–600"), which the form shows as labels.
 */
export function flybyErrorText(message: string): string {
  return message.replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (key) => LABELS[key] ?? key);
}

/**
 * Ask the fleet to fly a UAP past a magnetometer, or past one it picks when
 * `nodeId` is empty. Returns the request's sequence number. A flyby is a
 * command, not a setting: the server leaves the config's stamp alone for it,
 * so there is no stamp to hand anyone.
 */
export async function requestFlyby(nodeId: string | null, pass: FlybyPass): Promise<{ seq: number | null }> {
  const body = await request(`${API_BASE}/sim/magnetometers/flyby`, {
    method: "POST",
    body: JSON.stringify({ ...pass, node_id: nodeId || undefined }),
  });
  return { seq: typeof body?.flyby?.seq === "number" ? body.flyby.seq : null };
}
