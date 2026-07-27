# DANYLO: NECTAR NOVA

A third-person 3D arena shooter where **Danylo** is Captain Danylo — spiky blond
hair, freckles, hero mask, orange cape, jet boots and plasma palms — defending a
floating neon sky-city from the Glitch Legion.

Built with three.js. No build step, no CDN, no art assets: every mesh is made of
primitives, every texture is drawn with canvas at load time, and all the sound is
synthesised with WebAudio.

## Run it

```bash
npm run game          # → http://127.0.0.1:5180/
```

That starts a tiny dependency-free static server (`game/serve.mjs`). Any static
server works just as well, e.g. `python3 -m http.server 5180` from this folder.
It has to be served over `http://` — ES modules and importmaps don't load from
`file://`.

Needs a desktop browser with WebGL2 and a mouse. Click **LAUNCH**, then the game
takes pointer lock.

## Share it

The game is static files, so it hosts anywhere. This repo ships a GitHub Pages
workflow (`.github/workflows/deploy-game.yml`): once `game/` lands on `main`, the
workflow enables Pages and publishes to

**https://andriynectardesk.github.io/moltbot2/**

Re-deploys happen automatically on any push to `main` that touches `game/`, and
you can also trigger it by hand from the repo's **Actions** tab
(*Deploy game to GitHub Pages* → *Run workflow*).

Prefer Cloudflare (custom domain, no repo coupling)? One command, no config:

```bash
npx wrangler pages deploy game --project-name danylo-nectar-nova
```

Either way, the only thing to update afterwards is the `og:image` URL in
`index.html`, which points at the Pages copy of `preview.png` so shared links
show a screenshot.

## Controls

| Input | Action |
| --- | --- |
| `WASD` | Move (relative to the camera) |
| Mouse | Aim / orbit the camera |
| Left click | Plasma bolts — alternating palms |
| Right click (hold, release) | Charge and fire the Nectar Beam — pierces everything in a line |
| `Space` | Jump, double-jump, hold in the air to fly (costs energy) |
| `Shift` | Super dash — brief invulnerability |
| `Q` | **NECTAR NOVA** ultimate — clears incoming fire, huge radial damage, slow-mo |
| `Esc` | Pause · `M` mute |

## How a run goes

Waves escalate; every 5th wave is **MOLTBOT PRIME**, a two-phase boss with a
weak-point core, spiral barrages, a rotating sweep laser and adds.

| Enemy | Behaviour |
| --- | --- |
| **Zipper** | Tiny kamikaze that arms, then rushes and detonates |
| **Skitter** | Orbits at altitude, plinks plasma orbs; homes at high tiers |
| **Lancer** | Hovers far out, telegraphs a red laser line, then snipes |
| **Brute** | Ground mech; twin cannons at range, ground slam up close. Cyan core takes double damage |

Kills within 4s of each other build a combo multiplier up to `x8`. Damaging
enemies charges the Nova. Enemies drop health and energy orbs. Weak-point hits
(Brute core, Lancer lens, Prime core) do 2.2× and show orange crit numbers.

Falling off the pad costs 15 HP and teleports you back — you can't lose a run to
the void.

## Layout

| File | What's in it |
| --- | --- |
| `src/main.js` | Bootstrap, camera rig, wave director, main loop, combat hooks |
| `src/hero.js` | Captain Danylo's rig, procedural animation, movement, abilities |
| `src/enemies.js` | The four grunts + MOLTBOT PRIME |
| `src/world.js` | Arena, sky shader, city, containment shield, collision |
| `src/projectiles.js` | Pooled bolts and pickups |
| `src/fx.js` | Particle system, shockwave rings, light bursts, beams |
| `src/hud.js` | DOM HUD, damage numbers, kill feed, banners |
| `src/audio.js` | Procedural SFX + the looping synth soundtrack |
| `src/input.js` | Keyboard, mouse, pointer lock |
| `vendor/` | three.js r185 + the postprocessing addons, vendored (MIT) |

## Options

The pause menu toggles screen shake, bloom, audio, invert-Y and mouse
sensitivity. If the frame rate is low on an older machine, turning **bloom** off
is the biggest single win.

## Tinkering

`window.game` is exposed, along with `__THREE` and `__E` (the enemy classes), so
you can poke at a live run from the devtools console:

```js
game.hero.hp = 9999
game.hero.ult = 100                                     // Nova ready
game.spawnEnemy(__E.MoltbotPrime, new __THREE.Vector3(0, 0, -14), 5)
```
