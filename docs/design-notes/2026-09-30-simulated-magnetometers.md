# Simulated magnetometers beside the fleet's radar nodes

30 September 2026. Part C of the RM3100 magnetometer task. Parts A and B, a
node app for a real RM3100 and a register-level simulator of the chip, live in
their own repository, retina-magnetometer. Its design note covers the task as
a whole. This note covers what landed here and in `libs/retina-simulation`.

## What it adds

The fleet simulator can put an RM3100 magnetometer beside some of its radar
receive sites. Each one reads the field the simulated world produces:

- WMM2025;
- the site's crust;
- the solar-quiet daily variation;
- an optional storm;
- every anomalous object as a 1e9 A·m² magnetic dipole;
- the chip's noise and quantisation.

It sends the readings to the server once a second. The server detects UAP
passes over the network as a whole, scores every detection against the
simulator's truth, and measures its own false-alarm rate. The `/sim` map shows
the magnetometers, their state, their detections and that scorecard, and the
Physics Layer page holds their settings.

It is simulation only. Every route and every setting exists only under
`SYNTHETIC_FLEET_ENABLED`. The radar pipeline, `/v1/nodes` and its generated
contract, the aircraft WebSocket, and the ground-truth and anomaly stores
radar scoring reads are all untouched.

## Where the data goes, and why there

**Its own push, not TCP 3012.** The server treats every node that connects
on 3012 as a radar node: association, analytics, the node list, `/v1/nodes`.
A magnetometer registered there would have to be filtered out of each of
those, in code that has no reason to know about magnetometers. Instead the
orchestrator posts the readings to `POST /api/sim/magnetometer/push` with the
simulator's key, the way it already pushes ground truth and ADS-B. The push
lists every current magnetometer even when it has no new samples, so the
server learns when the simulator removes one.

**Admin-only polling, not the WebSocket.** The aircraft socket is
unauthenticated and broadcasts on aircraft changes, and magnetometer data is
simulation-only. The map polls `GET /api/sim/magnetometers` (admin) every 2 s
while the layer is on, and one magnetometer's detail while its panel is open.

**Positions through `public_latlon`.** A magnetometer sits on a radar node's
roof. The snapshot therefore publishes its position through the same rule as
radar nodes, so it can never reveal a site the radar node itself does not.
The push also refuses any entry whose host is not a synthetic node.

**Settings in the existing runtime config.** The `mag_*` keys sit beside the
other simulation keys in `GET/PUT /api/simulation/config`, as the task asks.
That router is mounted everywhere, so the keys are gated by hand:

- the GET omits them without the flag;
- a PUT carrying one is refused with 400;
- they are validated key by key;
- the snapshot restores them.

Two of them, `mag_threshold_sigma` and `mag_common_mode`, are the server's
own and take effect at once. The rest reach the fleet at its next poll and
are applied in-process. The magnetometers hold no connection, so, unlike the
scene keys, nothing restarts.

**Flybys through the same config.** A demo needs a UAP on demand.
`POST /api/sim/magnetometers/flyby` writes `mag_flyby` into the runtime
config with:

- a sequence number;
- the time of the request;
- a bump of `_updated_at`, because the fleet applies config only when the
  stamp moves.

The fleet flies each request once. It tells new from old by the time of the
request, not its number: the number is not persisted, so a restarted server
counts from one again, while the running fleet remembers the last number it
flew and would take every request after that for an old one. It ignores a
request more than two minutes old when it first sees it, so a restarted fleet
does not replay the last pass. The pass is an ordinary anomalous world object on a scripted
track: the radar nodes see it, and the ground-truth push carries it.
`mag_flyby` is deliberately left out of the snapshot's restore keys.

## The detector

`services/sim_magnetometer.py`, once per second of data. Each step has its
reason:

1. **Static level: a trimmed mean** (the middle half) of each node's last
   30 minutes. The first version used a median. The readings are quantised at
   13.3 nT a count, so a median sits on a count and moves a whole count at a
   time, and those 13 nT steps were exactly what the long windows detect. The
   level is refreshed every 30 s, on the same second at every node, so what
   the refresh itself moves is common to the network.
2. **Noise from first differences:** the standard deviation after clipping,
   over 10 minutes. A MAD of quantised differences also lands on a count, and
   it underestimated the noise by enough that the χ² tail, where the threshold
   lives, came out orders of magnitude too heavy.
3. **Common mode: the median of the other nodes.** The daily variation
   (30–90 nT) and storms (~110 nT) are the same across the fleet to within a
   few nT, so each node has the per-axis median of the other nodes' deviations
   subtracted from it. The first version included the node in its own median.
   Whenever the node was the middle value, its residual collapsed to zero, and
   that tied the residual to the node's own noise and fattened the tails.
4. **Matched filter, six scales.** On every axis, a dipole passing on a
   straight line produces a combination of the three Anderson functions
   uⁿ/(1+u²)^(5/2), n = 0, 1, 2, with u = (t − t₀)/τ (Anderson 1949;
   Sheinker et al. 2009). At τ = 2, 4, 8, 16, 32 and 64 s, the last ±4τ of
   residual is projected onto that span, orthogonalised against a constant
   and a slope. Energy over variance is χ² with 9 degrees of freedom under
   noise alone, and its tail probability becomes a Gaussian score. A window
   that spans a gap in the data is skipped.
5. **Events.** An event opens at the threshold. It then works out three
   things.
   - **Where its peak is.** While the event is open, the peak (t₀, strength,
     τ, score) follows the unclipped χ² statistic, not the score. The score
     stops at 40σ, and a strong pass reaches that in its first window: a
     short scale, catching only the leading edge, whose fit overstated one
     flyby's field 2.4-fold. The statistic keeps growing until the window
     best matched to the pass is centred on its closest approach.
   - **When it is over.** It closes once its peak's scale, and every shorter
     one, has stayed under the threshold minus one for 5 s, and the peak's
     own window has passed. The longer scales are left out of that test.
     They are mismatched to the pass but still hold it, and for a strong pass
     they stay far above threshold for as long as their windows last: the
     first version kept a close flyby "detecting" for eight minutes.
   - **What may follow it.** After it closes, no window that overlaps it may
     open another. That window would be looking at the same pass.
6. **Truth.** An event is true if a UAP put at least 1 nT on the node while
   it was open, padded by its window. The label is recomputed every second
   while the event is open, because the UAP may still be closing in. A pass
   of 20 nT or more counts as found if an event was open at any point during
   it. The scorecard restarts whenever the threshold or the common-mode
   setting changes.

Each event carries:

- the time of closest approach;
- the strength (the fitted signal's peak, in nT);
- the score;
- a confidence;
- `noise_once_per_h`, how many node-hours noise alone takes to do as much;
- a range band, the distances at which the configured moment produces that
  strength, from the dipole's equator to its axis, ±15 %.

### Turned down

- **A threshold on |B| or on each axis's deviation.** The daily variation and
  a storm are several times the 15 nT noise.
- **A high-pass filter per node.** Storm pulsations (45–600 s) share the time
  scales of a pass.
- **Detection in the simulator.** It would be grading itself.
- **A single scale.** A matched filter is matched to one τ.
- **A learned classifier.** Its false-alarm rate could not be stated in
  advance.

## Calibration

`scripts/magnetometer_false_alarms.py` runs the simulator's readings through
`ingest` exactly as the route does, on a fake clock, in parallel. It measured
2,109 node-hours per threshold with no UAP anywhere, the same simulated days
for every threshold:

| Threshold | False alarms | Per node-hour | 95 % interval (Garwood) | Model |
| ---: | ---: | ---: | --- | ---: |
| 3.5σ | 2,886 | 1.37 | 1.32–1.42 | 1.37 |
| 4.0σ | 506 | 0.240 | 0.220–0.262 | 0.243 |
| 4.5σ | 75 | 0.036 | 0.028–0.045 | 0.033 |
| 5.0σ | 5 | 0.0024 | 0.0008–0.0055 | 0.0034 |
| **5.5σ** | **0** | **0** | **0–0.0017** | **0.00028** |
| 6.0σ | 0 | 0 | 0–0.0017 | 0.000017 |

**The model** is `false_alarm_rate(z)`: A · z² · P(Z > z) per node-hour, with
`FALSE_ALARM_COEFFICIENT` A = 480. It is where the confidence and
`noise_once_per_h` come from, and it is what the Physics page shows beside the
measured rate while the threshold slider moves.

- **Why z².** The detector searches over time and over time scale. For a
  search over two parameters, the rate of distinct excursions falls as
  z·φ(z) ≈ z²·P(Z > z), not as the tail probability alone (Siegmund &
  Worsley 1995, *Ann. Statist.* 23; Worsley 2001, *Adv. Appl. Prob.* 33, for
  χ² fields).
- **How A was fitted.** By Poisson maximum likelihood over all six
  thresholds. The model's expected counts (2,885, 513, 69.7, 7.26, 0.58, 0.04)
  lie inside the measured interval at every threshold, and a free exponent
  fits as 1.95.
- **What it replaced.** The first model, a fixed number of independent looks
  per hour, underpredicted by 4–7×, increasingly with the threshold.

**The rate has no daily cycle:**

- Sixteen further simulated days, binned by hour at 3.5σ, show none
  (χ² = 32.2 on 23 degrees of freedom, p = 0.10).
- A daytime-against-night comparison, decided before 16 more days were run,
  found equal rates (2,044 against 2,035 alarms).

The common mode removes the daily variation at every hour.

**The default, 5.5σ,** is about one false alarm every 19 days across eight
magnetometers. The next step down, 5σ, would be about one every two days, for
2–3 % more reach. A signal 8 % weaker is enough at 5σ, but a pass's signal
falls so steeply with distance (the field as 1/r³) that 8 % weaker is only a
little further out.

**A storm,** Dst −150 nT with pulsations, at 5.5σ over 198 node-hours:

| Common mode | False alarms | Per node-hour | 95 % interval |
| --- | ---: | ---: | --- |
| removed | 0 | 0 | 0–0.019 |
| not removed | 313 | 1.58 | 1.41–1.77 |

**Detection probability.** A single 1e9 A·m² pass 300 m above the sensor, on a
random heading with a random dipole direction, at 5.5σ, with 40 passes per
cell:

| Slant range at closest approach | 30 m/s | 100 m/s | 300 m/s |
| ---: | ---: | ---: | ---: |
| 0.5 km | 40/40 | 40/40 | 40/40 |
| 1.0 km | 40/40 | 40/40 | 40/40 |
| 1.5 km | 40/40 | 38/40 | 14/40 |
| 2.0 km | 30/40 | 4/40 | 0/40 |
| 2.5 km | 5/40 | 0/40 | 0/40 |
| 3.0 km | 0/40 | 0/40 | 0/40 |

A magnetometer at datasheet noise is a tripwire with a reach of about 1.5 km,
and about 2 km for slow passes. Rerun the script after changing anything in
the detector, and carry the fitted coefficient over.

## The map

- **Badges, not node markers.** DivIcons in the marker pane, class
  `mag-marker`. `panes.ts` explains why a second interactive canvas would
  swallow the map's clicks, and the E2E suite counts `.node-marker`. A badge
  sits up and to the right of its radar node's own dot, at the map's own
  position for that site.
- **The map's own colours.** Quiet is the node colour, elevated (within 1.5σ
  of the threshold) WARN, detecting ANOMALY, warming up or silent INK_SUBTLE.
  All come from `usePalette`, and the charts from `useChartTheme`, so both
  themes work and the colour-token tests hold.
- **A range band** while a detection is open, and for a minute after it
  closes. It is an annulus, drawn as a polygon with a hole.
- **A summary card**:
  - the live false-alarm rate with its interval;
  - passes found;
  - the latest events, each opening its magnetometer.
- **A panel per magnetometer**:
  - ten minutes of score against the threshold, and of residual field;
  - the current event, with its truth;
  - earlier events;
  - a button that flies a UAP past it, so a detection can be watched from
    start to finish without leaving the map.
- **A toast** when a detection starts. Events already open when the page
  loads are not announced.

The layer and its toggle exist only on `/sim`, and only when the server runs a
fleet. The settings are a section of the Physics Layer page. It has its own
Apply, which carries only the `mag_*` keys, and it hands its config stamp back
to the page, so the page's drift check does not take the section's own write
for a restart.

## Not done

- **Real data.** Nothing here reaches a real magnetometer. A real network
  would need its readings to reach the server through a new, versioned node
  contract, and the task ruled out changing `/v1/nodes`.
- **Recalibration on real data.** Real sites have magnetic clutter, drift
  and a less common common mode. The coefficient, and so every confidence,
  must be measured again on real data before a threshold means anything.
- **Localisation.** When a pass is seen by two or more magnetometers, their
  fitted strengths and timings could locate and track it. The `core`
  placement exists to make that likely in simulation. It is not attempted.
