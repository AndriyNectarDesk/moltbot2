# Nectar Arcade

Three browser games, one per kid, sharing a weekly prize board.

| Path | Game | State |
| --- | --- | --- |
| `/` | the hub — game picker and joint prize board | live |
| `/nova/` | **DANYLO: NECTAR NOVA** — 3D arena shooter | live |
| `/fish/` | **MIKE: QUIET WATER** — fishing, three minutes at dawn | live |
| `/city/` | **SOFIA: CITY LIGHTS** — open world driving, delivery shifts | live |

## Run it

```bash
npm run site
```

Serves the whole site at http://127.0.0.1:5180/ with a directory index and
trailing-slash redirects, matching what GitHub Pages does. It must be `http://`,
not `file://` — ES modules and importmaps don't work from the filesystem.

For a phone on the same wifi, bind to the LAN: `HOST=0.0.0.0 npm run site`.

## Layout

```
site/
  index.html hub.css hub.js     the hub — plain HTML/CSS/JS, no three.js, loads instantly
  vendor/                       three.js r185, shared by every game
  shared/                       code and styling every game uses
    base.css                    tokens, the screen shell, buttons, the score table
    util.js  input.js           maths helpers, keyboard/mouse/pointer-lock
    leaderboard.js  config.js   the score client and the API URL
    fx.js                       particle effects — the one shared module needing three.js
    audioengine.js              WebAudio setup + synth primitives; banks stay per game
  nova/                         one folder per game, self-contained
```

The constraints from Nova hold for every game here: **no build step, no CDN, no
art assets.** Every mesh is primitives, every texture is drawn with canvas at
load, all sound is synthesised with WebAudio. A game is a folder you can copy.

`shared/` is deliberately small — only things that already have more than one
consumer. `quality.js` stays duplicated per game on
purpose: it would need a seam invented for it, and inventing a seam with one
real consumer reliably produces one that fits nobody. (`fx.js` was in that list
until all three games proved it byte-identical; it graduated to `shared/fx.js`.
`audio.js` split along the line the scoring found: the engine — WebAudio setup
and the synth primitives — graduated to `shared/audioengine.js`, and each game's
`audio.js` keeps its own bank and music on top of it.)

All three games now exist, so that bet can be scored properly. Diffing each
game's copies against Nova's:

- **`fx.js` — byte-identical in all three.** Confirmed by md5. There was nothing
  left to learn about it, so it has been moved: it is now `shared/fx.js` and all
  three games import it from there. It is the one `shared/` module that imports
  `three` — fine from a game page, but the hub has no import map, so `hub.js`
  must never pull it in.
- **`audio.js` — synth primitives identical, everything above them different.**
  `init`, `_env`, `_tone` and `_noise` are unchanged — and are now the shared
  `AudioEngine` class in `shared/audioengine.js`, which each game's `Audio`
  extends; the engine's header documents exactly what subclasses may reach into.
  The scheduler's *shape* is
  reused but its numbers are not (52 bpm against 132, a longer look-ahead), and
  the sound bank and the music are wholly new. Worth splitting into an engine
  plus a per-game bank — now done, as above.
- **`quality.js` — scaler identical all three times; only `apply()` and the
  per-preset scene flags differ**, exactly as predicted, three for three. The
  shared version wants an injected `onApply(preset)` plus a per-game extras bag,
  and there are now three real consumers to shape that around instead of one real
  and one imagined.
- **`touch.js` — not reused at all.** Fishing needs one contextual button, not a
  stick and five action keys, and the city ended up with its own pedal buttons
  (`city/src/touch.js`) rather than nova's stick — three games, three different
  touch schemes. Finding out a module *shouldn't* be shared is a successful
  result, not a failure.
- **`shared/input.js` — reused unmodified by the city, and not at all by fishing.**
  The city drives from the keyboard (touch pedals merge in beside it) and that
  module's pointer-lock machinery is all on the mouse path, so its keyboard half
  worked untouched. Fishing needed an absolute
  position on the water and never grabs the cursor, so it has its own small
  `pointer.js`. Two consumers wanting opposite things from one module is exactly
  the seam that shouldn't be invented.

**Conclusion now that all three exist:** move `fx.js` into `shared/` as-is
(done); split
`audio.js` into an engine plus a per-game bank (done); give `quality.js` an
`onApply(preset)` callback and share it. Leave input alone — one game wants locked
deltas, one wants an absolute pointer, one wants only keys, and no single module
serves all three without a mode flag threaded through every method.

That is a real result from the copy-first bet: three modules identified as worth
sharing *with their seams already known*, and one identified as not worth sharing
at all. Guessing at those seams after the first game would have got at least the
input one wrong.

## Scores and the weekly prize

Each game posts to the worker in [`../leaderboard`](../leaderboard). Boards run
Monday to Sunday, `America/Toronto`. Play as Danylo, Mike or Sofia with a PIN —
asked once per device, on the game-over screen, never before playing — or tap
**+ NEW PLAYER** and pick your own name and PIN, which is how a friend the kids
bring home gets on the same board and competes for the same prize. GUEST is
still there for someone who just wants a go; their scores stay on that device.

The strip of names is built by [`shared/identity.js`](shared/identity.js), not by
markup: it is the three kids, plus whoever has signed in on this device, plus
GUEST, plus signup — only the first and third are known ahead of time.

With no `LEADERBOARD_URL` set, everything still works; the board just lives in
this browser and says so.

Storage keys: `play.name`, `play.pin` and `play.players` (the friends who have
signed in on this device) are shared across games, while
`play.scores.<game>` is per game. All three games are one origin, so
un-namespaced keys would have them overwriting each other. The old
`nectarnova.*` keys are carried over once, so nobody's saved name or personal
best disappears.

## Smoke checklist

The failure mode of this layout is "moved a file, forgot a path", which shows up
as a black screen rather than an error. The deploy workflow curls every shared
asset, and this is the human half. **Run it against a preview URL before merging
anything that moves files:**

```bash
npx wrangler pages deploy site --project-name nova-preview
```

Because every path is relative, serving from `/` instead of `/moltbot2/` is a
feature of the test — it proves nothing is absolute.

**Network tab first** — this catches the whole class of path mistakes:
exactly one `three.module.min.js`, loaded from `/vendor/` and not
`/nova/vendor/`; `shared/base.css` and `nova/style.css` both 200; zero 404s.

**Hub:** three cards render, Nova and Quiet Water are clickable and City Lights
is not, the prize board loads (or says it can't reach the board without breaking
the page), the rules expand.

**Nova, desktop:** no console errors · neon title intact · `← ALL GAMES` returns
to the hub · title board loads · LAUNCH takes pointer lock · WASD moves
camera-relative · mouse orbits · left-click plasma · right-click hold then
release fires the beam · Space jump, double-jump, hold to fly · Shift dash · Q
nova plus slow-mo · taking a hit gives hitmarker, damage floaters, vignette ·
combo climbs and decays · boss bar appears on the boss wave · ESC pauses, the
quality dropdown visibly changes tiers and the FPS readout moves, all eight
toggles respond · M mutes · die, and the game-over screen shows all four stats
and a rank.

**Nova, submitting:** pick a name — the PIN box appears for a player and not for
GUEST · a wrong PIN says `WRONG PIN` and lets you retry, and does *not* claim the
board is unreachable · a correct PIN posts and reports a rank plus prize points ·
GUEST saves locally and the table says `THIS DEVICE`.

**Signing up:** + NEW PLAYER opens a name and PIN box · a name under two
characters, with no letter, or mixing scripts is refused before any request · a
taken name says so without revealing whether the account exists · a successful
signup adds a button for that name, fills in the PIN, and flips SAVE HERE to POST
SCORE · typing in either box must not steer the car or fire the ship · come back
later and the name is a button, needing only the PIN again · save a run as GUEST
and THEN sign up, and the submit button must come back to life so that run can
still be posted · anyone who isn't one of the three kids shows a VISITOR tag on
every board.

**Nova, phone:** portrait shows the rotate screen · landscape shows the stick and
all five buttons · auto-fire defaults on · starts on a low graphics tier and
climbs.

**City Lights:** FREE ROAM has no clock and no score · W/A/S/D drives and the
speedo moves · SPACE breaks traction and the DRIFT indicator lights · the four
ramps are on the roads and launch the car into the air stars · stars persist across
a reload and unlock cars in the garage · R cycles NEON FM / SLOW LANE / OFF AIR ·
ESC pauses · a SHIFT shows the clock, cash, streak, job card and the waypoint
arrow · a delivery pops a cash figure and the streak climbs · the clock ends the
shift and the screen shows five stats.

**City Lights, phone:** portrait shows TURN SIDEWAYS and pauses a drive ·
landscape shows steer arrows bottom-left, DRIFT/brake/gas bottom-right · holding
gas drives, sliding a thumb off a pedal releases it · the pedals vanish under
every menu and on game over · the title shows button hints instead of W A S D ·
the pause button in the top bar still works with the pedals up.

**Quiet Water, phone:** the whole game is one finger — hold to cast, tap to
strike, hold to reel · dragging while reeling must not pull-to-refresh ·
portrait shows TURN SIDEWAYS and pauses a run.

**Quiet Water:** cast lands where the bright ring shows · the water name under
the reticle changes over lilies, the dock shade and a rising ring · the float taps
then goes under · striking during the taps spooks, striking after it goes under
hooks · during a fight the bar flashes gold and says LET GO before every run ·
letting go on that survives, holding through it snaps · landing shows a catch card
and the flow multiplier climbs · the clock ends the run and the game-over screen
shows five stats.

**Devtools poke test:** `window.game`, `window.__THREE` and
`game.hero.hp = 9999` all still work. That is a documented feature of this
codebase, so treat it as a test case.

## Deploying

Pushing to `main` with anything under `site/` triggers
`.github/workflows/deploy-game.yml`, which uploads this folder as the Pages
artifact and then checks the deployed URLs resolve.

`preview.png` stays at this folder's root, which is why the absolute `og:image`
URL needs no change. Rolling back is `git revert` plus one deploy — no build, no
migrations.

One thing to expect on a layout change: a returning visitor can get a cached old
`index.html` that references files which have moved, giving a black screen for a
few minutes until the cache expires. A hard reload (Ctrl+Shift+R) fixes it
immediately. Not worth engineering around; worth warning whoever is playing.
