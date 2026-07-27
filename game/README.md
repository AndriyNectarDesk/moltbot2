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

Needs WebGL2. On desktop, click **LAUNCH** and the game takes pointer lock; on a
phone or tablet it switches to touch controls automatically.

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

### Touch

Detected automatically on any coarse-pointer device — no pointer lock, on-screen
controls instead, and the game asks you to rotate to landscape if you're in
portrait.

| Input | Action |
| --- | --- |
| Left thumb, anywhere on the left half | Virtual stick — it appears where you press |
| Right thumb, drag | Aim / swing the camera |
| **FIRE** | Plasma. **Auto-fire is on by default** on touch, so holding the reticle near a target is enough — aiming precisely with a thumb isn't realistic |
| **BEAM** | Hold to charge, release to fire |
| **FLY** | Tap to jump, tap again to double-jump, hold to fly |
| **DASH** / **NOVA** | Super dash · the ultimate |
| **II** (top right) | Pause |

Touch devices start on a low graphics tier and climb only if there's headroom —
guessing high on a phone means the first few seconds are a slideshow. Auto-fire
can be turned off in the pause menu.

### Keyboard &amp; mouse

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

## Leaderboard

After each run you can name your hero and post the score. Out of the box the
board is **stored on this device only** — it works immediately, it just isn't
shared. To make it shared across everyone's phones and laptops, deploy the
Cloudflare Worker in [`../leaderboard`](../leaderboard) (about two minutes, free
tier) and paste its URL into [`config.js`](./config.js).

Once shared, one row per name: re-posting only replaces your row if you beat
your own score, so the table shows who is best rather than who played most.

Worth knowing: **scores can't be verified.** The game runs in the player's own
browser, so anyone who opens the devtools console can post any number. The
worker rejects obvious nonsense and rate-limits submissions, but for a genuinely
cheat-proof board the game would have to be simulated server-side. Among friends
this is usually the right trade — just don't take a suspiciously round number
too seriously.

## Performance

Graphics quality is adaptive. The game picks a starting tier from your screen
size and hardware, then watches the real frame time: if it stays below ~45fps
for more than a second it drops a tier, and it only climbs back after a
sustained stretch above ~87fps. A brief `GRAPHICS → LOW` banner tells you when
it moves, so a sudden visual change is never a mystery.

Live FPS and the current tier are shown in the bottom-left corner.

| Tier | Pixel ratio | Bloom | Shadows | Particles | Decor |
| --- | --- | --- | --- | --- | --- |
| **High** | up to 1.35× | yes | yes (1024) | 100% | all |
| **Medium** | 1× | yes | no | 75% | all |
| **Low** | 0.85× | no | no | 45% | no clouds |
| **Potato** | 0.6× | no | no | 25% | minimal |

Override it any time from the pause menu (`ESC` → Graphics); picking a tier by
hand turns auto-scaling off. Bloom is by far the most expensive single effect,
so `Medium` → `Low` is the biggest jump.

## Options

The pause menu also toggles screen shake, bloom, audio, invert-Y, the FPS
readout and mouse sensitivity.

## Tinkering

`window.game` is exposed, along with `__THREE` and `__E` (the enemy classes), so
you can poke at a live run from the devtools console:

```js
game.hero.hp = 9999
game.hero.ult = 100                                     // Nova ready
game.spawnEnemy(__E.MoltbotPrime, new __THREE.Vector3(0, 0, -14), 5)
```
