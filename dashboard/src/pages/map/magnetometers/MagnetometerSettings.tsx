import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { request } from "@retina/shared";
import { API_BASE } from "../constants";
import {
  DEFAULT_PASS,
  flybyCaveat,
  flybyDue,
  flybyErrorText,
  parsePass,
  PASS_FIELDS,
  passProblem,
  passText,
  requestFlyby,
  useFlybyMessage,
  type PassField,
  type PassText,
  type RequestedFlyby,
} from "./flyby";
import {
  COMMON_MODE_MIN_NODES,
  commonModeLeftIn,
  fleetFalseAlarmInterval,
  formatFalseAlarmRate,
  formatPerNodeHour,
  joinReasons,
  modelGaps,
  predictedFalseAlarmsPerHour,
  readingsGap,
  runningModelGaps,
  TOO_FEW_FOR_COMMON_MODE,
} from "./format";
import { useMagnetometers } from "./useMagnetometers";
import type { MagNetwork, MagSettings } from "./types";
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

/** The server's bounds on mag_threshold_sigma (validate_settings). */
const THRESHOLD_MIN = 3;
const THRESHOLD_MAX = 12;

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

/**
 * The Physics tab's Magnetometers section: how many magnetometers, where,
 * how their sensors are set, how the server's detector decides, and a button
 * that flies a UAP past one of them.
 *
 * Its own drafts and its own Apply, beside the page's: these are applied
 * in-process (no fleet restart), and the page's Apply must not carry them. It
 * shows only where the server returns the mag_* keys, which is only where a
 * synthetic fleet runs. The page's drift check counts the section's unapplied
 * edits as its own: `onDirtyChange` says when there are some, and that there
 * are none once the section goes; `onApplied` hands over the reply to the
 * section's Apply, with whether it was edited again meanwhile, so the page
 * settles that write as it settles its own. A new `discard` drops the edits:
 * the settings start afresh from what the simulator runs, and the flyby
 * form, which is not a setting, stays as it was.
 */
export default function MagnetometerSettings({
  config,
  onDirtyChange,
  onApplied,
  discard = 0,
}: {
  config: Record<string, unknown> | null;
  onDirtyChange?: (dirty: boolean) => void;
  onApplied?: (body: unknown, unapplied: boolean) => void;
  discard?: number;
}) {
  const available = Boolean(config && "mag_n_nodes" in config);
  const network = useMagnetometers(available);
  if (!available || !config) return null;
  const placed = network?.nodes.length ?? 0;

  return (
    <div className="ps-scene-section ps-mag-section">
      <div className="ps-scene-title">Magnetometers</div>
      <p className="ps-scene-running">
        {network
          ? `Running: ${placed} magnetometer${placed === 1 ? "" : "s"} · ${network.nodes.filter((n) => n.state === "alarm").length} detecting · ${formatFalseAlarmRate(network.stats)}`
          : "Running: —"}
      </p>
      <SettingsForm key={discard} config={config} network={network} onDirtyChange={onDirtyChange} onApplied={onApplied} />
      <FlybyCard network={network} />
    </div>
  );
}

function SettingsForm({
  config,
  network,
  onDirtyChange,
  onApplied,
}: {
  config: Record<string, unknown>;
  network: MagNetwork | null;
  onDirtyChange?: (dirty: boolean) => void;
  onApplied?: (body: unknown, unapplied: boolean) => void;
}) {
  // The form's values. Seeded from the config, they follow every config the
  // page polls while nothing here is unapplied. After an Apply they stay as
  // sent until the next config arrives, rather than flick back to the values
  // they replaced while it is on its way.
  const [draft, setDraft] = useState<MagSettings>(() => pick(config));
  const [unapplied, setUnapplied] = useState(false);
  const [shown, setShown] = useState(config);
  if (config !== shown) {
    setShown(config);
    if (!unapplied) setDraft(pick(config));
  }
  // Edits are counted: one made while an Apply was on its way never went
  // with it, and leaves the section unapplied when the Apply answers.
  const editCount = useRef(0);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // A section that goes takes its edits with it, and says so: the page stops
  // counting them. An Apply still on its way then answers for nothing left
  // unapplied here.
  const mounted = useRef(true);
  const reportDirty = useRef(onDirtyChange);
  useEffect(() => {
    reportDirty.current = onDirtyChange;
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      reportDirty.current?.(false);
    };
  }, []);

  const edit = (patch: Partial<MagSettings>) => {
    editCount.current += 1;
    setUnapplied(true);
    setDraft((prev) => ({ ...prev, ...patch }));
    onDirtyChange?.(true);
  };

  async function apply() {
    setSaving(true);
    setMessage(null);
    const sentCount = editCount.current;
    const settings = draft;
    const restarted = restarts(pick(config), settings, network);
    try {
      const body = await request(`${API_BASE}/simulation/config`, { method: "PUT", body: JSON.stringify(settings) });
      // Unapplied no more, unless it was edited again while the request was out.
      const editedSince = mounted.current && editCount.current !== sentCount;
      if (!editedSince) setUnapplied(false);
      onApplied?.(body, editedSince);
      setMessage(
        [
          "Applied — the server's detector takes the threshold and the common mode at once, and the simulator the rest at its next poll, within ~5 s.",
          ...restarted,
        ].join(" "),
      );
    } catch (e) {
      setMessage(`Error: ${(e as Error).message}`);
    }
    setSaving(false);
  }

  const placed = network?.nodes.length ?? 0;
  const thresholdPct = ((draft.mag_threshold_sigma - THRESHOLD_MIN) / (THRESHOLD_MAX - THRESHOLD_MIN)) * 100;

  return (
    <>
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
              min={THRESHOLD_MIN}
              max={THRESHOLD_MAX}
              step={0.1}
              value={draft.mag_threshold_sigma}
              onChange={(e) => edit({ mag_threshold_sigma: Number(e.target.value) })}
              className="ps-range"
              aria-label="Detection threshold"
              style={{ "--fill-pct": `${thresholdPct}%` } as CSSProperties}
            />
            <span className="ps-pct-val">{draft.mag_threshold_sigma.toFixed(1)}σ</span>
          </div>
          <p className="ps-type-desc ps-settings-desc">{prediction(draft, network, placed)}</p>
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
        {unapplied && <span className="ps-unapplied-chip">Unapplied changes</span>}
        {message && <span className={`ps-save-msg ${message.startsWith("Error") ? "ps-save-err" : ""}`}>{message}</span>}
      </div>
    </>
  );
}

/**
 * What applying `settings` over `running` sets warming up again, as
 * sentences for the message after it.
 *
 * The simulator places its magnetometers afresh when their switch, their
 * number or their placement changes. Each takes the id of the radar node it
 * sits beside, so one left at its site carries on, and one at a new site
 * starts from nothing: two minutes of readings for its static level, then a
 * minute of residual for its noise, counted at the server's next half-minute.
 * Every magnetometer's noise estimate starts again with a new cycle count,
 * and with the common mode taken out or left in, which only six or more
 * magnetometers do (sim_magnetometer.py). That is judged on the settings, not
 * on what the server subtracts this second: during a warm-up it subtracts no
 * common mode yet, and will once enough have warmed up, whatever is applied.
 */
function restarts(running: MagSettings, settings: MagSettings, network: MagNetwork | null): string[] {
  if (!settings.mag_enabled || settings.mag_n_nodes === 0) return [];
  const placedNow = !running.mag_enabled ? 0 : network ? network.nodes.length : running.mag_n_nodes;
  // The count running, while it is the count being set: the fleet may have
  // fewer sites than asked for.
  const placedAfter = running.mag_enabled && settings.mag_n_nodes === running.mag_n_nodes ? placedNow : settings.mag_n_nodes;
  const notes: string[] = [];
  if (placedNow === 0 || settings.mag_placement !== running.mag_placement || placedAfter > placedNow) {
    notes.push("Magnetometers placed at new sites start from nothing: they read warming up for about three minutes.");
  }
  const subtracts = (s: MagSettings, placed: number) => s.mag_common_mode && placed >= COMMON_MODE_MIN_NODES;
  const before = subtracts(running, placedNow);
  const after = subtracts(settings, placedAfter);
  const causes: string[] = [];
  if (settings.mag_cycle_count !== running.mag_cycle_count) causes.push("a new cycle count");
  if (before !== after) {
    causes.push(
      after
        ? "taking the common mode out"
        : `leaving the common mode in${settings.mag_common_mode ? `, with ${TOO_FEW_FOR_COMMON_MODE},` : ""}`,
    );
  }
  if (placedNow > 0 && causes.length) {
    const said = joinReasons(causes);
    notes.push(
      `${said[0].toUpperCase()}${said.slice(1)} ${causes.length > 1 ? "start" : "starts"} every magnetometer's noise estimate again: they read warming up for up to a minute and a half.`,
    );
  }
  return notes;
}

/**
 * What the threshold being set would cost in false alarms, beside what the
 * network measures. The model was fitted to sensor noise and daily variation
 * with the common mode removed and a reading a second, so where the settings
 * being made, or the network as it runs, fall outside that it says why
 * rather than give a figure that could be thousands of times too low.
 */
function prediction(draft: MagSettings, network: MagNetwork | null, placed: number): string {
  if (!draft.mag_enabled || draft.mag_n_nodes === 0) return "Predicted false alarms: none, with no magnetometers placed.";
  const model = network?.detector?.false_alarm_model;
  if (!network || !model) return "Predicted false alarms: waiting for the detector.";
  // "measuring…" would end the sentence twice.
  const measured =
    network.stats.false_alarms_per_node_hour === null ? "Measured: not yet." : `Measured: ${formatFalseAlarmRate(network.stats)}.`;
  const gaps = [...modelGaps(draft), ...gapsThatStay(network, draft)];
  if (gaps.length === 0 && !model.calibrated && sameModelSettings(draft, network.settings)) {
    gaps.push(...runningModelGaps(network));
  }
  if (gaps.length) {
    return `Predicted: not calibrated with ${joinReasons(gaps)}. The model covers sensor noise and daily variation, with the common mode removed and a reading a second. ${measured}`;
  }
  const predicted = predictedFalseAlarmsPerHour(draft.mag_threshold_sigma, model);
  // The count running, while it is the count being set: the fleet may have
  // fewer sites than asked for.
  const fleet = draft.mag_n_nodes === network.settings.mag_n_nodes && placed > 0 ? placed : draft.mag_n_nodes;
  return `Predicted: ${formatPerNodeHour(predicted)} false alarms per node-hour, ${fleetFalseAlarmInterval(predicted, fleet)}. ${measured}`;
}

/**
 * Why the network as it runs stays outside the model whatever these settings
 * say: the spacing of its readings, a warm-up still under way, or fewer than
 * six reporting while the count being set is the count running.
 */
function gapsThatStay(network: MagNetwork, draft: MagSettings): string[] {
  const gaps: string[] = [];
  if (draft.mag_common_mode && draft.mag_n_nodes >= COMMON_MODE_MIN_NODES) {
    const leftIn = commonModeLeftIn(network);
    if (leftIn === "warming") gaps.push("the magnetometers still warming up");
    else if (leftIn === "too-few" && draft.mag_n_nodes === network.settings.mag_n_nodes) {
      gaps.push(`${TOO_FEW_FOR_COMMON_MODE} reporting`);
    }
  }
  const readings = readingsGap(network);
  if (readings) gaps.push(readings);
  return gaps;
}

function sameModelSettings(a: MagSettings, b: MagSettings): boolean {
  return a.mag_storm === b.mag_storm && a.mag_common_mode === b.mag_common_mode && a.mag_n_nodes === b.mag_n_nodes;
}

/**
 * Fly a UAP past one magnetometer, or one the simulator picks. The form holds
 * the server's bounds (PASS_FIELDS), so a pass it would refuse is never sent,
 * and sends one request at a time. A flyby is a command, not a setting: the
 * server leaves the config's stamp alone for it, so the page's drift check
 * has nothing to hear of it.
 */
function FlybyCard({ network }: { network: MagNetwork | null }) {
  const [target, setTarget] = useState<{ id: string; host: string } | null>(null);
  const [pass, setPass] = useState<PassText>(() => passText(DEFAULT_PASS));
  const [flying, setFlying] = useState(false);
  const inFlight = useRef(false);
  // The last flyby asked for, said as it stands: on its way, passed, then gone.
  const [requested, setRequested] = useState<RequestedFlyby | null>(null);
  const [error, setError] = useState<string | null>(null);
  const message = useFlybyMessage(requested);

  const nodes = network?.nodes ?? [];
  // A magnetometer taken away since it was chosen leaves the choice to the
  // simulator, and the form says so, rather than naming a site the pass will
  // not go to: what the select shows is what is sent.
  const chosen = target ? (nodes.find((n) => n.node_id === target.id) ?? null) : null;
  const valid = PASS_FIELDS.every((f) => passProblem(f, pass[f.key]) === null);
  const caveat =
    target && network && !chosen
      ? `The magnetometer beside ${target.host} is no longer placed: the simulator will pick one.`
      : chosen
        ? flybyCaveat(chosen.state)
        : null;

  async function flyUap() {
    if (inFlight.current) return;
    inFlight.current = true;
    setFlying(true);
    setError(null);
    try {
      const planned = parsePass(pass);
      const { seq } = await requestFlyby(chosen?.node_id ?? null, planned);
      setRequested({ seq, host: chosen ? chosen.host_node_id : null, dueMs: flybyDue(Date.now(), planned.lead_s), onMap: false });
    } catch (e) {
      setError(`Error: ${flybyErrorText((e as Error).message)}`);
    } finally {
      inFlight.current = false;
      setFlying(false);
    }
  }

  return (
    <div className="card ps-settings-card ps-flyby-card">
      <div className="ps-settings-label">
        Fly a UAP past a magnetometer
        <span className="ps-settings-sublabel"> (a 1e9 A·m² dipole on a straight, level track; the radar nodes see it too)</span>
      </div>
      <div className="ps-flyby-grid">
        <label>
          Magnetometer
          <select
            className="ps-select"
            value={chosen ? chosen.node_id : ""}
            onChange={(e) => {
              const node = nodes.find((n) => n.node_id === e.target.value);
              setTarget(node ? { id: node.node_id, host: node.host_node_id } : null);
            }}
          >
            <option value="">Any</option>
            {nodes.map((n) => (
              <option key={n.node_id} value={n.node_id}>
                beside {n.host_node_id}
                {n.state === "warming_up" ? " (warming up)" : n.state === "stale" ? " (no data)" : ""}
              </option>
            ))}
          </select>
        </label>
        {PASS_FIELDS.map((field) => (
          <NumberField
            key={field.key}
            field={field}
            text={pass[field.key]}
            onChange={(text) => setPass((prev) => ({ ...prev, [field.key]: text }))}
          />
        ))}
      </div>
      {caveat && <p className="ps-type-desc ps-settings-desc ps-flyby-caveat">{caveat}</p>}
      <div className="ps-actions">
        <button className="btn btn-secondary" onClick={flyUap} disabled={!network || nodes.length === 0 || !valid || flying}>
          {flying ? "Requesting…" : "Fly a UAP past it"}
        </button>
        {error ? (
          <span className="ps-save-msg ps-save-err">{error}</span>
        ) : (
          message && <span className="ps-save-msg">{message}</span>
        )}
      </div>
      <p className="ps-type-desc ps-settings-desc">
        At 15 nT of sensor noise a magnetometer finds a pass like this out to about 1.5 km (further if it is slow);
        the design note has the measured detection probabilities.
      </p>
    </div>
  );
}

/**
 * One of the pass's numbers. It holds what was typed, so a field being
 * retyped can be empty rather than snapping to 0, and says what it must hold
 * while it does not: beside the field rather than in its label, so the
 * field's name stays its name.
 */
function NumberField({ field, text, onChange }: { field: PassField; text: string; onChange: (text: string) => void }) {
  const problemId = useId();
  const problem = passProblem(field, text);
  return (
    <div className="ps-flyby-field">
      <label>
        {field.label}
        <input
          type="number"
          className="ps-number"
          value={text}
          min={field.min}
          max={field.max}
          step={field.step}
          aria-invalid={problem !== null}
          aria-describedby={problem ? problemId : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
      {problem && (
        <span id={problemId} className="ps-field-error">
          {problem}
        </span>
      )}
    </div>
  );
}
