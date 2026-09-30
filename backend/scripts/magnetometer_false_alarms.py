"""Measure the simulated magnetometer detector: false alarms and detections.

Runs the real code path, with no network in between and no clock to wait
for: the simulator's magnetometers (retina_simulation.magnetometer) produce
readings, and those readings go through services.sim_magnetometer's ingest
exactly as the live route sends them. Thousands of node-hours take minutes.
Three measurements:

1. **False-alarm rate against threshold.** Networks of magnetometers with no
   UAP anywhere: WMM background, the daily variation, datasheet noise. Every
   event is a false alarm. Reported per node-hour with a 95 % Poisson
   (Garwood) interval, beside the detector's model of that rate
   (sim_magnetometer.false_alarm_rate). The run also fits the model's
   coefficient afresh, which is how FALSE_ALARM_COEFFICIENT was set: rerun
   this after changing the detector, and carry the new coefficient over.
2. **A storm, with and without the common-mode step.** The same with an
   intense storm running (Dst −150 nT, pulsations). This is what subtracting
   the network's common mode is for.
3. **Detection probability against distance.** Straight passes of a 1e9 A·m²
   dipole at a range of closest-approach distances and speeds, at the default
   threshold. Each pass has a random dipole direction and a random heading.

Every threshold runs over the same simulated noise (the same seeds), so the
thresholds are compared on equal terms. Their counts are not independent.
Everything is seeded: a rerun of the same code gives the same counts.

    cd backend && RETINA_ENV=dev .venv/bin/python -m scripts.magnetometer_false_alarms
    cd backend && RETINA_ENV=dev .venv/bin/python -m scripts.magnetometer_false_alarms --quick

Prints a markdown report, with progress on stderr; --json writes the numbers
too.
"""

import argparse
import json
import math
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass

import numpy as np
from retina_simulation.magnetometer import (
    MagnetometerArray,
    MagnetometerSettings,
    Storm,
    build_magnetometer_push_payload,
    uniform,
)
from scipy import optimize, stats

from services.sim_magnetometer import (
    FALSE_ALARM_COEFFICIENT,
    FALSE_ALARM_POWER,
    SETTINGS_DEFAULTS,
    MagnetometerNetwork,
    false_alarm_rate,
)

T0 = 1_790_726_400.0  # 2026-09-30T00:00:00Z: a whole day, so the daily variation is in every run
PASS_ALTITUDE_KM = 0.3
SLANTS_KM = (0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5)
SPEEDS_MPS = (30.0, 100.0, 300.0)


def fleet(n: int) -> list[dict]:
    """n radar sites on a jittered grid about 20 km apart around Greenville, SC."""
    side = math.ceil(math.sqrt(n))
    return [
        {
            "node_id": f"synth-BENCH-{i:03d}",
            "rx_lat": 34.85 + 0.18 * (i // side - side / 2) + 0.03 * (uniform(1, "lat", i) - 0.5),
            "rx_lon": -82.39 + 0.22 * (i % side - side / 2) + 0.03 * (uniform(1, "lon", i) - 0.5),
            "rx_alt_ft": 900.0,
        }
        for i in range(n)
    ]


@dataclass
class Obj:
    object_id: str
    lat: float
    lon: float
    alt_km: float


def run_network(
    seed: int, nodes: int, seconds: int, threshold: float, *, storm: bool = False, common_mode: bool = True, passes=()
) -> dict:
    """One network, ``seconds`` long. ``passes``: callables of t giving an Obj, or None while out of range."""
    clock = [T0]
    network = MagnetometerNetwork(clock=lambda: clock[0])
    array = MagnetometerArray(
        node_configs=fleet(nodes), center=(34.85, -82.39), seed=seed, settings=MagnetometerSettings(n_nodes=nodes)
    )
    if storm:
        array.storm = Storm(start=T0 + 600, dst_min_nt=-150.0, seed=seed)
    settings = {**SETTINGS_DEFAULTS, "mag_threshold_sigma": threshold, "mag_common_mode": common_mode}
    for k in range(seconds):
        t = T0 + k
        clock[0] = t
        objects = [o for o in (fly(t) for fly in passes) if o is not None]
        network.ingest(build_magnetometer_push_payload(array, [(int(t * 1000), array.sample(objects, t))]), settings)
    # Close anything still open so it is counted.
    for node in list(network.nodes.values()):
        network._close_event(node, node.last_ms)
    card = network.scorecard()
    return {
        "node_hours": card["node_hours"],
        "false_alarms": card["false_alarms"],
        "true_detections": card["true_detections"],
        "events": [e.as_dict() for e in network.events],
    }


def pass_flyer(node, cpa_km: float, altitude_km: float, speed_mps: float, heading_deg: float, t_cpa: float, oid: str):
    heading = math.radians(heading_deg)
    along = (math.cos(heading), math.sin(heading))  # north, east
    right = (-math.sin(heading), math.cos(heading))

    def at(t):
        s_km = speed_mps * (t - t_cpa) / 1000.0
        north = right[0] * cpa_km + along[0] * s_km
        east = right[1] * cpa_km + along[1] * s_km
        if math.hypot(north, east) > 60:
            return None
        lat = node.lat + math.degrees(north / 6371.0)
        lon = node.lon + math.degrees(east / (6371.0 * math.cos(math.radians(node.lat))))
        return Obj(oid, lat, lon, node.alt_m / 1000.0 + altitude_km)

    return at


def run_job(job: dict) -> dict:
    """One unit of work for the pool; returns the job with its outcome."""
    if job["kind"] == "pd":
        seed, nodes = job["seed"], job["nodes"]
        horizontal = math.sqrt(max(job["slant_km"] ** 2 - PASS_ALTITUDE_KM**2, 0.0))
        array = MagnetometerArray(
            node_configs=fleet(nodes), center=(34.85, -82.39), seed=seed, settings=MagnetometerSettings(n_nodes=nodes)
        )
        target = array.nodes[seed % nodes]
        t_cpa = T0 + 900  # after warm-up and with the longest window full
        heading = 360.0 * uniform(seed, "pd-heading", 0)
        flyer = pass_flyer(target, horizontal, PASS_ALTITUDE_KM, job["speed_mps"], heading, t_cpa, f"uap-{seed}")
        r = run_network(seed, nodes, 900 + 700, job["threshold"], passes=[flyer])
        hit = any(e["node_id"] == target.node_id and e["truth"]["label"] == "true" for e in r["events"])
        return {**job, "hit": hit}
    r = run_network(
        job["seed"], job["nodes"], job["seconds"], job["threshold"], storm=job["storm"], common_mode=job["common_mode"]
    )
    return {**job, "node_hours": r["node_hours"], "false_alarms": r["false_alarms"]}


def garwood(k: int, exposure: float) -> tuple[float, float]:
    low = 0.0 if k == 0 else stats.chi2.ppf(0.025, 2 * k) / 2.0
    high = stats.chi2.ppf(0.975, 2 * k + 2) / 2.0
    return low / exposure, high / exposure


def fit_coefficient(rows: list[dict]) -> float:
    """Poisson maximum likelihood for A in rate = A · z^power · P(Z > z), over
    every threshold at once. With the shape fixed it has a closed form."""
    exposure = sum(r["node_hours"] * r["threshold"] ** FALSE_ALARM_POWER * stats.norm.sf(r["threshold"]) for r in rows)
    return sum(r["false_alarms"] for r in rows) / exposure


def fit_free_power(rows: list[dict]) -> tuple[float, float]:
    """The same fit with the exponent free as well: a check on the model's shape."""
    z = np.array([r["threshold"] for r in rows])
    hours = np.array([r["node_hours"] for r in rows])
    counts = np.array([r["false_alarms"] for r in rows])
    tail = stats.norm.sf(z)

    def negative_log_likelihood(params):
        log_a, power = params
        mu = hours * math.exp(log_a) * z**power * tail
        return float(np.sum(mu - counts * np.log(mu)))

    result = optimize.minimize(negative_log_likelihood, [math.log(500.0), 2.0], method="Nelder-Mead")
    return math.exp(result.x[0]), float(result.x[1])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--node-hours", type=float, default=2000.0, help="per threshold, noise only")
    parser.add_argument("--thresholds", default="3.5,4.0,4.5,5.0,5.5,6.0")
    parser.add_argument("--nodes", type=int, default=8)
    parser.add_argument("--storm-node-hours", type=float, default=200.0)
    parser.add_argument("--passes", type=int, default=40, help="per distance and speed")
    parser.add_argument("--processes", type=int, default=8)
    parser.add_argument("--quick", action="store_true", help="a small run to check the script works")
    parser.add_argument("--json", help="also write the numbers here")
    args = parser.parse_args()
    if args.quick:
        args.node_hours, args.storm_node_hours, args.passes = 40.0, 20.0, 4
    thresholds = [float(t) for t in args.thresholds.split(",")]
    default = float(SETTINGS_DEFAULTS["mag_threshold_sigma"])
    started = time.time()

    # Each noise job is one network for at most one simulated day, and every
    # threshold gets the same seeds.
    def noise_jobs(kind, node_hours, threshold, storm=False, common_mode=True):
        seconds_total = node_hours * 3600.0 / args.nodes
        per_job = min(86_400, max(3600, int(seconds_total / args.processes)))
        return [
            {
                "kind": kind,
                "seed": 1000 + i,
                "nodes": args.nodes,
                "seconds": per_job,
                "threshold": threshold,
                "storm": storm,
                "common_mode": common_mode,
            }
            for i in range(max(1, math.ceil(seconds_total / per_job)))
        ]

    jobs = [job for z in thresholds for job in noise_jobs("far", args.node_hours, z)]
    jobs += [job for cm in (True, False) for job in noise_jobs("storm", args.storm_node_hours, default, True, cm)]
    jobs += [
        {"kind": "pd", "seed": 5000 + k, "nodes": 8, "slant_km": s, "speed_mps": v, "threshold": default}
        for s in SLANTS_KM
        for v in SPEEDS_MPS
        for k in range(args.passes)
    ]
    # Longest first, so the pool is not left waiting on one long job at the end.
    jobs.sort(key=lambda j: -j.get("seconds", 1600))

    results = []
    with ProcessPoolExecutor(max_workers=args.processes) as pool:
        futures = [pool.submit(run_job, job) for job in jobs]
        for done, future in enumerate(as_completed(futures), start=1):
            results.append(future.result())
            if done % max(1, len(jobs) // 20) == 0 or done == len(jobs):
                print(f"{done}/{len(jobs)} jobs, {time.time() - started:.0f} s", file=sys.stderr, flush=True)

    def tally(selected):
        hours = sum(r["node_hours"] for r in selected)
        falses = sum(r["false_alarms"] for r in selected)
        return hours, falses

    far_rows = []
    for z in thresholds:
        hours, falses = tally([r for r in results if r["kind"] == "far" and r["threshold"] == z])
        low, high = garwood(falses, hours)
        far_rows.append(
            {
                "threshold": z,
                "node_hours": round(hours, 1),
                "false_alarms": falses,
                "far": falses / hours,
                "ci95": [low, high],
                "model": false_alarm_rate(z),
                "model_expected": false_alarm_rate(z) * hours,
            }
        )
    storm_rows = []
    for common_mode in (True, False):
        hours, falses = tally([r for r in results if r["kind"] == "storm" and r["common_mode"] == common_mode])
        low, high = garwood(falses, hours)
        storm_rows.append(
            {
                "common_mode": common_mode,
                "node_hours": round(hours, 1),
                "false_alarms": falses,
                "far": falses / hours,
                "ci95": [low, high],
            }
        )
    detection = []
    for s in SLANTS_KM:
        for v in SPEEDS_MPS:
            hits = [r["hit"] for r in results if r["kind"] == "pd" and r["slant_km"] == s and r["speed_mps"] == v]
            detection.append({"slant_km": s, "speed_mps": v, "passes": len(hits), "detected": sum(hits)})

    free_a, free_power = fit_free_power(far_rows)
    report = {
        "default_threshold": default,
        "model": {"coefficient": FALSE_ALARM_COEFFICIENT, "power": FALSE_ALARM_POWER},
        "fit": {"coefficient": fit_coefficient(far_rows), "free_coefficient": free_a, "free_power": free_power},
        "false_alarms": far_rows,
        "storm": storm_rows,
        "detection": detection,
        "runtime_s": round(time.time() - started, 1),
    }
    print_report(report, default)
    if args.json:
        with open(args.json, "w") as handle:
            json.dump(report, handle, indent=2)


def print_report(report, default):
    model, fit = report["model"], report["fit"]
    print(f"# Magnetometer detector: measured ({report['runtime_s']:.0f} s)\n")
    print(
        f"Model: {model['coefficient']:g} · z^{model['power']:g} · P(Z > z) false alarms per node-hour; "
        f"default threshold {default:g}σ.\n"
    )
    print(
        f"Fitted afresh from this run: coefficient {fit['coefficient']:.1f} with the exponent at {model['power']:g}; "
        f"{fit['free_coefficient']:.1f} · z^{fit['free_power']:.2f} with the exponent free.\n"
    )
    print("## False alarms, noise and daily variation only\n")
    print("| Threshold (σ) | Node-hours | False alarms | Model expects | Per node-hour | 95 % interval | Model |")
    print("| ---: | ---: | ---: | ---: | ---: | --- | ---: |")
    for r in report["false_alarms"]:
        print(
            f"| {r['threshold']:g} | {r['node_hours']:,.0f} | {r['false_alarms']} | {r['model_expected']:.1f} | "
            f"{r['far']:.4f} | {r['ci95'][0]:.4f}–{r['ci95'][1]:.4f} | {r['model']:.2g} |"
        )
    print("\n## A storm (Dst −150 nT with pulsations), at the default threshold\n")
    print("| Common mode | Node-hours | False alarms | Per node-hour | 95 % interval |")
    print("| --- | ---: | ---: | ---: | --- |")
    for r in report["storm"]:
        print(
            f"| {'removed' if r['common_mode'] else 'not removed'} | {r['node_hours']:,.0f} | {r['false_alarms']} | "
            f"{r['far']:.3f} | {r['ci95'][0]:.3f}–{r['ci95'][1]:.3f} |"
        )
    print(
        f"\n## Detection probability, 1e9 A·m², {PASS_ALTITUDE_KM * 1000:g} m above the sensor, at the default threshold\n"
    )
    speeds = sorted({r["speed_mps"] for r in report["detection"]})
    print("| Slant range at closest approach | " + " | ".join(f"{v:g} m/s" for v in speeds) + " |")
    print("| ---: | " + " | ".join("---:" for _ in speeds) + " |")
    for s in sorted({r["slant_km"] for r in report["detection"]}):
        cells = []
        for v in speeds:
            r = next(x for x in report["detection"] if x["slant_km"] == s and x["speed_mps"] == v)
            cells.append(f"{r['detected']}/{r['passes']}")
        print(f"| {s:g} km | " + " | ".join(cells) + " |")


if __name__ == "__main__":
    main()
