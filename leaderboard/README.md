# Leaderboard API

A small Cloudflare Worker backing the weekly score boards for the three games in
[`site/`](../site). Each game gets its own board that resets every week, and a
joint board sums prize points across all three.

Free tier covers this comfortably. KV allows 100k reads and 1k writes a day, and
an accepted submission costs exactly one write, and nothing else on the hot path
writes at all — the signup throttle is an edge rate-limit binding precisely so it
does not.

Be honest about the ceiling, though: 63 players × 3 games × 50 accepted runs is
9,450 writes a week against a free budget of 7,000. Real play is nowhere near
that — a kid posts a handful of improvements a week, not fifty — but a full
registry all playing flat out would exceed it, and `LIMITS.maxOpenPlayers` in
`players.js` is the dial. Raising it moves that ceiling proportionally.

| File | What it is |
| --- | --- |
| `worker.js` | routes, storage, identity, the dashboard mount |
| `players.js` | who may post: the naming rules, the self-signup registry, the throttle |
| `week.js` | week boundaries (pure) |
| `games.js` | the game registry, prize points, validation limits |
| `scoring.js` | ranking, places, joint standings (pure) |
| `admin.js` | the dad-facing dashboard HTML |

## Deploy

```bash
npx wrangler login

npx wrangler kv namespace create SCORES --config leaderboard/wrangler.jsonc
# paste the printed id into wrangler.jsonc
```

Then set the two secrets. `PLAYERS` is the **family** roster only — the three
kids — mapping a player id to the **SHA-256 hex of their PIN**; the PIN itself is
never stored. Everyone else signs themselves up at `POST /join` and lands in KV,
so they never appear here:

```bash
node -e "console.log(require('crypto').createHash('sha256').update('1234').digest('hex'))"

npx wrangler secret put PLAYERS --config leaderboard/wrangler.jsonc
# {"danylo":"<hash>","mike":"<hash>","sofia":"<hash>"}

npx wrangler secret put DASHBOARD_PASSWORD --config leaderboard/wrangler.jsonc
```

The rate-limit binding in `wrangler.jsonc` needs no setup — the namespace id is
just a number you pick, and it is created on deploy. Without it the throttle
fails open, which is what happens under `wrangler dev` and in the tests.

```bash
npm run leaderboard:deploy
```

Put the printed URL in [`site/shared/config.js`](../site/shared/config.js) as
`LEADERBOARD_URL`, without a trailing slash.

## API

| Route | Purpose |
| --- | --- |
| `GET /games` | `{ games: [{id, label}], week }` |
| `GET /g/:game/top?week=current&limit=20` | this week's board for one game |
| `POST /g/:game/score` | body `{player, pin, score, stats, durationMs?}` → `{improved, rank, points, entries}` |
| `POST /join` | body `{player, pin}` → claim a name, or sign back in to one you own |
| `GET /joint?week=current` | joint standings plus each game's places |
| `GET /week/:monday` | the frozen snapshot of a closed week — public, so a kid can check the maths |
| `GET /admin` | the dashboard (Basic auth) |
| `POST /admin/close` | freeze a week, return a payout proposal |
| `POST /admin/payout` | write down a payment that was made |
| `GET /admin/history` | closed weeks and payouts |
| `GET /admin/players` | family vs. self-registered, and how many slots are left |
| `POST /admin/player/remove` | body `{player, week}` → hold the name, delete the account, clear their scores for that week |
| `POST /admin/players/purge` | body `{week, before?}` → the same for every self-registered player, or everyone who signed up before `before` |
| `POST /admin/player/restore` | body `{player}` → lift a hold, freeing the name |

`stats` is a free-form bag per game — the shooter sends `{wave, kills, combo}`,
fishing sends `{landed, heaviest, species, flow}`. Each game declares its own
fields in `games.js`, so adding a game needs no changes here.

One row per player per game per week: submitting again only replaces your row if
the new score is higher, so a board reads as "who is best this week" rather than
"who played most".

## Weeks

Monday 00:00 to Sunday 23:59:59.999, `America/Toronto`. The week is stamped when
a score is written and forms part of its key, so a submission belongs
permanently to one week — the standings can never change depending on when you
look at them.

Monday is not only convention: Toronto's clock changes happen on Sundays, so a
Monday boundary never lands on one.

Closing a week writes `week:<monday>:final` once. That snapshot embeds **the
rules that were in force** and **every qualifying entry**, so changing the point
table later can't rewrite history and the arithmetic can always be re-derived.
After a close, scores for that week are rejected with a 409 rather than silently
dropped.

## Prize points

Per game, per week: 1st = 10, 2nd = 6, 3rd = 3, and any qualifying run = 1
(stacking). The joint board is the sum across the three games, so playing a
sibling's game is worth doing.

**If fewer than two players posted a qualifying run in a game that week, that
game awards participation points only.** Each kid owns a game and will play it
most, so without this rule the normal outcome is one kid posting alone in their
own game and collecting 10 points for showing up.

Joint ties break on: most wins, then most games played, then earliest last
qualifying run. Still level after that is a real tie and the prize gets split by
hand.

## Who may play

Two registries, and once a player exists they are treated identically — same
board, same prize points, same joint standings.

- **family** — the three kids, in the `PLAYERS` secret. Their names always exist
  and cannot be claimed by anyone else, because the secret is checked first.
- **open** — everyone else. A friend types a name and a PIN on the game-over
  screen, `POST /join` creates them in KV, and they are playing for the same cash
  as the kids. This was an explicit decision, not a default.

`POST /join` both creates and signs in: a wrong PIN on a name that exists reads
exactly like any other refusal. So does every refusal at `POST /g/:game/score` —
that endpoint told the two apart for a while, which made the care taken at
`/join` worth nothing. Both are throttled per IP at the edge, on separate
budgets. Names are capped at `maxOpenPlayers`, reserved words like `guest` are
refused, and a name mixing writing systems is refused outright, because a
Cyrillic `о` next to Latin letters is an impersonation and nothing else.

A 4-digit PIN is still not a secret and throttling does not make it one. See
"Honest limits".

**Signup is open to the internet.** Anyone with the URL can register, which means
someone unknown could end up in a payout proposal. What stands against that:

- Everyone who isn't in the secret is marked `visitor` — on the dashboard, on the
  hub, and in the boards the games show the kids.
- The Players section removes one, or clears every self-signup at once. Removing
  holds the name against re-registration; "allow again" lifts that.
- A week that has already been closed keeps whatever it froze. Frozen history is
  not editable, deliberately, so a removal can never rewrite a payout.

## Honest limits

**Scores cannot be verified, and never will be here.** The games are JavaScript
on the player's own machine, and `site/nova` deliberately exposes `window.game`
so a kid can poke at it in devtools. Making this genuinely cheat-proof means
simulating each game server-side, which is a much larger project and would
destroy what makes these games good to tinker with.

What is done instead:

- **Submissions are attributed.** A PIN means nobody can post under another
  player's name or overwrite their row. A four-digit PIN between kids who share
  a house is weak — one will watch another type it — so understand what it buys:
  not secrecy, but accountability by default. It turns impersonation from an
  accident into a deliberate act.
- **Anomalies are flagged, never rejected.** A score more than 5× the player's
  own previous best, more than 40 accepted runs in a week, a score that
  contradicts its own claimed duration, or one beyond the game's plausibility
  curve all show up on the dashboard. None of them block a submission — stopping
  a genuinely spectacular run would punish the thing we want happening.
- **No code pays anyone.** `close` produces a proposal; recording a payout is a
  separate deliberate action, and handing over the actual cash is a human one.
- **Say it out loud.** Telling the kids once that submission counts, timestamps
  and score jumps are all visible does more than any detector, and costs nothing.

Note that **prize points are not an anti-cheat measure**, even though bounding
them looks like one. With three kids and three games the whole contest turns on a
few points, so a capped 10 is still a large share of the spread — and capping it
makes the cheapest attack "beat my sibling by one", which is quieter and harder
to notice than an absurd number. Points exist because scores from different
games aren't comparable. The defence is the dashboard and a human.

**`ALLOWED_ORIGINS` does not restrict who can call the API.** It only chooses the
`Access-Control-Allow-Origin` response header. A request from any other origin
still succeeds and is still written; it just gets a header its browser will
refuse to read. `curl` sends no `Origin` at all and is unaffected entirely. The
gate on writing is the PIN. The variable is worth setting as a speed bump for
casual browser-based mischief, and nothing more.

**Concurrent writes can still collide,** but the window is much narrower than it
was: boards are per game and per week, so a clash now needs two kids submitting
to *the same game* within the same instant. If it ever actually happens, move the
board into a Durable Object — `readBoard` and `writeBoard` are the only two
functions that touch storage, so that migration is contained. SQLite-backed
Durable Objects are available on the free plan, so this is a complexity decision
rather than a cost one.

## Tests

```bash
npm test
```

124 tests across the week maths, the points maths, the worker, and the browser
client. `week.js` and `scoring.js` are pure and tested directly, which is where
most of the payout risk lives. The KV mock honours `put` expiry and counts
writes, so "one write per accepted submission, none for a non-improvement" is
asserted rather than assumed. Tests pin the clock with `env.__NOW`.
