# Simulated magnetometers beside the fleet's radar nodes

30 September 2026, revised 2 October 2026. Part C of the RM3100 magnetometer
work. Parts A and B, a node app for a real RM3100 and a register-level
simulator of the chip, live in their own repository, retina-magnetometer,
whose design note covers all three parts. This note covers what landed here
and in `libs/retina-simulation`.

## What it adds

The fleet simulator can put an RM3100 magnetometer beside some of its radar
receive sites. Each reads WMM2025, its site's crust, the solar-quiet daily
variation, an optional storm and every anomalous object as a 1e9 A·m²
magnetic dipole, with the chip's noise and quantisation, and the fleet posts
the readings once a second. The server detects UAP passes over the network
as a whole, scores each detection against the simulator's truth and measures
its own false-alarm rate. The `/sim` map shows the magnetometers and their
detections, and the Physics Layer page holds their settings and a flyby
button.

It is simulation only. Every magnetometer route is mounted only under
`SYNTHETIC_FLEET_ENABLED`, and none of the data reaches the radar pipeline,
`/v1/nodes` and its contract, the aircraft WebSocket, or the stores radar
scoring reads.

## Where each requirement is met

| Requirement | Where it is met |
| --- | --- |
| Magnetometers beside radar nodes | `retina_simulation/magnetometer.py`: at most one per receive site, `mag-<node id>`, placed `spread`, `core` or seeded `random` |
| Readings from objects, the Earth's field and noise | WMM2025, crust, daily variation, storm, each anomalous object as a dipole, RM3100 datasheet noise in counts |
| Events with time, strength and confidence | `backend/services/sim_magnetometer.py` ([The detector](#the-detector)): `peak_ms`, `strength_nt`, `confidence` |
| False-alarm rate, measured and reported | The live scorecard, per node-hour searched with a 95 % interval; `scripts/magnetometer_false_alarms.py` ([What it measured](#what-it-measured)) |
| Results sent to the server | `POST /api/sim/magnetometer/push`, once a second ([Where the data goes](#where-the-data-goes)) |
| The `/sim` map with state and recent readings | Badges by state, range bands, a summary card, a ten-minute panel ([The map and the settings](#the-map-and-the-settings)) |
| Runtime settings in the existing style | `mag_*` keys in `/api/simulation/config`, a Physics Layer section, restored by the snapshot |
| Simulation only | Push, reads and flyby mounted only under the flag; the config route hides and refuses `mag_*` keys without it |
| Radar pipeline and `/v1/nodes` unchanged | Own push and module; contract unchanged. A flyby's UAP is an ordinary anomalous object the radars see |

## Where the data goes

The server treats every node on TCP 3012 as a radar node (association,
analytics, the node list, `/v1/nodes`), so the readings take their own push,
`POST /api/sim/magnetometer/push` with the simulator's key, beside the
ground-truth and ADS-B pushes. A push the fleet could not have sent (over 100
magnetometers or 60 readings each, a clock more than five minutes off) is
refused whole with 400 and counted. An entry the server will not publish,
such as a host that is not a synthetic radar node, is skipped and counted.
The aircraft socket is unauthenticated, so the map polls
`GET /api/sim/magnetometers` (admin) every 2 s instead. Positions go through
`public_latlon`, so a magnetometer never reveals a site its radar node does
not.

## The detector

`services/sim_magnetometer.py` runs once per second of readings, over every
magnetometer at once.

**Static level and noise.** The static level is a trimmed mean (the middle
half) of the last 30 minutes, refreshed every 30 s on the same second at
every node. A median, tried first, moved in whole 13.3 nT counts, and the
long windows detected those steps. The noise is the standard deviation of
the residual's first differences over the last 10 minutes, outliers clipped,
divided by √2 and floored at 0.3 times the datasheet figure; a MAD of
quantised differences lands on a count and underestimated it. The estimate
starts again when the residual's noise changes (a new cycle count, the
common mode switched), and the magnetometer scores nothing until it has a
minute of new residual. A young estimate is less certain: over n readings
the statistic follows 9·F(9, 2(n − 1)). Every statistic is therefore mapped
to the one with the same tail probability over 600 readings, so the
false-alarm rate holds from the first scored minute.

**The common mode.** The daily variation (30–90 nT peak to peak in its
largest component) and a storm (about 105 nT at the Dst minimum) are the
same across the fleet to within a few nT, so each magnetometer has the
per-axis median of the other magnetometers' deviations subtracted. A UAP is
local: its field falls as 1/r³, from 100–200 nT at 1 km to 4–7 nT at 3 km.
The median therefore leaves out any magnetometer with an event open or
scoring 3σ, and every magnetometer within 3 km of one, because a pass that
lifts a magnetometer to 3σ can already put tens of nT on a neighbour that
does not score yet. Over 240 passes across a dense cluster, the far
magnetometers raised 126 false alarms with only the alarming ones left out,
67 with the 3σ ones too, and none with their 3 km neighbours as well. A
magnetometer at or beside an event takes clear magnetometers only, and each
window is scored against the extra noise a median of few carries. With no
one left, a magnetometer holds its recent common mode for three minutes at
most, and its windows begin again where a hold ends. The common mode is
subtracted only while six or more magnetometers report: two magnetometers
on one pass, which is what core placement is for, need five others to keep
the median clear of it.

**The matched filter.** A dipole passing on a straight line produces, on
every axis, a combination of the three Anderson functions uⁿ/(1+u²)^(5/2),
n = 0, 1, 2, with u = (t − t₀)/τ, t₀ the time of closest approach and τ the
slant range there divided by the speed (Anderson 1949; Sheinker et al.
2009). At τ = 2, 4, 8, 16, 32 and 64 s the last ±4τ of residual is projected
onto those functions, orthogonalised against a constant and a slope. Energy
over variance is χ² with 9 degrees of freedom under noise alone, and its
tail probability becomes a one-sided Gaussian score, clipped at 40σ. No
window spans a gap of more than 5 s, a restart of the noise estimate or the
ends of a hold.

**The score and the false-alarm model.** `false_alarm_rate(z)`,
A · z² · P(Z > z) per node-hour with `FALSE_ALARM_COEFFICIENT` A = 470, is
how often noise alone reaches a score z at one magnetometer. The z² comes
from the search over two parameters, time and time scale (Siegmund & Worsley
1995, *Ann. Statist.* 23; Worsley 2001, *Adv. Appl. Prob.* 33). A was fitted
by Poisson maximum likelihood over all the thresholds at once. An event's
confidence is exp(−rate), the probability that noise alone would not produce
an event at least this strong at this magnetometer within an hour. The model
was fitted with the common mode subtracted, no storm and readings a second
apart; an event opened outside those conditions is marked uncalibrated, and
the map gives it no confidence.

**Events and the range band.** An event opens when the best score reaches
the threshold, and its peak follows the unclipped χ² statistic. It closes
once its peak's scale and every shorter one have stayed under the threshold
minus one for five readings. The longer scales are left out of that test:
counting them kept a close flyby "detecting" for eight minutes. τ and the
strength are refined at the pass's own time scale, between the six search
scales. The range band is where the configured dipole moment would put that
strength, between the distance at which it gives that field on its equator
and 2^(1/3) times that on its axis. A weak detection reads its strength high,
so each end moves by a constant plus a term in 1/(score − 2σ) (`BAND_NEAR`,
`BAND_FAR`), fitted to keep 98 % of every score bin's passes inside. Each
event carries `peak_ms`, `strength_nt`, `score_sigma`, `tau_s`,
`confidence`, `noise_once_per_h`, `range_km`, `calibrated` and `truth`.

**Truth and the scorecard.** The simulator sends the truth beside each
reading (the UAP field at the magnetometer, the nearest UAP and its slant
range), and it never feeds detection. An event is true if, over its peak
window, the truth field carries at least one noise variance of energy,
enough to make a crossing three (3.5σ) to eight (5.5σ) times likelier than
noise alone. A pass is counted when the UAP field at a magnetometer rises
20 nT, and found if a true event is or was open during it. False alarms are
counted per node-hour searched, a second counting by the share of the six
scales running while the windows refill after a start or a gap, with an
exact (Garwood) 95 % interval. The scorecard starts again when the
threshold, the common mode actually subtracted, the sensor setting or the
storm changes.

Rejected: a threshold on |B| or each axis (the daily variation and a storm
are several times the 15 nT noise); a high-pass filter per node (storm
pulsations share a pass's time scales); detection in the simulator, which
would be grading itself; a single scale; and a learned classifier, whose
false-alarm rate could not be stated in advance.

## What it measured

`scripts/magnetometer_false_alarms.py` runs the simulator's readings through
`ingest` exactly as the route does, seeded, on eight magnetometers about
20 km apart around Greenville, SC, at 200 cycles, with the common mode
subtracted. One run at the defaults takes about an hour and three quarters
on eight processes. Rerun it after changing the detector, and carry what it
fits to `FALSE_ALARM_COEFFICIENT`, `BAND_NEAR` and `BAND_FAR`.

False alarms with no UAP anywhere, against the model:

| Threshold | Node-hours | False alarms | Per node-hour (95 %) | Model |
| ---: | ---: | ---: | --- | ---: |
| 3.0σ | 3,065 | 17,455 | 5.70 (5.61–5.78) | 5.71 |
| 3.5σ | 3,065 | 4,163 | 1.36 (1.32–1.40) | 1.34 |
| 4.0σ | 3,065 | 716 | 0.234 (0.217–0.251) | 0.238 |
| 4.5σ | 3,065 | 107 | 0.035 (0.029–0.042) | 0.032 |
| 5.0σ | 9,194 | 25 | 0.0027 (0.0018–0.0040) | 0.0034 |
| 5.5σ | 9,194 | 1 | 0.00011 (0.0000028–0.00061) | 0.00027 |
| 6.0σ | 3,065 | 0 | 0 (0–0.0012) | 0.000017 |

Detection probability at 5.5σ, a 1e9 A·m² pass 300 m above the
magnetometer, 60 passes per cell:

| Slant range | 30 m/s | 100 m/s | 300 m/s |
| ---: | ---: | ---: | ---: |
| 1.0 km | 60/60 | 60/60 | 60/60 |
| 1.5 km | 60/60 | 57/60 | 19/60 |
| 2.0 km | 49/60 | 9/60 | 0/60 |
| 2.5 km | 7/60 | 0/60 | 0/60 |
| 3.0 km | 0/60 | 0/60 | 0/60 |

- At the default 5.5σ the model gives about one false alarm every 19 days
  across eight magnetometers (measured: 1 in 9,194 node-hours), and an event
  at the threshold carries a confidence of 0.9997. A free exponent fits as
  2.03 (1.87–2.20). At 3.5σ six magnetometers alarm 2.1 % more than eight,
  seven 1.3 % more and twelve 0.4 % less.
- No daily cycle: 8,367 false alarms in 6,137 node-hours at 3.5σ, binned by
  local solar time, give χ² = 28.6 on 23 degrees of freedom (p = 0.19).
- Storms (Dst −150 nT, eight at each of six, seven and eight magnetometers,
  5.5σ): no false alarms with the common mode removed, and 1,833, 2,139 and
  2,426 with it left in.
- Reach at 5.5σ, nine passes in ten / one in two: 1.77 / 2.23 km at 30 m/s,
  1.53 / 1.78 km at 100 m/s, 1.07 / 1.37 km at 300 m/s. Each doubling of the
  moment adds 26 %.
- For the 561 passes found at 5.5σ the strength reads 1.01 (0.91–1.46) times
  the true peak, 1.30 under 8σ; the range band holds 98.6 %; the time of
  closest approach is 1 s off (median); τ reads 1.00 (0.68–1.20).
- Dense cores: all 524 passes found, quiet and in a Dst −250 nT storm, with
  28 and 29 false alarms elsewhere in the network ([Known limits](#known-limits)).

## The map and the settings

The layer exists only on `/sim` when the server runs a fleet. Each
magnetometer is a badge beside its radar node's dot, a DivIcon in the marker
pane (`panes.ts` explains why a second interactive canvas would swallow the
map's clicks), with a colour from the map's quality scale and a shape per
state: quiet, elevated, detecting, warming up, silent. A detection's range
band is drawn as an annulus. A summary card gives the live false-alarm rate,
the passes found and the latest events; each magnetometer's panel charts ten
minutes of score, residual and field and has a flyby button.

The `mag_*` keys sit in `GET/PUT /api/simulation/config`. That router is
mounted everywhere, so without the flag the GET leaves them out and a PUT
carrying one is refused with 400. `mag_threshold_sigma` and
`mag_common_mode` belong to the server and apply at once; the fleet applies
the rest at its next poll, without a restart. The Physics Layer page
(`/sim/physics`) has a section for them with its own Apply, the running
counts and measured rate, and the model's rate beside the threshold slider.

The section joins the page's existing drift check, so one check sees every
write and poll. Its unapplied edits count as the page's, and its Apply
settles as the page's own does. The check's older behaviours were left as
they are:

- a poll that sees the page's own write before its answer shows the warning
  until the answer clears it;
- any Apply clears the warning, even while another group holds edits made
  against the moved config;
- an edit made during the page's own Apply stops counting as unapplied when
  that Apply answers;
- the scene's Apply does not refetch, so an older poll can read as a revert;
- two Applies answered out of order leave the older stamp adopted;
- across two tabs, the last write wins;
- the warning is not a live region, and Reload leaves focus on the page body;
- the warning clears only by an Apply or Reload.

## Flybys

`POST /api/sim/magnetometers/flyby` (admin) writes `mag_flyby` into the
runtime config: the magnetometer (or none, for one the fleet picks), the
pass (closest approach 0–20 km, altitude 50–15,000 m, speed 5–1,000 m/s,
lead 10–600 s, a heading or a random one), a sequence number and the time of
the request. A flyby is a command, so the route leaves `_updated_at` alone,
and the Physics page never reads it as a change of settings. The fleet checks
`mag_flyby` at every poll, flies each request once, tells new from old by the
time of the request (the number restarts with the server), and ignores a
request more than two minutes old. The snapshot does not restore it. The UAP
is an ordinary anomalous world object on a straight, level track, drawn on
the flat plane around the magnetometer so it comes exactly as close as
asked, and the radar nodes echo it too. The map's button flies 600 m to one
side, 300 m up, at 120 m/s, a minute out.

## Known limits

- Core placement, an option (spread is the default), can put magnetometers
  within 3 km of one another. Every pass is found at its own magnetometer,
  but about one pass in 22 raises a false alarm at another, 0.7–11 km away:
  a magnetometer counts as clear until it scores 3σ, and a pass is in its
  readings before that, so a far magnetometer's median of the few clear
  others can carry it. Spread placement puts magnetometers 4–118 km apart.
  The next step is a look-back exclusion, taking a magnetometer out of the
  others' medians back to before it scored 3σ, and holds that begin clean.
- Confidences hold only with readings a second apart. A slower fleet is
  still searched, but its events carry no confidence.
- Nothing reaches a real magnetometer. A real network needs a new, versioned
  node contract and the coefficient measured again on real sites.
  Localisation from several magnetometers is not attempted.
