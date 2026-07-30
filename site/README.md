# Nectar Arcade

Three browser games, one per kid, sharing a weekly prize board.

| Path | Game | State |
| --- | --- | --- |
| `/` | the hub — game picker and joint prize board | live |
| `/nova/` | **DANYLO: NECTAR NOVA** — 3D arena shooter | live |
| `/fish/` | **MIKE: QUIET WATER** — fishing | not built yet |
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
consumer. `quality.js`, `touch.js`, `audio.js` and `fx.js` stay duplicated per
game on purpose: each would need a seam invented for it, and inventing a seam
with one real consumer reliably produces one that fits nobody. When the second
game exists, diff its copies against Nova's — the diff is the seam specification.

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

**Hub:** three cards render, only Nova is clickable, the prize board loads (or
says it can't reach the board without breaking the page), the rules expand.

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
