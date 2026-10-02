"""Simulation endpoints — the fleet orchestrator's write path, and the reads
and requests that only make sense beside a fleet.

Split out of routes/test.py. Three POSTs are DATA-INGEST paths from the fleet,
behind the simulator's API key, not diagnostics:

- /api/test/ground-truth/push and /api/sim/adsb/push write
  state.ground_truth_trails and state.adsb_aircraft directly;
- /api/sim/magnetometer/push feeds the simulated magnetometer network
  (services/sim_magnetometer.py), which keeps its own state and touches
  nothing on the radar path.

Beside them, admin-only, for the /sim map and the Physics page: the
magnetometer network's state (GET /api/sim/magnetometers), one magnetometer's
recent readings and score (GET /api/sim/magnetometers/{node_id}), and a
request for the fleet to fly a UAP past one (POST
/api/sim/magnetometers/flyby).

main.py mounts this router only under SYNTHETIC_FLEET_ENABLED=1, so a
deployment that runs no fleet carries none of it: no API-key-but-otherwise-open
ingest surface, and no admin reads of a network that does not exist.
"""

import asyncio
import time
from collections import deque
from collections.abc import Mapping
from datetime import datetime, timezone

import orjson
from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi.responses import Response

from config.constants import is_num
from core import state
from core.users import require_admin

# The API-key rule (and its production fail-fast) lives beside the other
# consumers in routes.test.
from routes.test import _verify_sim_key
from services import sim_magnetometer
from services.geo import valid_latlon
from services.id_utils import is_transponder_hex, normalize_hex_key

router = APIRouter()


def synthetic_fleet_enabled(env: Mapping[str, str]) -> bool:
    """Whether this deployment asked for the simulation subsystem.

    The gate on mounting the router below, and the whole of it. It used to be
    that any environment not named `production` got these routes, so a
    deployment carried a write path because of what it was called rather than
    because anyone chose it. Naming the behaviour lets a fleetless deployment
    close the path by dropping one line, whatever its name.

    Parameterised on `env` rather than reading os.environ so the rule is
    testable without importing main, which decides the mount once at import.
    """
    return env.get("SYNTHETIC_FLEET_ENABLED", "") == "1"


@router.post("/api/test/ground-truth/push")
async def push_ground_truth_snapshot(body: dict = Body(...), _key=Depends(_verify_sim_key)):
    ts = body.get("ts_ms", int(time.time() * 1000)) / 1000.0
    aircraft_list = body.get("aircraft", [])
    if not isinstance(aircraft_list, list):
        raise HTTPException(status_code=400, detail="aircraft list required")

    for ac in aircraft_list:
        hex_code = normalize_hex_key(ac.get("hex") or ac.get("adsb_hex") or "")
        if not hex_code:
            continue
        lat = ac.get("lat")
        lon = ac.get("lon")
        alt_m = ac.get("alt_m") or ac.get("alt_km", 0) * 1000
        if not valid_latlon(lat, lon):
            continue
        if hex_code not in state.ground_truth_trails:
            state.ground_truth_trails[hex_code] = deque(maxlen=state.GROUND_TRUTH_MAX)
        trail = state.ground_truth_trails[hex_code]
        moved = True
        if trail:
            dlat = abs(trail[-1][0] - lat)
            dlon = abs(trail[-1][1] - lon)
            moved = not (dlat < 0.00005 and dlon < 0.00005)
        if moved:
            trail.append([round(lat, 6), round(lon, 6), round(alt_m, 0), round(ts, 1)])
        else:
            # Sub-5.5 m movement: don't append a duplicate point, but DO
            # refresh the liveness timestamp and fall through to the meta /
            # anomaly update.  The old `continue` here starved slow or
            # hovering objects: their last trail timestamp aged past the
            # GT_DISPLAY_STALE_S GC while they were still being pushed every
            # 2 s, so the dot blinked out until they cleared 5.5 m — and
            # anomaly transitions during a hover were silently dropped.
            trail[-1][3] = round(ts, 1)
        # Store/update metadata for this ground truth object
        state.ground_truth_meta[hex_code] = {
            "object_type": ac.get("object_type", "aircraft"),
            "is_anomalous": ac.get("is_anomalous", False),
            "speed_ms": ac.get("speed_ms", 0),
            "heading": ac.get("heading", 0),
            "has_adsb": ac.get("has_adsb", False),
            # Transponder present but silent right now (simulator outage).
            # has_adsb stays true, so the dark count is unaffected — this is
            # what tells the known-track hold apart from a genuinely dark
            # aircraft.
            "adsb_silent": ac.get("adsb_silent", False),
            "adsb_callsign": ac.get("adsb_callsign"),
            "anomaly_event": ac.get("anomaly_event"),
            # "live" for an aircraft the simulator mirrored from the ADS-B
            # feed, "sim" for its own spawns (older fleets send neither).
            "source": ac.get("source") or "sim",
        }
        # Flag anomalous objects and log events
        if ac.get("is_anomalous"):
            with state.anomaly_lock:
                if hex_code not in state.anomaly_hexes:
                    state.anomaly_hexes.add(hex_code)
                    event = {
                        "hex": hex_code,
                        "ts": round(ts, 1),
                        "lat": round(lat, 5),
                        "lon": round(lon, 5),
                        "reason": "anomalous_behavior",
                        "object_type": ac.get("object_type", "unknown"),
                        "flagged_at": datetime.now(timezone.utc).isoformat(),
                    }
                    state.anomaly_log.append(event)
                    if len(state.anomaly_log) > state.ANOMALY_LOG_MAX:
                        state.anomaly_log = state.anomaly_log[-state.ANOMALY_LOG_MAX :]
        else:
            with state.anomaly_lock:
                state.anomaly_hexes.discard(hex_code)

    return {"status": "ok", "received": len(aircraft_list), "tracked_hex": len(state.ground_truth_trails)}


def _sim_push_ts_ms(body: dict, now_s: float) -> int:
    """The push's capture time, in epoch ms, bounded forwards only.

    ts_ms is caller-supplied, and feed_gc is the only pruner of adsb_aircraft:
    a stamp ahead of us gives a permanently negative age, so the record would
    read fresh to every 60 s gate and never be collected.  The past is left
    alone deliberately — a backdated push ages out on its own, and replay
    depends on being able to say when a position was really measured.
    """
    ts_ms = body.get("ts_ms")
    now_ms = int(now_s * 1000)
    if not is_num(ts_ms) or ts_ms <= 0 or ts_ms > now_ms:
        return now_ms
    return int(ts_ms)


@router.post("/api/sim/adsb/push")
async def sim_push_adsb_positions(body: dict = Body(...), _key=Depends(_verify_sim_key)):
    """Simulator pushes live ADS-B positions every second directly into state.adsb_aircraft.

    This keeps each aircraft's position current at 1 Hz regardless of how many
    nodes happen to observe it in a given frame interval.

    The optional body field "source" declares which world the positions belong
    to: "real" for the simulator's adsb.lol relay of live traffic, anything
    else (including absent — every simulator before the tag existed) for the
    simulated fleet itself.  Claiming keys on the stored "world" tag so a
    synthetic node cannot bind its echoes to a relayed real aircraft: with
    both populations in one cache over one footprint, every real aircraft is
    a decoy whose delay/Doppler a wrong echo matches by coincidence, and each
    such bind put a plane icon on the map that no radar ever measured.
    """
    ts_ms = _sim_push_ts_ms(body, time.time())
    aircraft_list = body.get("aircraft", [])
    if not isinstance(aircraft_list, list):
        raise HTTPException(status_code=400, detail="aircraft list required")
    world = "real" if body.get("source") == "real" else "sim"

    updated = 0
    rejected = 0
    for ac in aircraft_list:
        hex_code = normalize_hex_key(ac.get("hex") or "")
        if not hex_code:
            continue
        # A dark object has no transponder, so nothing about it belongs in
        # state.adsb_aircraft.  Older simulators push every aircraft here with
        # the object id standing in for the hex; accepting those minted a fake
        # transponder per dark target, every dark solve then keyed mn-adsb-*
        # and the dark lane was permanently empty.
        if not is_transponder_hex(hex_code):
            rejected += 1
            continue
        lat = ac.get("lat")
        lon = ac.get("lon")
        if not valid_latlon(lat, lon):
            continue
        rec = {
            "hex": hex_code,
            "flight": ac.get("flight", ""),
            "lat": lat,
            "lon": lon,
            "alt_baro": ac.get("alt_baro", 0),
            "gs": ac.get("gs", 0),
            "track": ac.get("track", 0),
            "last_seen_ms": ts_ms,
            "world": world,
        }
        # Derived once here, not per read — see state.adsb_derived_fields.
        # Published only after it is complete: readers snapshot unlocked.
        rec.update(state.adsb_derived_fields(rec))
        state.adsb_aircraft[hex_code] = rec
        updated += 1

    if updated:
        state.aircraft_dirty = True
    if rejected:
        state.bump_counter("sim_adsb_push_rejected_hex", rejected)

    return {"status": "ok", "updated": updated, "rejected_hex": rejected}


# ── Simulated magnetometers ──────────────────────────────────────────────────
# The fleet's magnetometers (retina_simulation.magnetometer) push their
# readings here once a second; services/sim_magnetometer.py detects anomalous
# objects in them across the network. The reads below serve the admin /sim map
# and are admin-only, like the page. None of it touches the radar path: no
# node registry, no ground-truth or anomaly stores, no websocket feed.
#
# The network's work runs off the event loop: detection is CPU work (about
# 0.1 ms per magnetometer-second), and the lock a push holds while it detects
# is the one the reads take too.


@router.post("/api/sim/magnetometer/push")
async def sim_push_magnetometers(body: dict = Body(...), _key=Depends(_verify_sim_key)):
    """One second (or a few, after a missed push) of every magnetometer.

    Every field is checked before any of it is applied: a body the fleet could
    not have sent (a wrong type, a reading stamped seconds after the push
    itself, a push whose clock is minutes off this server's, more rows than
    the fleet ever holds back) is refused whole with 400, naming the field, and
    counted. A well-formed entry this server will not publish (a host that is
    not a synthetic node, a position off the globe) is skipped and counted.
    Both counts are in the snapshot's detector block.
    """
    settings = sim_magnetometer.effective_settings(state.simulation_config)
    try:
        result = await asyncio.get_running_loop().run_in_executor(None, sim_magnetometer.network.ingest, body, settings)
    except ValueError as exc:
        state.bump_counter("sim_magnetometer_push_refused")
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if result["rejected"]:
        state.bump_counter("sim_magnetometer_push_rejected", result["rejected"])
    return {"status": "ok", **result}


@router.get("/api/sim/magnetometers")
async def sim_magnetometers(_admin=Depends(require_admin)):
    """Every magnetometer's state and latest score, the latest events, and the
    live scorecard (false alarms per node-hour with its 95 % interval)."""
    settings = sim_magnetometer.effective_settings(state.simulation_config)
    snapshot = await asyncio.get_running_loop().run_in_executor(None, sim_magnetometer.network.snapshot, settings)
    # What the push turned away since this server started, beside what the
    # detector made of the rest: pushes refused whole (each is readings lost,
    # since the fleet drops a refused push) and entries skipped.
    snapshot["detector"]["pushes_refused"] = state.sim_magnetometer_push_refused
    snapshot["detector"]["entries_rejected"] = state.sim_magnetometer_push_rejected
    return Response(content=orjson.dumps(snapshot), media_type="application/json")


@router.get("/api/sim/magnetometers/{node_id}")
async def sim_magnetometer_detail(
    node_id: str,
    # Up to what a magnetometer keeps to show: half an hour.
    window: int = Query(600, ge=60, le=sim_magnetometer.DISPLAY_S),
    _admin=Depends(require_admin),
):
    """One magnetometer's measured field, residual and score over the last
    ``window`` seconds, and its events."""
    settings = sim_magnetometer.effective_settings(state.simulation_config)
    detail = await asyncio.get_running_loop().run_in_executor(
        None, sim_magnetometer.network.node_detail, node_id, window, settings
    )
    if detail is None:
        raise HTTPException(status_code=404, detail="no such magnetometer")
    return Response(content=orjson.dumps(detail), media_type="application/json")


@router.post("/api/sim/magnetometers/flyby")
async def sim_magnetometer_flyby(body: dict = Body(...), _admin=Depends(require_admin)):
    """Ask the fleet to fly a UAP past a magnetometer.

    A command, not a setting: it rides in the polled config as ``mag_flyby``,
    with a number for people and the time of the request, and leaves the
    config's stamp alone. The stamp says the settings changed, and a flyby
    taken for that, from another tab say, would read on the Physics page as
    someone else's edit. The fleet reads ``mag_flyby`` on every poll; a running
    fleet flies each request once, by its time, and ignores one it only sees
    minutes later (a restart). It is not persisted.
    """
    try:
        request = sim_magnetometer.validate_flyby(body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    previous = state.simulation_config.get("mag_flyby") or {}
    flyby = {**request, "seq": int(previous.get("seq", 0)) + 1, "requested_at": time.time()}
    state.simulation_config["mag_flyby"] = flyby
    return {"ok": True, "flyby": flyby}
