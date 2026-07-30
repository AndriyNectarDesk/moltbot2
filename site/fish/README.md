# MIKE: QUIET WATER

Three minutes on a lake at dawn. Read the surface, wait for the float to go
under, then hold your nerve.

Built with three.js on the same terms as the rest of the arcade: no build step,
no CDN, no art assets. The water is a displaced plane, the sky and the water tint
are canvas gradients drawn at load, every fish is primitives, and all the sound
is synthesised with WebAudio.

## Run it

```bash
npm run site          # → http://127.0.0.1:5180/fish/
```

Serve from `site/`, not from this folder — three.js and the shared score client
both live one level up.

## Controls

One button. What it does depends on what is happening.

| | |
| --- | --- |
| **Hold** | wind up a cast — longer hold, further out |
| **Let go** | send it |
| **Tap** | set the hook, once the float goes under |
| **Hold** | reel in |
| **Tap** while waiting | wind in early and cast somewhere better |

Mouse, touch or **Space** all work. There is no pointer lock and no fullscreen —
it's a game you can play one-handed with a cup of tea.

## The three skills

**Reading the water.** Where you land matters more than anything else. Open
water catches small fish slowly. The shade off the end of the dock and the lily
patches always hold something. Expanding rings mean a fish just rose *there*, and
they fade after a few seconds. A shimmer drifting across the lake is the best
water there is, and it does not wait for you. Good water bites in about a second
and puts the rare fish on the table; open water takes five and mostly doesn't.

**Learning the tells.** Every species announces itself before it commits, and the
float is the only thing that tells you. A flurry of tiny taps is a sunfish. Two
firm dips is a perch. One solid thump is a bass. If the float just leans over and
keeps going, something big has it. Strike **after** it goes under — striking
during the taps spooks the fish, and waiting too long loses it.

**The fight.** This is the ceiling. Tension rises while you reel *and* while the
fish runs, and it only falls when you let go. So: reel during the lulls, ease off
during the runs, and go into every run with slack in the bar to survive it. Fish
tire, and a tired fish pulls less and rests longer — patience is rewarded twice.

Bigger fish are **easier to hook and much harder to land**, on purpose. Hooking a
sturgeon is the beginning of the problem, not the reward.

## Scoring

`grams ÷ 100 × rarity × flow`, per fish.

| | rarity | weight |
| --- | --- | --- |
| Sunfish | 1× | 90 g – 320 g |
| Perch | 2× | 280 g – 900 g |
| Bass | 4× | 900 g – 2.6 kg |
| Pike | 9× | 2.2 kg – 6.5 kg |
| Sturgeon | 20× | 6 kg – 17 kg |

**Flow** is the multiplier for landing fish back to back — +0.5× each, up to 3×.
Snapping the line or spooking a fish resets it. That is the whole risk/reward
shape of a run: greed costs you the multiplier, not just the fish.

One pike is worth more than a bucket of sunfish, so hunting the rare fish over
good water beats farming the easy bite in open water. A measured skilled run
scores roughly 4,000–11,000.

## Leaderboard

Posts to `/g/fish/score` on the worker in [`../../leaderboard`](../../leaderboard).
Boards run Monday to Sunday. Pick who you are and enter a PIN — asked once per
device, on the game-over screen, never before playing. **GUEST** keeps scores on
the device only.

Stats sent: `landed`, `heaviest` (grams), `species` (distinct, out of 5) and
`flow` (best multiplier ×10). The heaviest fish is what shows on the board next
to your score, because it's the number a kid actually brags about.

## Notes for whoever touches this next

**`quality.js`, `fx.js` and `audio.js` are copies of Nova's, not shared code.**
That was deliberate — see [`../README.md`](../README.md). What actually differed
once the game existed:

- `quality.js` — only `apply()` and the three scene flags per preset. The scaler
  itself is byte-identical. It also gained `waterStep`, because displacing ~2,400
  water vertices per frame is this game's single biggest cost and interleaving
  the rows is a better trade than a coarser mesh.
- `audio.js` — the synthesis engine is byte-identical; the whole sound bank and
  the music are new. A shooter wants sharp transients and a driving minor
  arpeggio; a lake wants soft attacks and a slow pentatonic pad.
- `fx.js` — unchanged, and only `ringBurst` is used. This one probably *is* worth
  sharing when the third game lands.
- `touch.js` — not copied at all. This game needs one contextual button and the
  water as a target, so Nova's five-button pad and virtual stick were no use.
- **`pointer.js` is new, not `shared/input.js`.** That module is built on pointer
  lock and relative deltas; this game needs an absolute position on the water and
  never grabs the cursor. Two consumers wanting opposite things from one module
  would have meant a mode flag threaded through every method.

`fish.js` holds the rules and deliberately imports no three.js, so the fight
maths is testable without a WebGL context — `fish.test.js` simulates skilled,
greedy and passive play and asserts the shape of the difficulty curve. The tuning
was done against those numbers rather than by feel, which is how the sunfish
ended up explicitly forgiving: it's the fish you catch while still working out
what the button does.

**Still worth doing with Mike in front of it:** the numbers say the fight is
fair, but only he can say whether it *feels* good. The knobs are all in
`SPECIES[*].fight` in `fish.js`, and the ones that matter most are `reelTension`
(how fast reeling costs you) and `ease` (how fast letting go recovers).
