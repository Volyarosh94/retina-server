import { useEffect, useRef, useState, type CSSProperties } from "react";
import { request } from "@retina/shared";
import { API_BASE } from "../constants";
import { DEFAULT_PASS, FLEET_POLL_S, requestFlyby, type FlybyPass } from "./flyby";
import {
  fleetFalseAlarmInterval,
  formatFalseAlarmRate,
  predictedFalseAlarmsPerHour,
} from "./format";
import { useMagnetometers } from "./useMagnetometers";
import type { MagSettings } from "./types";
import "./magnetometers.css";

const KEYS: (keyof MagSettings)[] = [
  "mag_enabled",
  "mag_n_nodes",
  "mag_placement",
  "mag_cycle_count",
  "mag_storm",
  "mag_threshold_sigma",
  "mag_common_mode",
];

/** The server's bound on mag_n_nodes (validate_settings). */
const MAX_NODES = 60;

const CYCLE_COUNTS: [number, string][] = [
  [50, "50 cycles — 30 nT noise"],
  [100, "100 cycles — 20 nT noise"],
  [200, "200 cycles — 15 nT noise (datasheet default)"],
  [400, "400 cycles — ~11 nT noise"],
  [800, "800 cycles — ~8.4 nT noise"],
];

const PLACEMENTS: [MagSettings["mag_placement"], string][] = [
  ["spread", "Spread across the fleet"],
  ["core", "Clustered at the fleet's core"],
  ["random", "Random sites (seeded)"],
];

function pick(config: Record<string, unknown>): MagSettings {
  return Object.fromEntries(KEYS.map((k) => [k, config[k]])) as unknown as MagSettings;
}

interface Flyby extends FlybyPass {
  node_id: string;
}

/**
 * The Physics tab's Magnetometers section: how many magnetometers, where,
 * how their sensors are set, how the server's detector decides, and a button
 * that flies a UAP past one of them.
 *
 * Its own drafts and its own Apply, beside the page's: these are applied
 * in-process (no fleet restart), and the page's Apply must not carry them. It
 * shows only where the server returns the mag_* keys, which is only where a
 * synthetic fleet runs. Every write hands its new config stamp back through
 * `onApplied`, so the page's drift check does not mistake it for a restart.
 */
export default function MagnetometerSettings({
  config,
  onApplied,
}: {
  config: Record<string, unknown> | null;
  onApplied: (stamp: number | null) => void;
}) {
  const available = Boolean(config && "mag_n_nodes" in config);
  const network = useMagnetometers(available);
  const [draft, setDraft] = useState<MagSettings | null>(null);
  const dirty = useRef(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [flyby, setFlyby] = useState<Flyby>({ node_id: "", ...DEFAULT_PASS });
  const [flybyMessage, setFlybyMessage] = useState<string | null>(null);

  // Seed from the server, and follow it while nothing here is unapplied.
  useEffect(() => {
    if (available && config && !dirty.current) setDraft(pick(config));
  }, [available, config]);

  if (!available || !draft) return null;

  const edit = (patch: Partial<MagSettings>) => {
    dirty.current = true;
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  async function apply() {
    setSaving(true);
    setMessage(null);
    try {
      const body = await request(`${API_BASE}/simulation/config`, { method: "PUT", body: JSON.stringify(draft) });
      const stamp = body?.config?._updated_at;
      onApplied(typeof stamp === "number" ? stamp : null);
      dirty.current = false;
      setMessage("Applied — the simulator re-places its magnetometers within ~5 s; the detector uses the new threshold at once.");
    } catch (e) {
      setMessage(`Error: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  async function flyUap() {
    setFlybyMessage(null);
    try {
      const { node_id, ...pass } = flyby;
      const { seq, updatedAt } = await requestFlyby(node_id, pass);
      onApplied(updatedAt);
      const target = node_id ? node_id.replace(/^mag-/, "") : "a magnetometer the simulator picks";
      setFlybyMessage(
        `UAP flyby #${seq ?? "?"} requested: it passes ${target} about ${pass.lead_s + FLEET_POLL_S} s from now. Watch it on the /sim map.`,
      );
    } catch (e) {
      setFlybyMessage(`Error: ${(e as Error).message}`);
    }
  }

  const model = network?.detector?.false_alarm_model;
  const predicted = model ? predictedFalseAlarmsPerHour(draft.mag_threshold_sigma, model) : null;
  const placed = network?.nodes.length ?? 0;
  const thresholdPct = ((draft.mag_threshold_sigma - 3) / 5) * 100;

  return (
    <div className="ps-scene-section ps-mag-section">
      <div className="ps-scene-title">Magnetometers</div>
      <p className="ps-scene-running">
        {network
          ? `Running: ${placed} magnetometer${placed === 1 ? "" : "s"} · ${network.nodes.filter((n) => n.state === "alarm").length} detecting · ${formatFalseAlarmRate(network.stats)}`
          : "Running: —"}
      </p>

      <div className="ps-settings-grid">
        <div className="card ps-settings-card">
          <div className="ps-settings-label">Placement</div>
          <label className="ps-toggle-row">
            <input type="checkbox" checked={draft.mag_enabled} onChange={(e) => edit({ mag_enabled: e.target.checked })} />
            <span className="ps-toggle-text">Put an RM3100 beside some of the radar sites</span>
          </label>
          <div className="ps-slider-row">
            <input
              type="range"
              min={0}
              max={MAX_NODES}
              step={1}
              value={draft.mag_n_nodes}
              disabled={!draft.mag_enabled}
              onChange={(e) => edit({ mag_n_nodes: Number(e.target.value) })}
              className="ps-range"
              aria-label="Number of magnetometers"
              style={{ "--fill-pct": `${(draft.mag_n_nodes / MAX_NODES) * 100}%` } as CSSProperties}
            />
            <span className="ps-pct-val">{draft.mag_n_nodes}</span>
          </div>
          <select
            className="ps-select"
            aria-label="Placement"
            value={draft.mag_placement}
            disabled={!draft.mag_enabled}
            onChange={(e) => edit({ mag_placement: e.target.value as MagSettings["mag_placement"] })}
          >
            {PLACEMENTS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <p className="ps-type-desc ps-settings-desc">
            One per roof, never more than the fleet has sites. Changes apply without restarting the fleet: the
            magnetometers hold no connection of their own.
          </p>
        </div>

        <div className="card ps-settings-card">
          <div className="ps-settings-label">Sensor</div>
          <select
            className="ps-select"
            aria-label="Cycle count"
            value={draft.mag_cycle_count}
            onChange={(e) => edit({ mag_cycle_count: Number(e.target.value) })}
          >
            {CYCLE_COUNTS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <label className="ps-toggle-row">
            <input type="checkbox" checked={draft.mag_storm} onChange={(e) => edit({ mag_storm: e.target.checked })} />
            <span className="ps-toggle-text">Geomagnetic storm (Dst −150 nT, with pulsations)</span>
          </label>
          <p className="ps-type-desc ps-settings-desc">
            The storm is the same at every site. Turn it on with the common mode off below to see why the
            detector subtracts it.
          </p>
        </div>

        <div className="card ps-settings-card">
          <div className="ps-settings-label">
            Detection threshold
            <span className="ps-settings-sublabel">{" (the server's detector, applied at once)"}</span>
          </div>
          <div className="ps-slider-row">
            <input
              type="range"
              min={3}
              max={8}
              step={0.1}
              value={draft.mag_threshold_sigma}
              onChange={(e) => edit({ mag_threshold_sigma: Number(e.target.value) })}
              className="ps-range"
              aria-label="Detection threshold"
              style={{ "--fill-pct": `${thresholdPct}%` } as CSSProperties}
            />
            <span className="ps-pct-val">{draft.mag_threshold_sigma.toFixed(1)}σ</span>
          </div>
          <p className="ps-type-desc ps-settings-desc">
            {predicted === null
              ? "Predicted false alarms: waiting for the detector."
              : `Predicted: ${predicted.toPrecision(2)} false alarms per node-hour, ${fleetFalseAlarmInterval(predicted, Math.max(placed, 1))}. Measured: ${formatFalseAlarmRate(network?.stats)}.`}
          </p>
          <label className="ps-toggle-row">
            <input
              type="checkbox"
              checked={draft.mag_common_mode}
              onChange={(e) => edit({ mag_common_mode: e.target.checked })}
            />
            <span className="ps-toggle-text">{"Remove the network's common mode (daily variation, storms)"}</span>
          </label>
        </div>
      </div>

      <div className="ps-actions">
        <button className="btn btn-primary" onClick={apply} disabled={saving}>
          {saving ? "Applying…" : "Apply magnetometer settings"}
        </button>
        {message && <span className={`ps-save-msg ${message.startsWith("Error") ? "ps-save-err" : ""}`}>{message}</span>}
      </div>

      <div className="card ps-settings-card ps-flyby-card">
        <div className="ps-settings-label">
          Fly a UAP past a magnetometer
          <span className="ps-settings-sublabel"> (a 1e9 A·m² dipole on a straight, level track; the radar nodes see it too)</span>
        </div>
        <div className="ps-flyby-grid">
          <label>
            Magnetometer
            <select className="ps-select" value={flyby.node_id} onChange={(e) => setFlyby({ ...flyby, node_id: e.target.value })}>
              <option value="">Any</option>
              {(network?.nodes ?? []).map((n) => (
                <option key={n.node_id} value={n.node_id}>
                  beside {n.host_node_id}
                </option>
              ))}
            </select>
          </label>
          <NumberField label="Closest approach (m)" value={flyby.closest_approach_m} min={0} max={20000} step={50} onChange={(v) => setFlyby({ ...flyby, closest_approach_m: v })} />
          <NumberField label="Altitude (m)" value={flyby.altitude_m} min={50} max={15000} step={50} onChange={(v) => setFlyby({ ...flyby, altitude_m: v })} />
          <NumberField label="Speed (m/s)" value={flyby.speed_mps} min={5} max={1000} step={5} onChange={(v) => setFlyby({ ...flyby, speed_mps: v })} />
          <NumberField label="In (s)" value={flyby.lead_s} min={10} max={600} step={5} onChange={(v) => setFlyby({ ...flyby, lead_s: v })} />
        </div>
        <div className="ps-actions">
          <button className="btn btn-secondary" onClick={flyUap} disabled={!network || placed === 0}>
            Fly a UAP past it
          </button>
          {flybyMessage && (
            <span className={`ps-save-msg ${flybyMessage.startsWith("Error") ? "ps-save-err" : ""}`}>{flybyMessage}</span>
          )}
        </div>
        <p className="ps-type-desc ps-settings-desc">
          At 15 nT of sensor noise a magnetometer finds a pass like this out to about 1.5 km (further if it is slow);
          the design note has the measured detection probabilities.
        </p>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        className="ps-number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
