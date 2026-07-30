# Nectar Arcade

Three browser games, one per kid, sharing a weekly prize board.

| Path | Game | State |
| --- | --- | --- |
| `/` | the hub — game picker and joint prize board | live |
| `/nova/` | **DANYLO: NECTAR NOVA** — 3D arena shooter | live |
| `/fish/` | **MIKE: QUIET WATER** — fishing, three minutes at dawn | live |
| `/city/` | **SOFIA: CITY LIGHTS** — open world, delivery jobs | not built yet |

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
  nova/                         one folder per game, self-contained
```

The constraints from Nova hold for every game here: **no build step, no CDN, no
art assets.** Every mesh is primitives, every texture is drawn with canvas at
load, all sound is synthesised with WebAudio. A game is a folder you can copy.

`shared/` is deliberately small — only things that already have more than one
consumer. `quality.js`, `audio.js` and `fx.js` stay duplicated per game on
purpose: each would need a seam invented for it, and inventing a seam with one
real consumer reliably produces one that fits nobody.

Now that a second game exists, that bet can be scored. Diffing `fish/src` against
`nova/src`:

- **`fx.js` — identical.** This one is genuinely shareable; do it when the third
  game confirms the shape.
- **`audio.js` — synth primitives identical, everything above them different.**
  `init`, `_env`, `_tone` and `_noise` are unchanged. The scheduler's *shape* is
  reused but its numbers are not (52 bpm against 132, a longer look-ahead), and
  the sound bank and the music are wholly new. Worth splitting into an engine
  plus a per-game bank.
- **`quality.js` — scaler identical, `apply()` and the preset flags different**,
  exactly as predicted. A shared version needs an injected `onApply(preset)` and
  a per-game extras bag, which is now a known shape rather than a guess.
- **`touch.js` — not reused at all.** Fishing needs one contextual button, not a
  stick and five action keys. Finding out a module *shouldn't* be shared is a
  successful result, not a failure.
- **`shared/input.js` — not reused either.** It's built on pointer lock and
  relative deltas; the fishing game needs an absolute position on the water and
  never grabs the cursor, so it has its own small `pointer.js`.

Conclusion so far: share `fx.js` and split `audio.js`; leave `quality.js` until a
third consumer proves the callback shape; don't share input at all.

## Scores and the weekly prize

Each game posts to the worker in [`../leaderboard`](../leaderboard). Boards run
Monday to Sunday, `America/Toronto`. Play as Danylo, Mike or Sofia with a PIN —
asked once per device, on the game-over screen, never before playing — or as a
guest, whose scores stay on that device.

With no `LEADERBOARD_URL` set, everything still works; the board just lives in
this browser and says so.

Storage keys: `play.name` and `play.pin` are shared across games, while
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

**Nova, submitting:** pick a name from the roster — the PIN box appears for a
kid and not for GUEST · a wrong PIN says `WRONG PIN` and lets you retry, and
does *not* claim the board is unreachable · a correct PIN posts and reports a
rank plus prize points · GUEST saves locally and the table says `THIS DEVICE`.

**Nova, phone:** portrait shows the rotate screen · landscape shows the stick and
all five buttons · auto-fire defaults on · starts on a low graphics tier and
climbs.

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
