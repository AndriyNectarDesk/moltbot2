# Nectar Arcade — read this first

Three browser games, one for each of Andriy's kids, sharing a weekly leaderboard
that a **real cash prize** is paid against. This file is the orientation; each
part has its own README with the detail.

> The rest of this repository is the upstream OpenClaw-on-Workers project. The
> arcade is a guest in it and lives entirely in `site/` and `leaderboard/`.

| | |
| --- | --- |
| **Play** | https://andriynectardesk.github.io/moltbot2/ |
| **Prize dashboard** | https://nectar-nova-scores.nectardesk.workers.dev/admin |
| **Score API** | same host, see [`leaderboard/README.md`](leaderboard/README.md) |
| **Local clone** | `Desktop/claude code/moltbot2` |

```
site/                 the games — see site/README.md
  index.html …        the hub: three cards + the joint prize board
  shared/             util, input, the score client, identity strip, base.css
  vendor/             three.js r185, shared by all three games
  nova/               DANYLO: NECTAR NOVA   3D arena shooter
  fish/               MIKE: QUIET WATER     3-minute fishing runs
  city/               SOFIA: CITY LIGHTS    open-world driving
leaderboard/          the Cloudflare Worker — see leaderboard/README.md
```

Run everything locally with `npm run site` (→ http://127.0.0.1:5180/). Tests are
`npm test` — **510** of them, and they run in CI on every push and PR.

---

## Open items, in priority order

**0. Signup is open to the internet.** Anyone who finds the URL can register a
name and a PIN from the game-over screen and, by explicit decision, competes for
the same cash as the kids — see "Who may play" below for what stands against a
stranger landing in a payout. Before the first real prize week, look at the
Players section of `/admin` the same way you look at the flag column.

**1. The PINs and dashboard password are still placeholders.** This is the one
thing standing between the arcade and a real prize week. They are currently
`danylo/1111`, `mike/2222`, `sofia/3333`, and the dashboard password is
`7GjC-ZRVHb3O`. I generated those so I could verify the flow end to end; they
were never meant to survive. Rotate with:

```bash
node -e "console.log(require('crypto').createHash('sha256').update('1234').digest('hex'))"
npx wrangler secret put PLAYERS --config leaderboard/wrangler.jsonc
npx wrangler secret put DASHBOARD_PASSWORD --config leaderboard/wrangler.jsonc
```

`PLAYERS` is a JSON map of player id → **SHA-256 hex of the PIN**. The keys must
be exactly the lowercase ids — `{"Danylo": …}` is refused with a 500 rather than
served, because it used to demote him to an ordinary self-signup in silence.
While you are in there, use 6–8 digits: signup being open to the internet makes a
4-digit PIN worth walking, and the length costs a kid nothing. `wrangler
secret put` prompts, so the real values are typed and never pass through a
transcript.

**2. No kid has played any of these games.** Not one. Every "verified" claim in
the history is structural — tests, positions, API responses. The city shipped
literally unplayable (see the blind spot below) and only got caught because
Andriy screenshotted it. Nova and Quiet Water have still never been looked at by
a human.

**3. Sofia was never asked what she actually wanted.** She asked for GTA 6.
CITY LIGHTS — a neon city, a car, and delivery jobs — is a guess at which part of
that appealed. If the answer turns out to be missions and characters, the free
roam half is the part worth keeping and building on. Worth ten minutes with her
before building anything more there.

---

## How a prize week actually runs

Weeks run **Monday 00:00 to Sunday 23:59, America/Toronto**. Each submission is
stamped with its week when it is written, so standings can never shift depending
on when you look.

1. During the week, kids play and post scores. Each game has its own board.
2. The **joint board** ranks on prize points, not raw scores — 12,400 Nova points
   and a 12.4 kg carp are different units. Per game per week: 1st = 10, 2nd = 6,
   3rd = 3, and any qualifying run = 1, stacking.
3. On Sunday or Monday, open `/admin`, look at the standings **and the flag
   column**, and press *Close week*. That freezes an immutable snapshot at
   `/week/<monday>` which embeds the rules in force and every underlying entry,
   so a kid who disputes it can check the arithmetic themselves without asking.
4. Closing produces a **payout proposal**. It does not pay anything. Recording a
   payout is a separate button, and handing over the cash is a human act.

**Pay both prizes**: a small one for winning your own game's board, and roughly
double for the joint board. That was a deliberate decision — it lets Danylo be
the best shooter alive and still lose the overall prize to a sibling who dabbles
in all three, without that feeling unfair.

---

## Who may play

Two registries. Once a player exists, both kinds are treated identically — same
board, same prize points, same joint standings, same payout proposal.

- **family** — Danylo, Mike and Sofia, in the `PLAYERS` secret. Their names
  always exist and nobody else can claim them.
- **open** — the friends the kids bring home. They tap **+ NEW PLAYER** on the
  game-over screen, pick a name and a PIN, and they are in.

Full equality was asked for deliberately. It means a friend who plays all three
games once can take the joint prize on their first afternoon, which is a real
thing that can happen and not a bug.

One address can fill all 60 slots in about twelve minutes at the current
throttle, so treat a suddenly-full registry as the squat it probably is and use
"Remove all self-signups".

Because signup is open to anyone with the URL, two things carry the weight:

1. **Everyone is marked, everywhere.** Any name not in the secret carries a
   `visitor` badge — on the dashboard, on the hub's boards, and in the tables the
   games themselves show, including on a week that has already been closed, which
   is the week a payout gets decided from. That last one matters most: the kids
   never see the dashboard, and a name is not proof of who somebody is. If the
   `PLAYERS` secret is ever unreadable, nothing is marked at all rather than
   everything being marked wrongly.
2. **The Players section removes one, or all of them.** Removing holds the name,
   deletes the account and clears their scores for the week on screen. It refuses
   on a closed week, and refuses for family — whose PINs are in a secret and
   cannot be changed from a web page. "Remove all self-signups" exists because
   one address can fill all 60 slots in about an hour, and undoing that one row
   at a time is not a recovery.

Guards that exist without needing a decision: signing up and failing to sign in
are both throttled per IP at the edge (5 a minute, on separate budgets so a
guesser cannot jam the signup form), the registry caps at 60 self-registered
players and can be cleared in one action, removed names are held rather than
freed, `guest` and friends are reserved, and a name mixing writing systems is
refused — `danylо` with a Cyrillic о is not a name, it is a costume.

Two things that guard does NOT catch, so the `visitor` badge has to: a name in
one script that mimics another (`МІКЕ`, all Cyrillic, is glyph-identical to MIKE
once the games uppercase it), and digits standing in for letters (`dany1o`).
Closing those means a confusables table, which would also start refusing names
real people have. The badge is on every board precisely because this rule stops
short.

**None of that makes a 4-digit PIN secret.** Throttling raises the cost of
walking one; it does not stop somebody patient, and it never stops somebody with
many addresses. The PIN buys attribution, not secrecy — the real defence is still
the flag column and a human approving every payout. When you rotate the
placeholders, 6 to 8 digits costs a kid nothing and is worth taking.

## Things not to undo without reading why

Each is explained at length in the file named; this is the index of decisions
that look wrong until you know the reason.

- **Prize points are a normalisation device, not an anti-cheat measure.**
  (`leaderboard/games.js`) With three kids and three games the whole contest turns
  on a few points, and capping a win at 10 makes the cheapest attack "beat my
  sibling by one" — quiet and hard to spot. The actual defence is the flag
  dashboard plus a human approving every payout. Believing the points are the
  defence is what would tempt someone to skip the approval.

- **Fewer than 2 qualifiers in a game-week ⇒ participation points only.**
  (`leaderboard/scoring.js`) Each kid owns a game and will play it most, so
  without this the normal outcome is one kid posting alone in their own game and
  banking 10 points for showing up. It is one line and it is what makes the joint
  board a contest.

- **Flags accumulate for the whole week and are never cleared.**
  (`leaderboard/worker.js`) The board row is replaced wholesale on every
  improvement, so without this a flagged cheat is cleaned up by its own next
  ordinary submission and the frozen week snapshot shows a spotless top score.

- **A corrupt board is a 500 that refuses to write, not an empty board.**
  (`leaderboard/worker.js`) Treating a bad shape as empty and overwriting it is
  how a week's standings disappear silently.

- **`ALLOWED_ORIGINS` does not restrict access.** It only sets a response header.
  Another origin's write still succeeds; `curl` ignores the mechanism entirely.
  The gate on writing is the PIN.

- **Every refusal to sign in says the same thing, everywhere.**
  (`leaderboard/worker.js`) `/join` says "that name is taken" whether the PIN was
  wrong or the name is a kid's, and the score endpoint says "wrong player or pin"
  whether or not the account exists. Splitting either into a more helpful pair
  turns them into a free test for whose account exists. The score endpoint DID
  say "unknown player" vs "wrong pin" for a while, which made /join's careful
  wording decorative.

- **Removing a player leaves a tombstone, not a hole.** (`leaderboard/players.js`)
  Deleting the record outright frees the name, and the person you just threw off
  re-registers it in one tap with the same PIN — which makes the dashboard's only
  enforcement action a suggestion. "Allow again" lifts it.

- **The PLAYERS secret is refused unless every key is already a normalized id.**
  (`leaderboard/worker.js`) `{"Danylo": …}` used to mean Danylo's own correct PIN
  registered him as an ordinary self-signup instead of signing him in as family —
  silently, and his name then belonged to a KV row. A 500 gets looked at; a
  quietly demoted kid does not.

- **Removing a player never touches a closed week.** (`leaderboard/worker.js`)
  The frozen snapshot is what a kid checks the arithmetic against. Editing it
  would make every past week worth exactly as much as your word.

- **The client's copy of the name rule is not the authority.**
  (`site/shared/leaderboard.js`) It exists so the form can complain while you
  type. `leaderboard/players.js` decides, and `test/name-cases.js` is run against
  both so they cannot drift silently.

- **The fishing fight's telegraph and surge are the entire skill.**
  (`site/fish/src/fish.js`) Without them a thermostat that never looks at the
  fish lands every species and does it *faster* than proper play — that was the
  first version, and its tests certified it as skilful. There is now a
  "punishes a thermostat" regression test. Don't remove either half without
  re-measuring.

- **Free roam in the city scores nothing and never touches the leaderboard.**
  (`site/city/src/main.js`) It's the part that was actually asked for. Putting a
  weekly competition on it would replace the thing that makes it good.

- **The city is generated from a fixed seed.** (`site/city/src/city.js`) It used
  to rebuild at random every load, so buildings moved and collected stars
  reappeared in streets you'd never driven down.

- **`quality.js` and `audio.js` are copied per game, not shared.**
  Deliberate, and now scored — see below. (`fx.js` was the third of these until
  the scoring proved it byte-identical; it now lives in `site/shared/fx.js`.)

---

## What the copy-first bet actually returned

The rule while building was: copy a module rather than share it, until a second
real consumer shows you where the seam belongs. With all three games built, that
can be judged rather than argued about.

| module | outcome |
| --- | --- |
| `fx.js` | **byte-identical in all three** (md5 confirmed). Moved into `shared/fx.js` — the one part of this verdict that is now done. |
| `audio.js` | synth primitives identical three times; the sound bank and music are wholly new each time. Split into an engine plus a per-game bank. |
| `quality.js` | the adaptive scaler identical three times; only `apply()` and the per-preset scene flags differ. Wants an injected `onApply(preset)` plus a per-game extras bag. |
| `touch.js` | never reused, and rightly: all three ended up with different touch schemes. Nova has its stick and action buttons, fishing folds touch into its one-button `pointer.js`, and the city grew its own pedal buttons (`city/src/touch.js`) — digital, because the car was tuned against ±1 keyboard input. |
| `shared/input.js` | reused unmodified by the city (keyboard only), not at all by fishing (which needs an absolute pointer and no lock). **Do not share input** — the three games want opposite things. |
| `shared/identity.js` | shared from the start, and the exception that proves the rule: identity is one fact across the arcade, so three copies would be three chances for the three games to disagree about who you are. |

Three modules identified as worth sharing *with their seams already known*, and
two identified as not worth sharing at all. Guessing after the first game would
have got the input one wrong.

---

## Working on this

**Deploy order matters.** The worker and the site are deployed separately, and
the client only talks to the routes the deployed worker has. Deploy the worker
**first**, then push to `main`:

```bash
npm run leaderboard:deploy     # worker
git push origin main           # triggers the Pages deploy
```

**Every merge goes through an architect review of the diff.** This is a house
rule and it has earned its place — over three games it caught: flags being erased
by the cheat's own next submission; the joint board telling Andriy to split a
prize the tiebreaks had already decided; the car's steering being inverted; the
delivery waypoint pointing the wrong way at every heading but two; and a GPU leak
that would have degraded a session gradually and been blamed on the water.

**Simulate before trusting a difficulty curve — with a HUMAN in the sim.** Both
games with a skill ceiling have their rules in a file that imports no three.js,
precisely so play can be simulated: `site/fish/src/fish.js` and
`site/city/src/car.js`. The fishing fight and the delivery scoring were both
tuned against measured numbers, and in both cases the first version was wrong in
a way that eyeballing would not have caught. The bite taught the sharper lesson:
it WAS simulated — by a zero-latency policy — and certified 300-480ms hook
windows that the first human to ever play the game could not pass. A simulation
without reaction time in it certifies a player who does not exist; the
human-latency bite test in `fish.test.js` is the guard.

**Watch for tests that pass for the wrong reason.** Three separate times a test
was asserting something vacuous or measuring the wrong thing while looking
correct — `expect(hypot(...)).toBeGreaterThan(-1)`, a turning-radius helper that
dragged both cars to the same speed, and a tiebreak fixture whose totals differed
so much the tiebreaks never ran. If a test has never failed, check that it *can*.

### The blind spot that matters most

**An agent working on this cannot see the games.** The browser pane in these
sessions does not composite frames, so screenshots fail and the game loop has to
be driven manually by calling `_loop()` on an interval. Everything verifiable
this way — state, positions, scores, API responses, DOM — has been verified. What
cannot be verified is **what it looks like**.

That is exactly how CITY LIGHTS shipped opening at midnight with near-black roads
while every structural check passed. If you change anything visual, **ask Andriy
to look and screenshot it**. Do not report a visual change as verified.
