// Who is allowed on the board.
//
// Two kinds of player, and they are deliberately equal once they exist:
//
//   family  the three kids, in the PLAYERS secret. Andriy sets their PINs by
//           hand and nothing here can create, rename or remove one.
//   open    everyone else — the friends the kids bring home. They register
//           themselves from the game-over screen and land in KV.
//
// An open player counts for prize points and for the joint board exactly like a
// kid does. That was asked for explicitly: the friends are meant to compete for
// the same cash, not for a consolation board. The consequences are real and are
// spelled out in ARCADE.md — signup is open to anyone who finds the URL, so the
// dashboard marks which players registered themselves and can remove one.
//
// This file owns the KV registry and the naming rules. It is the only place
// that decides what a player id may look like, because that id is what appears
// on a board that money is paid against.

export const RESERVED = new Set(["guest", "anon", "admin", "player", "nobody", "you"])

export const LIMITS = {
	nameMin: 2,
	nameMax: 14,
	// A ceiling on self-registration, so a bored stranger with a loop cannot turn
	// the registry into an unbounded KV bill. 60 is far more friends than three
	// kids will ever bring home, and it is raised by editing this line.
	maxOpenPlayers: 60,
	// PIN brute force: /join is a 4-digit guess oracle, so it is throttled per
	// IP. Ten tries per ten minutes leaves a typo-prone kid alone and makes
	// walking 10,000 PINs take about two weeks.
	joinTriesPerWindow: 10,
	joinWindowSecs: 600,
}

const PLAYER_KEY = (id) => `player:${id}`
const INDEX_KEY = "players:index"

/**
 * A stored value that isn't the shape we wrote.
 *
 * Same discipline as the boards: absent and corrupt are different outcomes, and
 * a corrupt registry must not read as "no players" and then get overwritten —
 * that would silently un-register everyone mid-week and free their names for
 * anyone to claim.
 */
export class PlayerShapeError extends Error {
	constructor(key) {
		super(`stored value at ${key} is not a player record`)
		this.key = key
	}
}

/**
 * The one rule for what a player id may be.
 *
 * Returns "" for anything unusable, so callers test the result rather than
 * remembering a list of conditions. Lowercase because the board is keyed on this
 * string and "Zoe" and "zoe" must not be two players; a letter is required
 * because an all-digit name renders as a score in the tables.
 *
 * `site/shared/leaderboard.js` carries a copy of this for instant feedback while
 * typing — the two are kept in step by the same case table in both test files.
 * The client's copy is a courtesy; this one is the authority.
 */
export function normalizeName(raw) {
	// Too long is truncated rather than refused: the input caps at 14 characters
	// anyway, so the only way here is a paste or a hand-made request, and a kid
	// who pastes their full name should get a short one, not an error.
	// Anything that isn't text is not a name: String({}) is "[object Object]",
	// which survives the character filter and would otherwise register a player
	// called "object object" from a JSON body with the wrong shape.
	if (typeof raw !== "string") return ""
	const name = raw
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N} _\-.]/gu, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, LIMITS.nameMax)
		.toLowerCase()
		.slice(0, LIMITS.nameMax)
		.trim()
	if (name.length < LIMITS.nameMin) return ""
	if (!/\p{L}/u.test(name)) return ""
	return name
}

/** Why this PIN is no good, or null. Digits only — every keypad has those. */
export function pinProblem(pin) {
	return /^\d{4,8}$/.test(String(pin ?? "")) ? null : "PIN must be 4 to 8 digits"
}

// ---------------------------------------------------------------- registry

export async function readPlayer(env, id) {
	const key = PLAYER_KEY(id)
	const raw = await env.SCORES.get(key, "json")
	if (raw == null) return null
	if (raw.v !== 1 || typeof raw.pinHash !== "string") throw new PlayerShapeError(key)
	return raw
}

export async function readIndex(env) {
	const raw = await env.SCORES.get(INDEX_KEY, "json")
	if (raw == null) return { v: 1, players: [] }
	if (raw.v !== 1 || !Array.isArray(raw.players)) throw new PlayerShapeError(INDEX_KEY)
	return raw
}

/**
 * Create an open player.
 *
 * The caller has already established that the name is free — this re-checks the
 * ceiling only. The record is written before the index because the record is
 * what authenticates: if the second write fails, the account works and is merely
 * missing from the dashboard list, which `touchIndex` repairs on the next join.
 * The other order would hand out a name that cannot be used.
 */
export async function registerPlayer(env, { id, pinHash, at }) {
	const index = await readIndex(env)
	if (index.players.length >= LIMITS.maxOpenPlayers) {
		return { error: "the arcade is full — ask Andriy to make room", status: 409 }
	}
	await env.SCORES.put(PLAYER_KEY(id), JSON.stringify({ v: 1, id, pinHash, createdAt: at, kind: "open" }))
	index.players.push({ id, at })
	index.players.sort((a, b) => a.id.localeCompare(b.id))
	await env.SCORES.put(INDEX_KEY, JSON.stringify(index))
	return { ok: true }
}

/** Put a registered player back in the listing if a half-finished signup lost them. */
export async function touchIndex(env, id, at) {
	const index = await readIndex(env)
	if (index.players.some((p) => p.id === id)) return false
	index.players.push({ id, at })
	index.players.sort((a, b) => a.id.localeCompare(b.id))
	await env.SCORES.put(INDEX_KEY, JSON.stringify(index))
	return true
}

/** Delete an open player. Their past scores are a separate decision — see the worker. */
export async function removePlayer(env, id) {
	const record = await readPlayer(env, id)
	const index = await readIndex(env)
	const before = index.players.length
	index.players = index.players.filter((p) => p.id !== id)
	if (record) await env.SCORES.delete(PLAYER_KEY(id))
	if (index.players.length !== before) await env.SCORES.put(INDEX_KEY, JSON.stringify(index))
	return Boolean(record) || index.players.length !== before
}

/**
 * Count a signup attempt against this IP's budget.
 *
 * Returns a message when the budget is spent. Fails open with no IP header —
 * that is the local and test case, and the alternative is a worker that cannot
 * be exercised at all off Cloudflare.
 */
export async function joinThrottle(env, request) {
	const ip = request.headers.get("CF-Connecting-IP") || ""
	if (!ip) return null
	const key = `join:${ip}`
	const tries = Number(await env.SCORES.get(key)) || 0
	if (tries >= LIMITS.joinTriesPerWindow) return "too many tries — wait a few minutes"
	await env.SCORES.put(key, String(tries + 1), { expirationTtl: LIMITS.joinWindowSecs })
	return null
}
