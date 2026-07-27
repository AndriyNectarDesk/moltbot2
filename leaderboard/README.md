# Leaderboard API

A ~150-line Cloudflare Worker backing the shared score table for
[DANYLO: NECTAR NOVA](../game). Free tier covers this comfortably — KV allows
100k reads and 1k writes a day, and a leaderboard for friends will not come
close.

Until this is deployed the game still has a leaderboard; it just lives in the
browser's localStorage and isn't shared with anyone.

## Deploy (about two minutes)

From the repository root:

```bash
# 1. Log in to Cloudflare (opens a browser once)
npx wrangler login

# 2. Create the KV namespace that holds the board
npx wrangler kv namespace create SCORES --config leaderboard/wrangler.jsonc
```

That prints an `id`. Paste it into `leaderboard/wrangler.jsonc`, replacing
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID`, then:

```bash
# 3. Ship it
npx wrangler deploy --config leaderboard/wrangler.jsonc
```

Wrangler prints a URL like `https://nectar-nova-scores.<you>.workers.dev`. Put
it in [`game/config.js`](../game/config.js):

```js
export const LEADERBOARD_URL = "https://nectar-nova-scores.<you>.workers.dev"
```

Commit and push — the Pages workflow redeploys the game and the board goes
shared.

## API

| Route | Purpose |
| --- | --- |
| `GET /top?limit=20` | `{ entries: [{name, score, wave, kills, combo, at}], total }` |
| `POST /score` | Body `{name, score, wave, kills, combo}` → `{rank, improved, entries}` |

One row per name: submitting again only replaces your row if the new score is
higher, so the table reads as "who is best" rather than "who played most".

## Honest limits

**Scores are not verifiable.** The game runs entirely in the player's browser,
so anyone who opens the devtools console can post any number they like. The
worker rejects obvious nonsense — negative values, a combo above the game's max
of 8, a score wildly out of proportion to the wave reached — and rate-limits to
12 submissions per IP per minute. That stops accidents and idle mischief, not a
determined kid with a console. For a leaderboard among friends that is usually
the right trade; making it actually cheat-proof means running the simulation
server-side, which is a different and much larger project.

**Concurrent writes can collide.** The board is one KV value that gets read,
merged and written back, so two runs finishing in the same instant can lose one
of the two. At this scale that is vanishingly rare. If it ever matters, move the
board into a Durable Object, which serialises writes.

**Anyone can read it**, and the API is open to any origin by default. Set
`ALLOWED_ORIGINS` in `wrangler.jsonc` to restrict which sites may call it —
though since the game is public, that is a speed bump rather than a lock.
