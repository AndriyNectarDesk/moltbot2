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
| **Hold** | reel in — tighter line, faster progress |
| **Let go** | when the bar flashes and says LET GO, a run is coming |
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
firm dips is a perch — and two SLOW leans, twice as drawn out, is a carp, which
is the difference worth learning because one is worth six times the other. One
solid thump is a bass. If the float just leans over and
keeps going, something big has it. Strike **after** it goes under — striking
during the taps spooks the fish, and waiting too long loses it.

**The fight.** This is the ceiling, and it has two rules.

Tension rises while you reel *and* while the fish runs, and it only falls when
you let go. And **line comes in faster when the line is tighter** — so holding a
high tension is how you land a fish quickly, not just how you lose one.

The catch is that a run opens with a *shock*, an instant hit to the line that
can't be reacted to. But the fish always tells you first: it gathers itself for a
moment, the bar flashes gold and the reel says **LET GO**. Let go on that
telegraph and you meet the run with slack and ride it out. Ignore it and hold a
high tension anyway and the shock snaps you.

Which makes the whole thing a bet. You *can* play with one eye on the bar alone —
just keep the tension low enough that no surprise can break it. That works, and
it's slow. Watching the fish instead lets you hold nearly twice the tension and
land a sturgeon around 40% faster, which inside a three-minute run is the
difference between a good morning and a great one.

Fish tire, and a tired fish pulls less, hits softer and rests longer — patience
is rewarded twice.

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
| Carp | 12× | 3 kg – 13 kg |
| Sturgeon | 20× | 6 kg – 17 kg |

**Flow** is the multiplier for landing fish back to back — +0.5× each, up to 3×.
Snapping the line or spooking a fish resets it. That is the whole risk/reward
shape of a run: greed costs you the multiplier, not just the fish.

One pike is worth more than a bucket of sunfish, so hunting the rare fish over
good water beats farming the easy bite in open water. A measured attentive run
scored roughly 10,000–15,000 over 14–16 fish under the original bite windows;
the windows were widened for human reactions after the first real playtest, so
expect real runs to land somewhat more than that, and re-measure before leaning
on the number.

## Leaderboard

Posts to `/g/fish/score` on the worker in [`../../leaderboard`](../../leaderboard).
Boards run Monday to Sunday. Pick who you are and enter a PIN — asked once per
device, on the game-over screen, never before playing. **GUEST** keeps scores on
the device only.

Stats sent: `landed`, `heaviest` (grams), `species` (distinct, out of 6) and
`flow` (best multiplier ×10). The heaviest fish is what shows on the board next
to your score, because it's the number a kid actually brags about.

## Notes for whoever touches this next

**`quality.js` and `audio.js` are copies of Nova's, not shared code.** (`fx.js`
was one too, until all three games proved it byte-identical; it now lives in
`../shared/fx.js`.)
That was deliberate — see [`../README.md`](../README.md). What actually differed
once the game existed:

- `quality.js` — only `apply()` and the per-preset scene flags. The scaler logic
  itself is unchanged. It also gained `waterStep`, because displacing ~2,400
  water vertices per frame is this game's single biggest cost and interleaving
  the rows is a better trade than a coarser mesh.
- `audio.js` — the synth primitives (`_tone`, `_noise`, `_env`) are unchanged;
  the scheduler keeps its shape but not its tempo, and the whole sound bank and
  the music are new. A shooter wants sharp transients and a driving minor
  arpeggio; a lake wants soft attacks and a slow pentatonic pad.
- `fx.js` — byte-identical, and only `ringBurst`, `update` and `setScale` are
  used. It was worth sharing once the third game landed, and now is shared:
  `../shared/fx.js`.
- `touch.js` — not copied at all. This game needs one contextual button and the
  water as a target, so Nova's five-button pad and virtual stick were no use.
- **`pointer.js` is new, not `shared/input.js`.** That module is built on pointer
  lock and relative deltas; this game needs an absolute position on the water and
  never grabs the cursor. Two consumers wanting opposite things from one module
  would have meant a mode flag threaded through every method.

`fish.js` holds the rules and deliberately imports no three.js, so the fight
maths is testable without a WebGL context — `fish.test.js` plays out attentive,
thermostat, greedy and passive strategies a few hundred times per species and
asserts the shape of the difficulty curve.

That harness earned its keep immediately. The first version of this fight had no
telegraph and no surge, and a review proved that a thermostat which never even
looked at the fish landed every species 100% of the time and did it *faster* than
playing properly — the advertised skill ceiling simply didn't exist, and the
original tests certified the wrong property because their "skilled" policy's
run check was dead weight. Rules 1 and 2 in `fish.js`, and the
"punishes a thermostat" test, are the fix. Don't remove either without
re-measuring.

The same process is why the sunfish is explicitly forgiving *and* explicitly
quick: it's the fish you catch while still working out what the button does.

**Still worth doing with Mike in front of it:** the numbers say the fight is
fair, but only he can say whether it *feels* good. The knobs are all in
`SPECIES[*].fight` in `fish.js`. The ones that matter most:

- `warn` — how long the telegraph lasts. Too short and the skill is a reflex
  test; too long and it's free.
- `surge` — the hit when a run starts. This is what punishes riding a high
  tension without watching, so it's the main difficulty dial.
- `reelTension` / `ease` — how fast reeling costs you and letting go recovers.
  Together they set the duty cycle, which is what actually determines fight
  length.
- `sink` in `tell`, plus the smoothing constant in `rod.js`'s `_sinkShown` — how
  readable each species' tell is against the movement of the water underneath.
