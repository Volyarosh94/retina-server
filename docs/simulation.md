# Simulation Layer

The fleet simulator (`libs/retina-simulation`) runs synthetic radar nodes and
injects real or simulated aircraft traffic to exercise the full server
pipeline. It powers the `/sim` map on the test droplet's admin console, local
development and CI; production and staging run no fleet.

---

## Architecture

```
FleetOrchestrator (retina_simulation/orchestrator.py)
    │
    ├─ SimulationWorld          (shared physics state, world.py)
    │       ├─ SimulatedAircraft × N
    │       └─ node views              (per-node observation geometry)
    │
    ├─ MagnetometerArray        (RM3100s beside some receivers, magnetometer.py)
    │       └─ POST /api/sim/magnetometer/push every 1 s
    │
    ├─ AdsbLolClient            (optional real ADS-B feed)
    │
    ├─ config poller            (GET /api/simulation/config every 5 s)
    │
    └─ NodeConnection × M       (async TCP, one per node)
            │
            └─ HELLO → CONFIG → DETECTION / HEARTBEAT
```

All nodes share a single `SimulationWorld`. Each node observes the world
through its own geometry: position, beam azimuth, a **fixed 42° Yagi
half-power beamwidth** (the whole fleet is the same antenna — width jitter was
removed deliberately), and range. The detection cone honours
`max_bistatic_range_km` — the *differential-range* limit — matching the rule
the server's association and arc layers gate on; the monostatic RX-radius rule
is only a fallback for nodes that declare no bistatic limit.

---

## Scene generation (`generator.py`)

The generator places nodes and picks illuminators for a metro scene:

- **`--metro gvl`** scopes the scene to one metro (Greenville, SC is the
  deployed default): sites inside the metro radius, aircraft on the metro's
  regional waypoint net, real ADS-B polling confined to its bounding box.
- **`--layout ring | dual | scatter`** — ring places nodes around the core;
  dual gives each site two illuminators; scatter (the staging default)
  distributes sites with per-site reach drawn from a distribution
  (60 km differential is what a *good* setup achieves, not an average one).
- **Illuminators are real FCC sites** — the GVL table carries the actual
  broadcast towers (WYFF Caesars Head etc.); base-metro nodes draw from the
  cached `metro_tower_cache.json` FCC lookups. Receiver sites are synthetic,
  land-checked (Natural Earth coastline/lake polygons) positions.

Detections carry bistatic delay and Doppler computed from full 3D ENU
geometry (altitude included — which is why the server's arc builder solves a
3D locus), plus SNR. **Known simplification:** SNR falls off at a one-way
10 dB/decade rather than the bistatic ~40 dB/decade, so synthetic SNR is
optimistic at range; SNR-derived gates need re-tuning on real captures.
Clutter/false alarms are injected with small-differential bias (they cluster
near the TX–RX baseline, which is why the server floors tiny differentials
before drawing arcs).

---

## Runtime simulation config

The orchestrator polls `GET /api/simulation/config` every 5 s. The Physics
tab (or `PUT /api/simulation/config`, admin-authed) can change at runtime:

| Key | Default | Meaning |
|-----|---------|---------|
| `frac_anomalous` | 0.0 | Fraction of spawns with anomalous behaviour |
| `frac_drone` | 0.0 | Drone fraction (off by default; enable for drone scenarios) |
| `frac_dark` | 0.15 | Non-ADS-B ("dark") fraction of the synthetic spawns |
| `frac_adsb_outage` | 0.0 | Fraction of ADS-B aircraft that go transponder-silent mid-flight (outside the sum above) |
| `frac_live_dark` | 0.15 | Share of the **live-feed** aircraft cast as dark (outside the sum above) — see below |
| `live_adsb_enabled` | true | Pull live aircraft from the feed into the world (off removes them) |
| `min_aircraft` / `max_aircraft` | *(unset)* | Steady-state bounds for the **synthetic** aircraft |
| `n_nodes` / `dual_fraction` / `max_range_km` | *(unset)* | Fleet-scene keys — applying one **restarts the fleet** for regeneration |

Where the server runs a synthetic fleet, the same config carries the
magnetometers' `mag_*` keys too; they are listed under
[Magnetometers](#magnetometers), below.

The fractions and aircraft counts apply in-process to *new spawns*. The scene
keys are different: node count, dual-illuminator fraction and a uniform range
override (`max_range_km`, `0` = per-node generated ranges) shape the node
configs themselves, so the orchestrator compares the polled value against its
running scene and shuts down for regeneration on drift;
`deploy/fleet-entrypoint.sh` fetches the overrides on reboot. The Physics
tab keeps these under the Fleet Scene section with its restart warning.

The unset keys are **deliberately absent from the defaults**: the fleet
applies them only when explicitly set, otherwise its deployment env
(`FLEET_MIN_AIRCRAFT` etc.) wins. Defaults here once carried a stale fleet
scale that silently overrode the deployment the first time anyone touched an
unrelated knob. The world's own constructor defaults are kept matched to this
table (drones once defaulted to 0.10 in the world, spawning a few boot-window
drones on every fleet restart even with the slider at 0). The runtime config
is in-memory only — a backend restart returns it to these defaults.

---

## Aircraft lifecycle

Spawns roll a target class from the fractions, get a route (85% metro-cell
traffic on the regional waypoint net under `--metro`) and a lifetime of
180–900 s (drones 60–300 s). Expiry never removes an aircraft mid-view: an
expired non-drone is rerouted to a waypoint past `retire_edge_km` (70 km) on
the bearing away from the world center and retires only once beyond that
edge — the viewer watches it leave. A 900 s exit grace backstops genuinely
stuck aircraft; drones keep the old 2×-lifetime churn (an amber X-frame
vanishing reads as turnover, not a tracking bug). On the map, ADS-B truth
dots take the neutral extreme of whichever theme is active — near-black on
light, near-white on dark — and dark aircraft grey: truth is the reference the solved
lanes are measured against, so it is deliberately the one thing out there
wearing no lane colour.

---

## Deployed fleet (the test droplet)

Only the test droplet runs a fleet; production and staging keep theirs behind
an unenabled `sim` compose profile. The fleet container regenerates
`fleet_config.json` from `FLEET_*` env on every boot
(`deploy/fleet-entrypoint.sh`); scale changes are compose-file changes, not
code changes. The scale below is illustrative — `docker-compose.test.yml` is
the source of truth for what the test droplet currently runs:

| Env | Value | Meaning |
|-----|-------|---------|
| `FLEET_METRO` | `gvl` | Greenville, SC scene |
| `FLEET_LAYOUT` | `scatter` | Scatter site layout |
| `FLEET_NODES` | 30 | Total synthetic nodes |
| `FLEET_N_CLUSTER` | 20 | Scatter-cluster size |
| `FLEET_MIN_AIRCRAFT` / `FLEET_MAX_AIRCRAFT` | 20 / 40 | Steady-state traffic |
| `FLEET_MODE` | `adsb` | Merge the real ADS-B feed |
| `FLEET_INTERVAL` | 0.5 s | Frame interval per node |

Real hardware nodes connect alongside the synthetic fleet through the v1 node
API under their own registered ids, with their geometry in the node registry.
(The old per-node blah2 bridge and its `blah2_nodes.json` geometry list were
removed; a leftover copy under `backend/data/runtime/` is no longer read.)

---

## Live ADS-B seeding (`LiveAdsbClient`)

With `--live-adsb-url` (the fleet entrypoint defaults it to
`https://adsb.retina.fm`; `FLEET_LIVE_ADSB_URL=` turns it off), the
orchestrator polls the feed's `/v2/point/{lat}/{lon}/{radius_nm}` for the
`--metro` area every 5 s and merges the result into the world
(`SimulationWorld.ingest_live_aircraft`). Each real aircraft becomes a
`live-<hex>` world aircraft flying its reported position, altitude, ground
speed, track and vertical rate — extrapolated from the fix's capture time,
dead-reckoned between polls, dropped 60 s after its last fix (not after the
feed last echoed a stale row for it), and retired on the spot when the feed
reports it on the ground. The feed is not trusted blindly: a row whose fix is
already older than that window is ignored, and an altitude that jumps more
than 1 km from the coasted one is held off unless it persists, self-consistently,
for a minute (adsb.retina.fm has been seen serving another aircraft's cruise
altitude in a low GA row). The synthetic nodes echo it like any other aircraft
(delay/Doppler from its real kinematics), so the fleet flies real traffic.

The feed owns these aircraft: no waypoints, no separation slowing, no
lifetime, and they never count toward `min_aircraft` / `max_aircraft` —
those, with `frac_dark`, keep governing the synthetic aircraft the world
spawns on top, so the two populations are adjusted independently.

`frac_live_dark` casts a share of the live aircraft as **dark**: the world
mirrors them without their transponder (`has_adsb` off, `adsb_hex` None), so
the node frames carry no tag for them, the 1 Hz ADS-B push omits them and the
ground truth keys them by object id — a synthetic dark spawn's shape with a
real trajectory underneath. The rest keep their real hex and callsign and are
pushed as simulated-world ADS-B. The cast is a stable per-hex hash, so
moving the knob re-partitions the aircraft already in the air (raising it
only ever adds dark aircraft) at the next config poll, not the next fleet
turnover. The Physics tab's "Live ADS-B traffic" card holds the toggle and
the slider; `GET /api/simulation/config` reports `live` / `live_adsb` /
`live_dark` counts.

Production sets `FLEET_LIVE_ADSB_URL=` (off): its real hardware nodes claim
the same real hexes in the "real" world, and a simulated fleet mirroring
those aircraft would push the same keys into the server's one ADS-B cache
as simulated-world traffic.

The older opt-in `--real-adsb` relay (adsb.lol → `POST /api/sim/adsb/push`
tagged `source=real`, display-only for claiming) still exists but is
ignored while seeding runs, for the same one-cache reason.

---

## Magnetometers

The fleet can put a PNI RM3100 magnetometer at some of its receive sites, one
per roof, named for the radar node beside it (`mag-<node id>`). They show what
magnetometers beside the radars would see of a UAP modelled as a 1e9 A·m²
magnetic dipole, and how often they would be fooled. Every magnetometer route exists only
under `SYNTHETIC_FLEET_ENABLED`, and none of their data reaches the radar
pipeline or `/v1/nodes`. The design note
[2026-09-30-simulated-magnetometers.md](design-notes/2026-09-30-simulated-magnetometers.md)
has the reasoning and the measurements, and the library's README
(`libs/retina-simulation/README.md`) has the field model and the payload.

Once per world step (a second) each magnetometer reads WMM2025 at its site, a
crustal offset, the solar-quiet daily variation, an optional network-wide
storm and every anomalous object as a dipole, with the RM3100's noise
quantised to its counts. Aircraft and drones contribute nothing, and with
`frac_anomalous` at its default of 0 the magnetometers see only the flybys
asked for. The orchestrator posts the readings once a second, holding up to
ten seconds of them while posts fail. The truth behind each reading rides
beside it, for scoring only.

The detector (`backend/services/sim_magnetometer.py`) subtracts each
magnetometer's static level and the median of the others' deviations (the
common mode, applied while six or more report), matches the residual against
a passing dipole at six time scales from 2 to 64 s, and scores it in σ
against the magnetometer's own noise. An event carries the time of closest
approach, strength, score, time scale, a confidence, a range band and
`calibrated`, and is scored against the truth for a live false-alarm rate
per node-hour searched.

**Settings.** These keys of the runtime config are present only under
`SYNTHETIC_FLEET_ENABLED`; without it, a PUT carrying one is refused (400):

| Key | Default | Meaning |
|-----|---------|---------|
| `mag_enabled` | true | Place magnetometers at all |
| `mag_n_nodes` | 8 | How many (0–60), never more than the fleet has sites |
| `mag_placement` | `spread` | `spread` across the fleet, `core` the sites nearest its centre, or `random` (seeded) |
| `mag_cycle_count` | 200 | The sensor's cycle count: 50, 100, 200, 400 or 800 (30, 20, 15, ~11.3, ~8.4 nT noise) |
| `mag_storm` | false | Run a storm (Dst −150 nT, pulsations), from the moment it is switched on |
| `mag_threshold_sigma` | 5.5 | Detection threshold in σ (3–12). Server-side, applied at once |
| `mag_common_mode` | true | Subtract the network's common mode (with six or more magnetometers reporting). Server-side, applied at once |

The fleet applies its keys in-process at its next poll, without a restart,
and ignores the two server-side ones. A magnetometer at a new site reads
warming up for about three minutes. The scorecard starts again when the
threshold, the common mode, the sensor setting or the storm changes. The
snapshot restores the keys.

**Routes.** All of these are mounted only under `SYNTHETIC_FLEET_ENABLED`:

| Route | Who | What |
|-------|-----|------|
| `POST /api/sim/magnetometer/push` | simulator key | readings from the fleet, once a second; a push the fleet could not have sent is refused whole (400, naming the field) |
| `GET /api/sim/magnetometers` | admin | every magnetometer, the latest events, the scorecard, the settings and the detector's state |
| `GET /api/sim/magnetometers/{node_id}?window=60–1800` | admin | one magnetometer's measured field, residual and score over the last `window` seconds (600 by default), and its events |
| `POST /api/sim/magnetometers/flyby` | admin | fly a UAP past one magnetometer (or one the fleet picks); answers `{ok, flyby}` and leaves the config stamp unchanged |

A push may carry at most 100 magnetometers and 60 readings each, with a
`ts_ms` within 300 s of the server's clock. An entry the server will not
publish (a host that is not a synthetic radar node, an id not starting
`mag-`) is skipped and counted. The map payload's `detector` block carries
`common_mode_applied`, `reading_period_calibrated`, `false_alarm_model`,
`pushes_refused` and `entries_rejected`.

A flyby is a command: the route writes `mag_flyby` into the runtime config
and leaves the `_updated_at` stamp alone. The fleet flies each request once
and ignores one more than two minutes old. The UAP is an ordinary anomalous
world object, so the radar nodes see it too. The snapshot does not restore
`mag_flyby`.

**The map.** On `/sim` the Magnetometers toggle shows a badge per
magnetometer by state, a detection's range band, a summary card and a panel
per magnetometer with ten minutes of readings and a flyby button. The
settings are a section of the Physics Layer page (`/sim/physics`). The data
is polled from the admin routes every 2 s.

**Measuring the detector.** `backend/scripts/magnetometer_false_alarms.py`
runs the simulator's readings through the server's ingest, each push stamped
with its simulated time, on several processes:

```bash
cd backend && RETINA_ENV=dev .venv/bin/python -m scripts.magnetometer_false_alarms --json magnetometers.json  # about 1¾ h on 8 processes
cd backend && RETINA_ENV=dev .venv/bin/python -m scripts.magnetometer_false_alarms --quick                     # minutes: does it run
```

It prints a markdown report (`--json` writes the numbers too), and
`--checkpoint <file>` resumes a run that stopped. Rerun it after changing the detector, and carry what it fits over to the
code: the coefficient to `FALSE_ALARM_COEFFICIENT`, and the range band's
constants to `BAND_NEAR` and `BAND_FAR`.

---

## TCP Protocol (NodeConnection)

```jsonc
// 1. HELLO (client → server)
{"type": "HELLO", "version": "1.0", "node_id": "synth-GVL-SCAT-0001"}

// 2. CONFIG (client → server) — carries the full node geometry, including
//    beam_azimuth_deg / beam_width_deg / max_range_km / max_bistatic_range_km.
//    The server threads these into its per-node pipelines, arc builder and
//    inter-node association — dropping any of them regresses those layers
//    to defaults, so the CONFIG payload is the geometry contract.
{"type": "CONFIG", "node_id": "...", "config": { ... }, "config_hash": "abc123"}

// 3. CONFIG_ACK (server → client)
{"type": "CONFIG_ACK", "status": "ok", "node_id": "synth-GVL-SCAT-0001"}

// 4. DETECTION (client → server, every frame_interval seconds)
{
  "type": "DETECTION",
  "node_id": "synth-GVL-SCAT-0001",
  "timestamp": 1711800000000,
  "delay": [45.2, 78.1],
  "doppler": [22.3, -18.7],
  "snr": [21.4, 15.2],
  "adsb": [{"hex": "a1b2c3", "lat": 34.9, "lon": -82.4, "alt_baro": 8000, "gs": 450, "track": 270}]
}

// 5. HEARTBEAT (client → server, when no detections)
{"type": "HEARTBEAT", "node_id": "...", "timestamp": ...}
```

The server sends no response after `CONFIG_ACK`; subsequent messages are
unidirectional node → server.

---

## Running the Fleet Locally

```bash
# Greenville scene matching staging's shape, against a local backend. The
# layout is the generator's; the orchestrator then flies the scene it wrote,
# as deploy/fleet-entrypoint.sh does.
python3 -m retina_simulation.generator \
  --nodes 30 --metro gvl --layout scatter --n-cluster 20 --seed 42 \
  --output fleet_config.json
python3 -m retina_simulation.orchestrator \
  --config fleet_config.json --metro gvl \
  --mode adsb --interval 0.5 \
  --min-aircraft 20 --max-aircraft 40 \
  --host localhost --port 3012 --validation-url http://localhost:8000
```

The backend must run with `SYNTHETIC_FLEET_ENABLED=1`, as ONBOARDING's quick
start does: without it, every push the fleet makes over HTTP (ground truth,
ADS-B, the magnetometers' readings) answers 404, and the Physics page has no
magnetometer settings.

The first fleet generated for a metro (by the generator, or by the
orchestrator when it has no config file to fly) asks the Tower Search API
(towers.retina.fm) for that metro's towers and caches the answer in
`retina_simulation/metro_tower_cache.json`. That file is tracked, and the
backend's environment installs the library from `libs/retina-simulation`, so
the run leaves the submodule modified. Discard the change rather than commit
it: `git -C libs/retina-simulation checkout -- retina_simulation/metro_tower_cache.json`.

Key generator flags (`python3 -m retina_simulation.generator --help` lists
the rest):

| Flag | Default | Effect |
|------|---------|--------|
| `--nodes` | 200 | Total synthetic nodes to generate |
| `--metro` | (none) | Scope the scene to one metro |
| `--layout` | `ring` | Site layout: `ring`, `dual`, `scatter` |
| `--n-cluster` | 30 | The layout's share of the nodes: ring receivers (split across `--n-clusters` rings), dual nodes (two per site) or scatter sites |
| `--seed` | 42 | Deterministic scene generation. The seed is stamped into the config, and the magnetometers follow it |
| `--output` | `fleet_config.json` | Where the config is written |

Key orchestrator flags (`python3 -m retina_simulation.orchestrator --help`):

| Flag | Default | Effect |
|------|---------|--------|
| `--config` | `fleet_config.json` | The generator's config to fly; with no such file, the orchestrator generates a fleet itself |
| `--metro` | (none) | The metro's waypoint net for traffic, and the area for ADS-B |
| `--host` / `--port` | `localhost` / 3012 | The server's TCP node port |
| `--validation-url` | `http://localhost:8000` | The server's HTTP API: config polls, and the ground-truth, ADS-B and magnetometer pushes |
| `--mode` | `adsb` | `detection`, `adsb` or `anomalous` |
| `--interval` | 0.5 s | Seconds between detection frames per node |
| `--time-scale` | 1.0 | Simulation speed multiplier |
| `--concurrency` | 50 | Max simultaneous TCP connects at startup |
| `--min-aircraft` / `--max-aircraft` | 0 / 0 | Steady-state synthetic aircraft; 0 picks from the node count (under `--metro`, at least 15 / 30). The runtime config can override |
| `--seed` | 42 | Seeds a fleet the orchestrator generates itself, and the magnetometers when the config carries no stamp; otherwise the generator's stamp wins |
| `--magnetometers` / `--mag-placement` | 8 / `spread` | Starting magnetometer count and placement; the runtime config's `mag_*` keys take over at the first poll |

Beam width needs no flag: every antenna is the 42° Yagi. `--beam-width-deg`
exists only as an explicit override for experiments.
