# Simulated magnetometers beside the fleet's radar nodes

30 September 2026, revised 2 October 2026. Part C of the RM3100 magnetometer
work. Parts A and B, a node app for a real RM3100 and a register-level
simulator of the chip, live in their own repository, retina-magnetometer,
whose design note covers all three parts. This note covers what landed here
and in `libs/retina-simulation`: what each piece does and why, what the
detector measured, and where it stops.

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
Physics Layer page holds their settings and a button that flies a UAP past
one of them.

It is simulation only. Every magnetometer route exists only under
`SYNTHETIC_FLEET_ENABLED`. None of the magnetometers' data reaches the radar
pipeline, `/v1/nodes` and its generated contract, the aircraft WebSocket, or
the ground-truth and anomaly stores that radar scoring reads.

## What the requirements ask, and where each is met

| Requirement | Where it is met |
| --- | --- |
| Magnetometers in the simulated world, always beside a radar node | `retina_simulation/magnetometer.py` puts at most one on each receive site, named for the radar node there (`mag-<node id>`), by `spread`, `core` or seeded `random` placement |
| Readings from the world's objects, the Earth's field and sensor noise | Every world step, each magnetometer reads WMM2025, its crust, the daily variation, an optional storm and every anomalous object as a 1e9 A·m² dipole, with the RM3100's datasheet noise, quantised to its counts. Aircraft and drones contribute nothing, as the magnetic model allows |
| A detection method whose events carry at least time, strength and confidence | `backend/services/sim_magnetometer.py` ([The detector](#the-detector)). Each event carries its time of closest approach (`peak_ms`), strength (`strength_nt`) and confidence, with its score, time scale, range band and the truth behind it |
| The false-alarm rate, measured and reported | Live: every event is scored against the simulator's truth, and the scorecard (`stats` in `GET /api/sim/magnetometers`, and the map's summary card) gives false alarms per node-hour searched with a 95 % interval. Offline: `scripts/magnetometer_false_alarms.py` ([What it measured](#what-it-measured)) |
| Results sent to the server | `POST /api/sim/magnetometer/push`, once a second, with the simulator's key ([Where the data goes](#where-the-data-goes-and-why-there)) |
| The `/sim` map, with detection state and recent readings | A badge per magnetometer, drawn by state; the range band of a detection; a summary card; a panel with ten minutes of score, residual and measured field ([The map](#the-map)) |
| Runtime settings for count, placement and threshold, in the existing style | `mag_*` keys in `GET/PUT /api/simulation/config`, a section of the Physics Layer page, restored by the state snapshot ([Settings](#settings)) |
| Simulation only, behind `SYNTHETIC_FLEET_ENABLED` | The push, the two reads and the flyby route are mounted only under the flag. The config route is mounted everywhere, and without the flag it neither shows nor accepts a `mag_*` key |
| The radar pipeline and `/v1/nodes` unchanged | The readings take their own push and their own module. Nothing on the radar path reads them, and the contract is unchanged. A flyby's UAP is an ordinary anomalous world object, which the radar nodes see like any other |

## Where the data goes, and why there

**Its own push, not TCP 3012.** The server treats every node that connects
on 3012 as a radar node: association, analytics, the node list, `/v1/nodes`.
A magnetometer registered there would have to be filtered out of each of
those, in code that has no reason to know about magnetometers. Instead the
orchestrator posts the readings to `POST /api/sim/magnetometer/push` with the
simulator's key, the way it already pushes ground truth and ADS-B. The push
lists every current magnetometer even when it has no new samples, so the
server learns when the simulator removes one.

Everything in a push is checked before any of it is applied. A push the fleet
could not have sent is refused whole with 400, naming the field, and counted;
the fleet drops a refused push rather than send it again. The bounds are what
the fleet sends, with room to spare: at most 100 magnetometers and 60
readings each; a push clock (`ts_ms`) within five minutes of the server's; no
reading stamped more than 5 s after the push or more than an hour before it;
readings within ±1e6 nT. A well-formed entry the server will not publish is
skipped and counted: a host that is not a synthetic radar node, an id that
does not start with `mag-`, or a position off the globe. Both counts are in
the snapshot's `detector` block. Detection runs off the event loop, at about
0.1 ms of CPU per magnetometer-second.

**Admin-only polling, not the WebSocket.** The aircraft socket is
unauthenticated and broadcasts on aircraft changes, and magnetometer data is
simulation-only. The map polls `GET /api/sim/magnetometers` (admin) every 2 s
while the layer is on, and one magnetometer's detail
(`GET /api/sim/magnetometers/{node_id}`) while its panel is open.

**Positions through `public_latlon`.** A magnetometer sits on a radar node's
roof. The snapshot therefore publishes its position through the same rule as
radar nodes, so it can never reveal a site the radar node itself does not.

## Settings

**In the existing runtime config.** The `mag_*` keys sit beside the other
simulation keys in `GET/PUT /api/simulation/config`, as the requirements ask
for settings in the style of the existing ones. That router is mounted
everywhere, so the keys are gated by hand:

- the GET shows them, defaults filled in, only under the flag, and leaves
  them out without it, even if an old snapshot carried some;
- a PUT carrying one without the flag is refused with 400;
- they are validated key by key: a count of 0–60, a threshold of 3–12σ, one
  of the five cycle counts;
- the snapshot restores them, like the other simulation keys.

Two of them, `mag_threshold_sigma` and `mag_common_mode`, are the server's
own and take effect at once; the fleet receives them with the rest of the
config and ignores them. The rest are applied in-process at the fleet's next
poll after the config's stamp moves (it polls every 5 s). The magnetometers
hold no connection, so, unlike the scene keys, nothing in the fleet restarts.
A new count or placement re-places them at once, and a magnetometer at a new
site starts from nothing: it reads warming up for about three minutes, two
for its static level and one for its noise. On the server, a new cycle
count, or the common mode switched in or out, starts every magnetometer's
noise estimate again, and they read warming up for a minute to a minute and a
half.

**On the Physics Layer page.** The settings are a section of the page
(`/sim/physics`), with its own Apply, which carries only the `mag_*` keys.
The section shows what is running (how many magnetometers, how many
detecting, the measured false-alarm rate), and beside the threshold slider
the false-alarm rate the model predicts for the threshold being set, where
the model holds, or what keeps it from holding. After an Apply it says which
magnetometers will read warming up again, and for how long.

The section joins the page's own drift check rather than keep one of its
own. Its unapplied edits count there as the page's do: when the config moves
under them they are kept and the page warns, and when nothing on the page is
unapplied the section takes what the simulator runs with the rest. Its Apply
is settled as the page's own: the stamp its write produced is adopted, the
warning cleared and the config fetched again, which drops a poll still on its
way from before the write; page drafts that hold no edits take the config the
write left running. An edit made while the Apply is on its way stays
unapplied. Reload discards the section's edits too, and leaves the flyby form
as it was.

The drift check itself is the page's own, older than the magnetometers, and
some of its behaviours predate them. They were left as they are, and are
listed here for whoever maintains the page:

- a poll that sees the page's own write before the write's answer arrives
  shows the warning until that answer clears it;
- any Apply clears the warning, even while another group still holds edits
  made against the config that moved;
- an edit made while the page's own Apply is on its way stops counting as
  unapplied when that Apply answers;
- the scene's Apply does not fetch the config again, so a poll from before
  its write can answer afterwards and read as a revert to boot state;
- two Applies answered out of order leave the older stamp adopted;
- two tabs writing the same keys: the last write wins;
- the warning is not a live region, and Reload, which takes its own button
  away with the warning, leaves the keyboard focus on the page's body;
- the stale warning clears only by an Apply or Reload.

## Flybys

A demo needs a UAP on demand. `POST /api/sim/magnetometers/flyby` (admin)
writes `mag_flyby` into the runtime config: the magnetometer, or none for one
the fleet picks; the pass (closest approach 0–20 km, altitude 50–15,000 m,
speed 5–1,000 m/s, lead 10–600 s, and a heading or none for a random one); a
sequence number; and the time of the request. It answers `{ok, flyby}`.

It leaves `_updated_at` alone. A flyby is a command, not a setting, and a
moved stamp would read on the Physics page as somebody else's change of
settings. So the fleet looks for `mag_flyby` at every poll, not only when the
stamp moves, and flies each request once, however many polls serve it.

- **New or old, by time.** The fleet tells a new request from one it has
  flown by the time it was made, not its number. The number is not
  persisted, and a restarted server counts from one again: a running fleet
  going by number would take every request after that for an old one.
- **Stale requests.** It ignores a request more than two minutes old when it
  first sees it. That age is all that stops a restarted fleet, which
  remembers nothing, from flying the last request again: one whose first poll
  comes within two minutes of the request (a scene change right after the
  click) flies it again in its new world, where the first pass no longer
  exists.
- **The pass.** An ordinary anomalous world object on a straight, level
  track with no transponder. The line is drawn on the flat plane around the
  magnetometer, the plane it measures distance in, so the pass comes exactly
  as close as asked, at exactly the altitude asked for above the ground there,
  `lead_s` after the poll that picks it up. The radar nodes echo it, and the
  ground-truth push carries it. It retires once it is as far past the
  magnetometer as it started before it.
- **Not restored.** `mag_flyby` is left out of the snapshot's restore keys: a
  request that survived a restart would fly a UAP nobody had just asked for.

The map's button flies the default pass: 600 m to one side, 300 m up, at
120 m/s, a minute out.

## The detector

`services/sim_magnetometer.py`, once per second of readings, over every
magnetometer at once. Each step has its reason.

1. **Static level: a trimmed mean** (the middle half) of each magnetometer's
   last 30 minutes, first set from its first 120 readings and refreshed every
   30 s, on the same second at every node, so what the refresh itself moves is
   common to the network. The first version used a median. The readings are
   quantised at 13.3 nT a count at 200 cycles, so a median sits on a count and
   moves a whole count at a time, and those 13 nT steps were exactly what the
   long windows detect. A magnetometer the simulator places somewhere else,
   under the same id, starts again from nothing.
2. **Noise, from the magnetometer's own residual:** the standard deviation of
   its first differences over the last 10 minutes, outliers clipped, divided
   by √2. First differences ignore slow drift. A standard deviation, not a
   MAD: a MAD of quantised differences lands on a count, and it
   underestimated the noise by enough that the χ² tail, where the threshold
   lives, came out orders of magnitude too heavy. The clip is set by a robust
   spread, but never one narrower than the sensor's own noise puts into a
   difference: at 50 cycles a count is 50 nT against 30 nT of noise, and
   without the common mode most differences are exactly zero, so a clip at
   their MAD kept only the zeros and called the noise nil. The estimate is
   floored at 0.3 times the datasheet figure.
   - **Restarts.** The estimate starts again from nothing whenever the
     residual's noise changes: a new cycle count, or the common mode switched
     in or out, which changes a residual's noise by about a fifth. Scored on
     the old estimate, a switch from 200 to 50 cycles raised 23–30 false
     alarms across eight magnetometers. A magnetometer scores nothing until it
     has a minute of the new residual.
   - **A young estimate.** An estimate from fewer than ten minutes of
     readings, where every restart begins, is less certain. Over n readings
     the statistic is 9·F(9, 2(n − 1)), not χ²₉: first differences on three
     axes, clipped, carry 2(n − 1) degrees of freedom, as measured within 2 %
     from 60 to 600 readings. On 60 readings, noise alone crosses what χ²₉
     calls 3.5σ 2.6 times as often as on 600, and 5.5σ 23 times as often. So
     every statistic is mapped to the one with the same tail probability over
     600 readings before it is scored, and the false-alarm rate holds from
     the first scored minute. The map is carried in logarithms, so it stays
     finite and increasing however strong the statistic. It serves the score
     only: an event's peak follows the statistic itself.
3. **Common mode: the median of the others that cannot be carrying a pass.**
   The daily variation (30–90 nT peak to peak in its largest component) and a
   storm (about 105 nT at the Dst minimum, up to about 113 nT with the
   pulsations) are the same across the fleet to within
   a few nT, so each magnetometer has the per-axis median of other
   magnetometers' deviations subtracted from it. The median, not the mean, so
   that a UAP near one does not leak into the others. Others only: the first
   version included the magnetometer in its own median. Whenever it was the
   middle value its residual collapsed to zero, which tied the residual to its
   own noise and fattened the tails.
   - **Which others.** A UAP is local: its field falls as 1/r³, from
     100–200 nT at 1 km to 4–7 nT at 3 km. So a magnetometer with an event
     open or scoring 3σ is left out of the others' medians, and so is every
     magnetometer within 3 km of one: a pass that lifts a magnetometer that
     high comes within about 2 km of it, and can be tens of nT at a neighbour
     3 km off that does not score yet. Over 240 passes across a dense cluster
     (three to six magnetometers within 1.4 km of each other, two to four more
     20 km off, half the passes in a storm), the far magnetometers raised 126
     false alarms with only the alarming ones left out, 67 with the 3σ ones
     too, and none with their 3 km neighbours as well, whether the line was
     drawn at 2σ, 3σ or 4σ and the passes flew at 30, 60 or 120 m/s. Across
     1,730 generated fleets (ten metros, ring, dual and scatter layouts, 25 or
     50 sites, 6 to 12 magnetometers), spread placement put the closest two
     4.0–118 km apart, so there the radius never reaches a second one; core
     placement put them 0.04–23 km apart, with a pair within 3 km in more than
     half the fleets. Noise alone scores 3σ about one second in a hundred at
     each magnetometer: eight spread magnetometers take each median from all
     seven others 92 % of the time, from six 8 %, and never from fewer than
     five.
   - **When no one is clear.** A score is weak evidence, so a magnetometer
     clear of every event that finds no one clear sets scores aside first:
     one far off still sees what a storm does, where holding (below) would
     not. A magnetometer at or beside an event takes clear magnetometers only,
     and holds when there are none: those scoring high near it are the same
     pass on its way, and their median took it whole. Over 1,048 passes over
     the cores of generated fleets (six magnetometers each, half the passes in
     a storm), letting those magnetometers set scores aside as the others do
     raised 70 false alarms, and clear magnetometers only, 57; 3,092 passes
     were found of 3,412 the one way, 3,060 of 3,408 the other. Over 12 passes
     across 2 km rings of eight, the same change took the false alarms from
     14 to 4, and the limit on a hold (below) took the rest.
   - **Few others.** However few the others, the median follows them, and each
     window is scored against the noise that median adds: the variance of the
     median of k unit normals, all of a magnetometer's own noise for one
     other, half for two, a fifth for seven. Over a window that is the largest
     eigenvalue of Σ fₜ qₜqₜᵀ, with fₜ each reading's variance and qₜ the
     detector's functions at it. That keeps the score within χ² whatever the
     mix, without deflating windows that a noisier second barely touches.
     Dividing by the window's noisiest reading instead, over 73 node-hours of
     noise in a dense core, gave 55 false alarms at 3.5σ where the model then
     expected 101; the eigenvalue gave 93.
   - **No one left.** A magnetometer then holds its own recent common mode,
     smoothed over about four readings. A held common mode is a constant to
     the windows, but where a hold begins and where it ends the residual can
     step by whatever the held value missed meanwhile. So where a hold ends,
     and where one clear of every event begins one, the magnetometer's windows
     begin again; one at or beside an event keeps its windows as it begins to
     hold, since they are watching the pass and its common mode came from
     clear magnetometers until then. A lone magnetometer 20 km from a cluster
     (five to seven magnetometers on a 0.7 km ring, half the passes in a
     storm) had alarmed in 57 of 60 passes on the step at either end; with its
     windows begun again, in none. A hold lasts three minutes at most. Then
     the magnetometer has no common mode it can trust: it is not scored, and
     any event of its own closes, until it takes a median of others again. A
     held common mode misses whatever the network has done since, which in a
     storm grows by the minute. On a 2 km ring of eight, where a pass across
     it keeps every magnetometer at or beside an event, and so holding, for
     minutes, six passes in a storm's main phase raised four false alarms (at
     τ = 32 and 64 s) with no limit, and none with it.
   - **Six or more.** The common mode is subtracted only while six or more
     magnetometers with a static level report; with fewer it is left in, and
     the map says so. A median of a few is not robust while nothing yet shows
     a pass, and a pass is felt before it alarms: on its leading edge a strong
     pass is already tens of nT at a magnetometer that does not yet score
     high. Two magnetometers on one pass, which is what core placement is for,
     need five others, so six reporting. With five, the far ones take half the
     weaker one's field until both alarm, and the step when it stops is
     itself a detection; with four they take all of it; with three, any pass
     reaches the other two at half strength, since a median of two is their
     mean.
   - **What was tried before.** The second version left a magnetometer out at
     2σ, which noise reaches one second in eight, and held a magnetometer's
     common mode whenever fewer than three others were left. In a storm at six
     or seven magnetometers the holds let the storm in, scores rose, more
     magnetometers held, and the network locked: 37 false alarms in 572
     node-hours at six, 14 in 334 at seven.
4. **Matched filter, six scales.** On every axis, a dipole passing on a
   straight line produces a combination of the three Anderson functions
   uⁿ/(1+u²)^(5/2), n = 0, 1, 2, with u = (t − t₀)/τ, t₀ the time of closest
   approach and τ the slant range there divided by the speed (Anderson 1949;
   Sheinker et al. 2009). At τ = 2, 4, 8, 16, 32 and 64 s, the last ±4τ of
   residual is projected onto that span, orthogonalised against a constant
   and a slope, whatever the common mode left of slow drift. Energy over
   variance is χ² with 9 degrees of freedom under noise alone (three
   functions on three axes), and its tail probability becomes a one-sided
   Gaussian score, clipped at 40σ. Every scale's statistic has the same
   distribution under noise, so the best score is the largest statistic.
   - **Unbroken windows.** A window must lie within one unbroken stretch of
     readings. Readings more than 5 s apart leave a hole, and so do a restart
     of the noise estimate, the fleet's clock stepping back, and the ends of a
     hold; no window at any scale spans one. The first version skipped only
     windows over 1.5 times their nominal span, which left the 32 and 64 s
     scales scoring across a two-minute hole, and turned the detector off once
     ticks slowed past 1.5 s. Windows count readings, so a fleet running slow
     stretches each scale a little, and τ is published in seconds, at the
     readings' own spacing.
5. **Events.** An event opens when the best score reaches the threshold. It
   then works out three things.
   - **Where its peak is.** While the event is open, the peak (t₀, strength,
     τ, score) follows the unclipped χ² statistic, not the score. The score
     stops at 40σ, and a strong pass reaches that in its first window: a short
     scale, catching only the leading edge, whose fit overstated one flyby's
     field 2.4-fold. The statistic keeps growing until the window best matched
     to the pass is centred on its closest approach.
   - **When it is over.** It closes once its peak's scale, and every shorter
     one, has stayed under the threshold minus one for five readings, and the
     peak's own window has passed. The longer scales are left out of that
     test. They are mismatched to the pass but still hold it, and for a strong
     pass they stay far above threshold for as long as their windows last: the
     first version kept a close flyby "detecting" for eight minutes. An event
     also closes when its magnetometer can no longer be followed: its noise
     estimate starts again, it has no common mode it can trust, it is
     re-placed or taken away, or the fleet's clock steps back.
   - **What may follow it.** After it closes, no window that overlaps it may
     open another. That window would be looking at the same pass.
6. **Truth and the scorecard.** The simulator sends the truth beside each
   reading: the UAP field's magnitude at the magnetometer, the nearest UAP and
   its slant range. It never feeds detection.
   - **The label.** An event is true if the UAP's own field could have raised
     the statistic that fired: over the event's peak window, with a constant
     and a slope removed as the detector removes them, the truth field must
     carry at least one noise variance of energy. Noise alone puts nine there
     on average, and a threshold needs 32 (3.5σ) to 54 (5.5σ); a UAP adding
     one makes a crossing in that window three (3.5σ) to eight (5.5σ) times
     likelier than noise alone. In seeded rigs, all 41 noise alarms raised
     while a UAP hovered 1.5 km away (up to 54 nT, but steady) or crept past
     4 km away came to nothing, and of 54 events peaking within 4τ of a
     pass's closest approach, 51 came to 1.4 or more and three weak ones at
     3.5σ to 0.3–0.5. The truth is a magnitude, not a vector, which puts these
     figures about a quarter low. The first rule, any UAP putting 1 nT on the
     magnetometer while the event was open, counted noise alarms near a
     distant or loitering UAP as detections. The label is recomputed every
     second while the event is open, because the UAP may still be closing in.
   - **Passes.** A pass is counted when the UAP field at a magnetometer rises
     20 nT above the lowest it has been since the last pass (or since the
     magnetometer could score), and stays open until 256 s after its field
     last reached a new peak: the detector reports up to 4τ after closest
     approach, 256 s at the longest scale. It is found if an event of the same
     scorecard, labelled true, is or was open during it. A pass is the field's
     rise at one magnetometer, whichever UAPs make it, while each event is a
     detection of its own, so true detections may outnumber the passes found.
   - **Node-hours searched.** False alarms are counted per node-hour
     searched: the time between readings, at most 5 s, while the magnetometer
     could score, weighted by how much of the six-scale search is running.
     After a start, a restart or a hole the windows refill shortest first, and
     with only the shortest one to five scales noise raises 47, 73, 84, 93 and
     96 % of the false alarms all six do (381 node-hours at 3.5σ for each).
     So a second searched with fewer scales counts as that share of one, and
     the rate does not read low after every restart. Rates are published to
     three significant figures, with an exact (Garwood) 95 % interval.
   - **One configuration.** The scorecard describes one configuration, and
     starts again when the threshold, the common mode actually subtracted,
     the sensor setting or the storm changes. An event or a pass under way
     when it starts again belongs to the scorecard before.

**Each event carries:**

- `peak_ms`, the time of closest approach;
- `strength_nt`, the strength: the fitted signal's peak magnitude, in nT,
  measured at the pass's own τ;
- `score_sigma`, the score;
- `tau_s`, the pass's own time scale τ, its slant range at closest approach
  over its speed, in seconds (below);
- `confidence`, the probability that noise alone would not produce an event
  at least this strong at this magnetometer within an hour;
- `noise_once_per_h`, how many node-hours noise alone takes to do as much:
  the same number as the confidence, easier to read;
- `range_km`, a range band (below);
- `calibrated`, whether the model behind the confidence held when the event
  opened: the common mode subtracted, no storm, and readings a second apart
  (within 10 %, and once out, back within 5 %, so a spacing near the edge
  does not flicker);
- `truth`, its label, whether the label is still provisional, the strongest
  UAP field on the magnetometer while the event was open, and, for a true
  event, the UAP and its slant range.

The confidence comes from the false-alarm model
([What it measured](#what-it-measured)): exp(−rate), where the rate is how
often noise alone reaches the event's score at one magnetometer in an hour.
An event opened outside the conditions the model was fitted in is marked
uncalibrated, and the map gives it no confidence.

**τ and the strength** are measured on the peak's window at the pass's own
time scale, not at the scale that found it: 17 values of τ in eighth-octave
steps, from an octave and a half below the peak's scale to half an octave
above, the one that keeps the most of the window's energy moved by a
parabola through it and its neighbours. Detection stays on the six scales.
The first version fitted the strength at the peak's scale, one of the six,
and published that scale as τ, so a pass whose τ fell between two scales
read its strength low: 0.85 times the true peak on the map's default flyby
(600 m off and 300 m up at 120 m/s), where it now reads 0.999 (0.943–1.037
for nine in ten).

**The range band** is where the configured dipole moment would put that
strength on the magnetometer. A strength read exactly puts the UAP between
the distance at which the moment gives that field on its equator and 2^(1/3)
times that, on its axis. Each end of the band then moves by how far off a
strength read at that score may be: a constant plus a term in 1/(score − 2σ)
(`BAND_NEAR = (-0.056, -0.56)`, `BAND_FAR = (0.627, 2.53)`). The strength is
a least-squares fit, and near the threshold it takes in the noise that helped
the statistic over the line, so a weak detection reads its strength high: of
the passes found at 5.5σ, those under 8σ read a median 1.30 times their true
peak field, and those over 15σ 1.00. The benchmark fits both ends to the
2,381 passes it found at 3.5, 5, 5.5 and 6σ, so that every score from the
lowest threshold up is represented: the narrowest band that keeps 98 % of
every score bin's passes inside each end (98 % being the least at which a
band fitted on half the seeds held nine passes in ten of the other half in
every bin), its far end then raised by 0.005 so that it reaches the axis at
every score, as far out as an exactly read strength can put the UAP. It holds
the true slant range for 99.3, 98.8, 98.6 and 98.1 % of the passes found at
3.5, 5, 5.5 and 6σ, and for all 40 found just above 5.5σ; far over near is
1.29 for a strong detection, 1.69 at 5.5σ and 2.50 at 3.5σ. The first band
allowed a fixed 15 % either way at every score, and at the edge of detection
it put the UAP nearer than it was: it held 65 % of the passes found just
above 5.5σ. The band is a distance, not a position: one magnetometer cannot
say which way the pass went.

### Turned down

- **A threshold on |B| or on each axis's deviation.** The daily variation and
  a storm are several times the 15 nT noise.
- **A high-pass filter per node.** Storm pulsations (45–600 s) share the time
  scales of a pass.
- **Detection in the simulator.** It would be grading itself.
- **A single scale.** A matched filter is matched to one τ.
- **A learned classifier.** Its false-alarm rate could not be stated in
  advance.
- **A drift check of the settings section's own.** Two checks on one config,
  each with its own idea of the latest stamp, have to agree about every write
  and every poll. The section joins the page's check instead, so there is
  one.

## What it measured

`scripts/magnetometer_false_alarms.py` runs the simulator's readings through
`ingest` exactly as the route does, each push stamped with its simulated
time, in parallel. Its networks are magnetometers on a jittered grid about
20 km apart around Greenville, SC, at 200 cycles, with the common mode
subtracted: eight, except where other sizes are named. Every run is seeded,
and the work is cut into the same jobs whatever the number of processes, so a
rerun of the same code gives the same numbers, and every threshold runs over
the same simulated days. The numbers here come from one run at the script's
defaults, about an hour and three quarters on eight processes. Rerun it after changing
anything in the detector, and carry what it fits over to the code.

**False alarms with nothing to find.** No UAP anywhere: WMM2025, crust, the
daily variation and datasheet noise, so every event is a false alarm.
Node-hours are node-hours searched, as the live scorecard counts them. The
default threshold and the one below it get more node-hours than the rest,
because false alarms there are rare.

| Threshold | Node-hours | False alarms | Per node-hour | 95 % interval (Garwood) | Model |
| ---: | ---: | ---: | ---: | --- | ---: |
| 3.0σ | 3,065 | 17,455 | 5.70 | 5.61–5.78 | 5.71 |
| 3.5σ | 3,065 | 4,163 | 1.36 | 1.32–1.40 | 1.34 |
| 4.0σ | 3,065 | 716 | 0.234 | 0.217–0.251 | 0.238 |
| 4.5σ | 3,065 | 107 | 0.035 | 0.029–0.042 | 0.032 |
| 5.0σ | 9,194 | 25 | 0.0027 | 0.0018–0.0040 | 0.0034 |
| **5.5σ** | **9,194** | **1** | **0.00011** | **0.0000028–0.00061** | **0.00027** |
| 6.0σ | 3,065 | 0 | 0 | 0–0.0012 | 0.000017 |

**The model** is `false_alarm_rate(z)`: A · z² · P(Z > z) per node-hour, with
`FALSE_ALARM_COEFFICIENT` A = 470. It is where the confidence and
`noise_once_per_h` come from, and it is what the Physics page shows beside the
measured rate while the threshold slider moves.

- **Why z².** The detector searches over time and over time scale. For a
  search over two parameters, the rate of distinct excursions falls as
  z·φ(z) ≈ z²·P(Z > z), not as the tail probability alone (Siegmund &
  Worsley 1995, *Ann. Statist.* 23; Worsley 2001, *Adv. Appl. Prob.* 33, for
  χ² fields).
- **How A was fitted.** By Poisson maximum likelihood over all the thresholds
  at once. The thresholds share their simulated days, so their counts are not
  independent, and A's interval comes from drawing whole seed-days again.
  The model's expected counts (17,499, 4,105, 730, 99.1, 31.0, 2.48, 0.05)
  lie inside the measured interval at every threshold, A is 463–477 over
  seed-days drawn again, and a free exponent fits as 2.03 (1.87–2.20).
- **What it replaced.** The first model, a fixed number of independent looks
  per hour, falls off too fast: fitted to the same counts, it gives 0.93 of
  the measured rate at 3σ, then too little by 1.3, 1.6, 2.3 and 2.1 times at
  3.5, 4, 4.5 and 5σ.

**The default, 5.5σ,** is about one false alarm every 19 days across eight
magnetometers on the model, 2.7 × 10⁻⁴ per node-hour (measured: 1 in 9,194
node-hours), and an event at the threshold carries a confidence of 0.9997.
The next step down, 5σ, would be about one every 1.5 days, also on the
model (measured: 25 in 9,194 node-hours).
What that buys in reach is under **Reach**, below: the field falls as 1/r³,
so a threshold lower by half a sigma reaches only a little further out.

**Other network sizes.** The model is fitted at eight magnetometers. With six
or seven each median is of fewer others, and noisier, which the score allows
for (step 3); with twelve, of more. At 3.5σ, where alarms are many enough to
compare:

| Magnetometers | Node-hours | False alarms | Per node-hour | 95 % interval | Model expects |
| ---: | ---: | ---: | ---: | --- | ---: |
| 6 | 1,006 | 1,402 | 1.39 | 1.32–1.47 | 1,347 |
| 7 | 1,006 | 1,390 | 1.38 | 1.31–1.46 | 1,347 |
| 12 | 1,149 | 1,569 | 1.37 | 1.30–1.43 | 1,539 |

Over the same simulated days, six alarm 2.1 % more than eight, seven 1.3 %
more, twelve 0.4 % less.

**No daily cycle.** Sixteen seeded runs of the same two days, 30 September
and 1 October 2026, on seeds of their own (none shared with the runs above),
at 3.5σ: 6,137 node-hours and 8,367 false alarms. The alarms are binned by local
solar time at the network's centre, the clock the simulated daily variation
keeps, and tested against the node-hours in each bin by three tests fixed
before any run: χ² over the 24 hours, the first four harmonics of the day,
and daytime (06–18 local solar time) against night. Alarms can cluster in
time, which the textbook distributions of those statistics do not allow for,
so each p also comes from turning every run's clock by a random amount, which
keeps any clustering and breaks only the tie to the time of day. χ² = 28.6
on 23 degrees of freedom (p = 0.19; 0.31 with the clocks turned); the
harmonics, 11.4 on 8 (p = 0.18; 0.28); daytime against night, 4,157 against
4,210 alarms (p = 0.49; 0.53). The common mode removes the daily variation at
every hour.

**A storm through its whole course.** Dst −150 nT with pulsations of
45–600 s, at 5.5σ: the sudden commencement, the main phase to the Dst minimum
six hours in (about −142 nT), and 30 hours of recovery, each phase counted on
its own, with the common mode subtracted and left in, at eight magnetometers
and at six and seven, the fewest the common mode is subtracted with. Eight
storms at each size:

| Magnetometers | Common mode | Node-hours | False alarms | Per node-hour | 95 % interval |
| ---: | --- | ---: | ---: | ---: | --- |
| 8 | removed | 2,322 | 0 | 0 | 0–0.0016 |
| 8 | not removed | 2,322 | 2,426 | 1.04 | 1.00–1.09 |
| 7 | removed | 2,031 | 0 | 0 | 0–0.0018 |
| 7 | not removed | 2,031 | 2,139 | 1.05 | 1.01–1.10 |
| 6 | removed | 1,741 | 0 | 0 | 0–0.0021 |
| 6 | not removed | 1,741 | 1,833 | 1.05 | 1.01–1.10 |

With the common mode left in, most of the false alarms come in the main
phase and the first twelve hours of recovery: 2,368 of the 2,426 at eight
magnetometers, and one in the eighteen hours after. With it removed there
are none, in any phase, at any size. This is why detection runs over the
network. The settings keep the switch, so the
difference can be shown live.

**Detection probability.** A single 1e9 A·m² pass 300 m above the
magnetometer, on a random heading with a random dipole direction, 60 passes
per cell, the same passes at every threshold. A pass is found if its
magnetometer has an event the truth labels true. At 5.5σ:

| Slant range at closest approach | 30 m/s | 100 m/s | 300 m/s |
| ---: | ---: | ---: | ---: |
| 0.5 km | 60/60 | 60/60 | 60/60 |
| 1.0 km | 60/60 | 60/60 | 60/60 |
| 1.5 km | 60/60 | 57/60 | 19/60 |
| 2.0 km | 49/60 | 9/60 | 0/60 |
| 2.5 km | 7/60 | 0/60 | 0/60 |
| 3.0 km | 0/60 | 0/60 | 0/60 |
| 3.5 km | 0/60 | 0/60 | 0/60 |

**Reach.** The slant range out to which nine passes in ten are found, and one
in two, in km:

| Threshold | 30 m/s | 100 m/s | 300 m/s |
| ---: | --- | --- | --- |
| 5.0σ | 1.88 / 2.26 | 1.54 / 1.80 | 1.10 / 1.50 |
| **5.5σ** | **1.77 / 2.23** | **1.53 / 1.78** | **1.07 / 1.37** |
| 6.0σ | 1.68 / 2.16 | 1.51 / 1.74 | 1.07 / 1.34 |

A magnetometer at datasheet noise is a tripwire with a reach of about
1.5 km, about 1.8 km for slow passes and 1.1 km for fast ones: a slow pass
stays in view longer, and the matched filter adds up that time. Each doubling of the moment adds only
26 % to the reach. Eight magnetometers each watch a circle about 3 km across,
about 57 km² between them; the radars watch tens of kilometres in every
direction.

**How well a detection is measured.** For the passes found at 5.5σ:

| Score at the peak | Passes | Strength ÷ true peak, median (5–95 %) | Band holds the true range |
| --- | ---: | --- | ---: |
| under 8σ | 93 | 1.30 (0.90–1.89) | 100 % |
| 8–15σ | 99 | 1.03 (0.85–1.35) | 96 % |
| 15σ and over | 369 | 1.00 (0.95–1.09) | 99 % |

All 561 together read 1.01 (0.91–1.46), and the band holds 98.6 % of them.
The time of closest approach is 1 s from the truth (median; 15 s at the 95th
percentile). The τ an event publishes is the pass's own, its slant range at
closest approach over its speed, refined between the six search scales: it
reads 1.00 times the truth (median; 0.68–1.20 for nine in ten), where the
peak's scale, which the first version published, read 1.2 (0.53–1.92). The
fixed 15 % band the score-dependent one replaced held 92 % of the same passes
on the strengths read then, and 65 % of those found just above the threshold.

**Dense cores.** Core placement can put two magnetometers within 3 km of each
other, where one pass is felt at both and the rules for a magnetometer at or
beside an event come in. Generated fleets in six metros, ten fleets each (57
of the 60 put two magnetometers that close), with six magnetometers by core
placement, and two passes at 120 m/s over each of the 262 magnetometers with
a neighbour that close, quiet and in a storm stronger than the benchmark's
own (Dst −250 nT, pulsations of 10 nT, three and a half hours into its main
phase):

| | Passes | Found | False alarms anywhere in the network |
| --- | ---: | ---: | ---: |
| Quiet | 524 | 524 | 28, in 23 passes |
| In the storm | 524 | 524 | 29, in 24 passes |

None of those false alarms is at the pass's own magnetometer. Why they
happen is under [Known limits](#known-limits-and-what-is-not-done).

## The map

- **Badges, not node markers.** DivIcons in the marker pane, class
  `mag-marker`. `panes.ts` explains why a second interactive canvas would
  swallow the map's clicks, and the E2E suite counts `.node-marker`. A badge
  sits up and to the right of its radar node's own dot, at the map's own
  position for that site.
- **The map's quality scale, with a shape per state.** Quiet is a GOOD
  square; elevated, a score within 1.5σ of the threshold, a WARN diamond;
  detecting an ANOMALY square that pulses (a still halo where nothing moves:
  the legend, the panel, reduced motion); warming up an INK_SUBTLE square;
  silent, no reading for 10 s, a hollow INK_SUBTLE square with a broken edge.
  Quiet first wore the node colour, which sat CIEDE2000 5.1 from WARN on the
  dark map; on this scale every pair of states is at least 24.8 apart in
  light and 37.7 in dark, and the shapes tell them apart for anyone who
  cannot tell the colours. All come from `usePalette`, and the charts from
  `useChartTheme`, so both themes work and the colour-token tests hold. The
  panel writes the state in the console's text tokens beside the badge.
- **A range band** while a detection is open, and fainter for a minute after
  it closes. It is an annulus, drawn as a polygon with a hole.
- **A summary card**, which collapses to its header:
  - how many magnetometers are placed, and how many are detecting;
  - the live false-alarm rate per node-hour searched, with its interval;
  - how many passes of 20 nT or more were found, with how a pass is counted
    in a disclosure;
  - the threshold, the sensor and the moment, and, when the noise model does
    not hold, why, and that detections opening meanwhile carry no
    confidence;
  - only when the server has turned something away from the fleet, how many
    pushes it refused (their readings lost) and entries it skipped;
  - the latest events, each opening its magnetometer while it is still
    placed: a dot filled red while a detection is live, a red ring for a past
    UAP, a neutral ring for anything else.
- **A panel per magnetometer**:
  - its state, score, best time scale, |B| and its components, residual and
    noise;
  - the time scales it searches: the slow ones need minutes of unbroken
    readings after a start, a re-placement or a hole;
  - ten minutes of score against the threshold, of residual field and of the
    field as measured (|B|, with north, east and down in its tooltip), on one
    time axis ending at the last reading, broken where the readings stopped.
    A magnetometer that has stopped reporting is charted up to now by the
    fleet's clock, which its readings and events keep;
  - the current event, every field of it, with its truth, and the earlier
    ones;
  - a button that flies a UAP past it, so a detection can be watched from
    start to finish without leaving the map.
- **A toast** when a detection starts; more than three starting together
  share one, and screen readers announce each. Events already open when the
  page loads, or when the layer is turned back on, are not announced, and a
  server restart starts the record afresh.

The layer and its toggle exist only on `/sim`, and only when the server runs a
fleet. A magnetometer and an aircraft share the side panel: opening one closes
the other.

## Known limits, and what is not done

- **Dense cores.** Core placement, an option (spread is the default), puts
  magnetometers close enough for one pass to reach several, which is where
  the common mode is hardest to keep clean. In generated fleets with
  magnetometers within 3 km of one another, every pass is found at its own
  magnetometer, but about one pass in 22 raises a false alarm at another,
  0.7–11 km from the pass's own: 57 false alarms in 1,048 passes, quiet as
  often as in a storm, and none at the pass's own magnetometer. A
  magnetometer counts as clear until it scores 3σ, but a pass is already in
  its readings before that, so a far magnetometer's median of the few clear
  others left can carry the pass, and a hold can then freeze it. Taking
  clear magnetometers only for one at or beside an event also finds about
  one pass in a hundred fewer there (3,060 of 3,408, against 3,092 of
  3,412). Spread placement, the default, puts magnetometers 4–118 km apart,
  so no two are that close; on the benchmark's grid, about 20 km apart, the
  1,260 detection passes raised no false alarm at another magnetometer, and
  the storms at six, seven and eight magnetometers none at all with the
  common mode removed. The next step is to take a magnetometer's readings
  out of the others' medians back to before it scored 3σ (a look-back
  exclusion), and to begin holds clean.
- **A reading a second.** The false-alarm model, and so every confidence,
  holds only with readings a second apart. A fleet running slower is still
  searched, its windows stretched, but its events carry no confidence.
- **Real data.** Nothing here reaches a real magnetometer. A real network
  would need its readings to reach the server through a new, versioned node
  contract, and the requirements ruled out changing `/v1/nodes`.
- **Recalibration on real data.** Real sites have magnetic clutter, drift
  and a less common common mode. The coefficient, and so every confidence,
  must be measured again on real data before a threshold means anything.
- **Localisation.** When a pass is seen by two or more magnetometers, their
  fitted strengths and timings could locate and track it. The `core`
  placement exists to make that likely in simulation. It is not attempted.
