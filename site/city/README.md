# SOFIA: CITY LIGHTS

A neon city at dusk and a car with the keys in it.

Built with three.js on the same terms as the rest of the arcade: no build step, no
CDN, no art assets. The buildings are boxes with canvas-drawn facades, the road is
a canvas texture, the neon is emissive material plus bloom, and the radio is
synthesised with WebAudio.

## Run it

```bash
npm run site          # → http://127.0.0.1:5180/city/
```

Serve from `site/`, not from this folder — three.js and the shared score client
live one level up.

## Two modes, on purpose

**FREE ROAM** has no clock, no damage, no fail state and **no score at all.**
Drive wherever you like, find stars, unlock cars, change the station, watch the
day turn to night. It never touches the leaderboard.

That is a deliberate design decision, not an oversight. This game was asked for as
"an open world you drive around in"; putting a weekly competition on top of that
would have replaced the thing that makes it good with a thing that makes it
stressful.

**SHIFT** is the contest: five minutes of chained deliveries, and the only mode
that reaches the prize board. You opt into it from the title screen, the pause
menu, or by pressing Enter while roaming.

## Controls

| | |
| --- | --- |
| **W A S D** or arrows | drive — S brakes, then reverses |
| **SPACE** | handbrake |
| **R** | change radio station |
| **ESC** | pause |
| **ENTER** | clock on for a shift (while roaming) |

Keyboard only. There are no touch controls — this one genuinely wants a laptop,
and pretending otherwise with four thumb buttons would have been worse than
saying so.

## Driving

The car has a **heading** and a **velocity**, and they're allowed to disagree.
Steering turns the heading; grip drags the velocity back towards it. Ask for more
turn than the tyres can give and the difference is a slide — so drifting isn't a
mode you toggle, it's just what happens past the limit. The handbrake is a grip
multiplier and nothing else.

Consequences worth knowing:

- Steering authority falls off with speed, so the car feels heavy fast and nimble
  in a car park — but you're never locked out of a turn.
- A slide has to be **unwound**, not switched off.
- Sliding scrubs speed, so drifting everywhere is not the fast line.
- Reverse steers the way reverse actually steers.

Three cars, and they're genuinely different rather than three colours:

| | unlock | character |
| --- | --- | --- |
| **SCOUT** | free | forgiving. Turns tight, holds the road, drifts on the handbrake. |
| **HAULER** | 14 ★ | slow to turn, wide, and it *will not* drift no matter what you do. |
| **COMET** | 34 ★ | fastest and tightest, with deliberately poor grip — it steps out on the throttle alone. |

Measured by simulating the model directly: top speeds 27 / 24 / 33, turning
*radii* at 20 m/s of 11.7m / 17.1m / 8.3m, and 0–90% of top speed in
4.0s / 5.5s / 3.7s. `car.test.js` asserts the relationships between those rather
than the figures themselves — that the hauler turns widest, that the comet is
quickest, that every car approaches but never exceeds its quoted top speed.

## Stars

51 of them, hidden along the back streets, tucked down alleys between buildings,
and strung in the air off the four ramps — those last ones need a proper run-up.
Collecting them unlocks cars, and they persist in `localStorage`. They are never
part of your *score* — free roam pays nothing — but the lifetime total is sent
alongside a shift submission as a stat, so it does show up on the board.

The city is generated from a fixed seed, so it is the same city every time. That
is what makes the stars worth hunting: without it the map would be rebuilt on
every load and a collected star would reappear somewhere you had never been.

## Scoring (SHIFT only)

Per delivery: a fee based on distance, plus up to 60% more for the clock you
saved, plus 25% for arriving without hitting anything, all multiplied by your
streak.

The streak is +0.25× per delivery up to **3×**, and only a timed-out parcel
resets it. Crashing costs you that job's clean bonus but **never** the parcel or
the streak — losing a job to a wall you clipped would just be miserable.

`bestRun` on the board is your *quickest* single delivery.

Measured, simulated over a full shift: a driver averaging 12 m/s banks ~17k, one
at 22 m/s ~29k, and one flat out at 31 m/s ~55k. A real player navigating actual
streets rather than beelining will be well under those.

## Leaderboard

Posts to `/g/city/score`. Boards run Monday to Sunday. Pick who you are and enter
a PIN — asked once per device, on the shift-over screen, never before playing.
**GUEST** keeps scores on the device only. Stats sent: `deliveries`, `stars` and
`bestRun`.

## Notes for whoever touches this next

**The two files worth understanding first** are `car.js` and `collide.js`, and
neither imports three.js — the handling and the broadphase are both simulated in
tests rather than eyeballed. `carmesh.js` holds the geometry, same split as the
fishing game's `fish` / `fishmesh`.

**The grid hash in `collide.js` is a broadphase, so it returns a conservative
superset** of what overlaps a query — extra candidates are fine, a *missing* one
is a car through a wall. The test asserts against a brute-force scan for exactly
that. Honest caveat: this city has only ~77 colliders, so a linear scan would
have been perfectly fine at this size. The grid is tested and correct and costs
nothing, but it is insurance for a bigger city rather than a present-day necessity.

**Ramps are launch kickers, not roads onto rooftops.** Supporting a car parked on
a roof means solving elevated collision; a ramp needs only a height function and
gravity. Two things to know: the ramps must sit on the **roads** at `BLOCK/2`
offsets and not at block centres, because block centres are where the buildings
are (the first version buried all four inside buildings, invisible and
unreachable); and the launch multiplier in `main.js` is doing real work — the two
short ramps rise 5m over 20m and the two long ones 6m over 22m, so all four are
about 14°, and the honest vertical component at speed gives roughly a 70cm hop.
The multiplier is what turns that into a jump worth aiming at. It is clamped,
because `groundAt` is a step function at the ramp edges and an unclamped rate
there reaches several hundred metres per second.

**Copied rather than shared:** `fx.js` (byte-identical for the third time),
`quality.js` (again, only `apply()` and the preset flags differ) and `audio.js`
(synth primitives identical, bank and music new). `shared/input.js` IS reused
here as-is, unmodified — its pointer-lock machinery is all on the mouse path, so
the keyboard half works untouched. That's the first genuine reuse of it outside
the shooter, and it's written up in [`../README.md`](../README.md).

**Cut from v1, deliberately:** pedestrians, traffic, car damage, interiors, a map
screen, photo mode, and touch controls.

**Still worth doing with Sofia in front of it.** The numbers say the car is
predictable and the three variants are distinct, but only she can say whether
driving it is *fun*, which is the only thing that matters here. The knobs are
`CARS[*]` in `car.js`; the ones that change the feel most are `grip` and
`slip` (how readily it lets go), `turn` and `turnRefSpeed` (how eager the
steering is), and `handbrakeGrip` (how wild a handbrake turn gets).

And the bigger question is still open: she asked for GTA 6, and this is a guess at
which part of that she actually wanted. If the answer turns out to be missions and
characters rather than a car and a city, the free-roam half is the part to keep
and build on.
