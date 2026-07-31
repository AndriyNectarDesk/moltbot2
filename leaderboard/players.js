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
	// Anything that isn't text is not a name: String({}) is "[object Object]",
	// which survives the character filter and would otherwise register a player
	// called "object object" from a JSON body with the wrong shape.
	if (typeof raw !== "string") return ""

	// Too long is truncated rather than refused: the input caps at 14 characters
	// anyway, so the only way here is a paste or a hand-made request, and a kid
	// who pastes their full name should get a short one, not an error.
	//
	// Truncation is by CODE POINT, not by .slice(). Emoji are already filtered
	// out, but astral letters are not, and cutting one in half leaves a lone
	// surrogate — two different names could then round-trip to the same bytes in
	// a KV key and end up sharing one credential record.
	//
	// Lowercase BEFORE the character filter, and this order is load-bearing. "İ"
	// lowercases to "i" plus a combining dot, which the filter would have stripped
	// — so filtering first made this function non-idempotent, and normalizing an
	// already-normalized id returned a DIFFERENT id. Everything downstream assumes
	// it doesn't: the dashboard's remove button hands back the id it was rendered
	// with, which would then resolve to a player who does not exist, report
	// success, and leave the real one on the board.
	const name = cut(
		raw
			.normalize("NFKC")
			.toLowerCase()
			.replace(/[^\p{L}\p{N} _\-.]/gu, "")
			.replace(/\s+/g, " ")
			.trim(),
	).trim()

	if (name.length < LIMITS.nameMin) return ""
	if (!/\p{L}/u.test(name)) return ""
	if (mixesScripts(name)) return ""
	return name
}

const cut = (s) => Array.from(s).slice(0, LIMITS.nameMax).join("")

/**
 * Reject a name that mixes writing systems.
 *
 * Cyrillic "о" and Latin "o" are different characters that render identically,
 * so `danylо` and `danylo` are two players, two board rows, and one of them is
 * pretending to be a kid on a board a cash prize is paid against. NFKC does not
 * fold these and shouldn't — they are genuinely different letters.
 *
 * Whole scripts are allowed, mixtures are not: "зоя" is a name someone in this
 * family might actually have, "danylо" is not a name anybody has.
 */
function mixesScripts(name) {
	const scripts = new Set()
	for (const ch of name) {
		if (!/\p{L}/u.test(ch)) continue
		if (/\p{Script=Latin}/u.test(ch)) scripts.add("latin")
		else if (/\p{Script=Cyrillic}/u.test(ch)) scripts.add("cyrillic")
		else if (/\p{Script=Greek}/u.test(ch)) scripts.add("greek")
		else scripts.add("other")
	}
	return scripts.size > 1
}

/** Why this PIN is no good, or null. Digits only — every keypad has those. */
export function pinProblem(pin) {
	return /^\d{4,8}$/.test(String(pin ?? "")) ? null : "PIN must be 4 to 8 digits"
}

// ---------------------------------------------------------------- registry

/**
 * One player record, or null.
 *
 * A banned record has no `pinHash` and is a valid shape: removing somebody has
 * to leave something behind, or the name is free again the moment they are
 * thrown off and the removal is a formality they undo in one tap.
 */
export async function readPlayer(env, id) {
	const key = PLAYER_KEY(id)
	const raw = await env.SCORES.get(key, "json")
	if (raw == null) return null
	if (raw.v !== 1) throw new PlayerShapeError(key)
	if (raw.banned === true) return raw
	if (typeof raw.pinHash !== "string") throw new PlayerShapeError(key)
	return raw
}

export async function readIndex(env) {
	const raw = await env.SCORES.get(INDEX_KEY, "json")
	if (raw == null) return { v: 1, players: [], banned: [] }
	if (raw.v !== 1 || !Array.isArray(raw.players)) throw new PlayerShapeError(INDEX_KEY)
	// `banned` arrived after `players`, so an index written by the first version
	// of this code is missing it. Absent is empty here — unlike a wrong shape,
	// which still throws.
	if (raw.banned !== undefined && !Array.isArray(raw.banned)) throw new PlayerShapeError(INDEX_KEY)
	return { ...raw, banned: raw.banned || [] }
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

/**
 * Throw a player off, leaving a tombstone in place of their record.
 *
 * The tombstone is the point. Deleting outright frees the name, and the person
 * you just removed re-registers it in one tap with the same PIN — which would
 * make the dashboard's only enforcement action a suggestion. `restorePlayer`
 * lifts it.
 *
 * A record too corrupt to read is still removed: deleting a bad value is not the
 * same bet as overwriting one, and the player you most need to remove must not
 * be the one you cannot.
 */
export async function removePlayer(env, id, at) {
	let existed = false
	try {
		existed = (await readPlayer(env, id)) !== null
	} catch (err) {
		if (!(err instanceof PlayerShapeError)) throw err
		existed = true
	}

	const index = await readIndex(env)
	const listed = index.players.some((p) => p.id === id)
	index.players = index.players.filter((p) => p.id !== id)
	if (!index.banned.some((b) => b.id === id)) index.banned.push({ id, at })
	index.banned.sort((a, b) => a.id.localeCompare(b.id))

	await env.SCORES.put(PLAYER_KEY(id), JSON.stringify({ v: 1, id, banned: true, at }))
	await env.SCORES.put(INDEX_KEY, JSON.stringify(index))
	return existed || listed
}

/**
 * Throw off every self-registered player who signed up before `before`.
 *
 * The recovery path for a squat: the registry holds 60 names and one address can
 * fill it in about an hour, at which point the next real friend is told the
 * arcade is full. Doing that one row at a time through the dashboard is not a
 * recovery, it is an evening. `before` exists so a squat can be cleared without
 * throwing off the friends who signed up legitimately after it.
 *
 * Returns the ids removed. One index write, one tombstone per player.
 */
export async function purgePlayers(env, { before, at }) {
	const index = await readIndex(env)
	const doomed = index.players.filter((p) => !Number.isFinite(before) || p.at < before)
	if (!doomed.length) return []

	index.players = index.players.filter((p) => !doomed.includes(p))
	for (const p of doomed) {
		if (!index.banned.some((b) => b.id === p.id)) index.banned.push({ id: p.id, at })
	}
	index.banned.sort((a, b) => a.id.localeCompare(b.id))

	for (const p of doomed) {
		await env.SCORES.put(PLAYER_KEY(p.id), JSON.stringify({ v: 1, id: p.id, banned: true, at }))
	}
	await env.SCORES.put(INDEX_KEY, JSON.stringify(index))
	return doomed.map((p) => p.id)
}

/** Lift a ban, freeing the name for anyone — including whoever had it before. */
export async function restorePlayer(env, id) {
	const index = await readIndex(env)
	const wasBanned = index.banned.some((b) => b.id === id)
	if (!wasBanned) return false
	index.banned = index.banned.filter((b) => b.id !== id)
	await env.SCORES.delete(PLAYER_KEY(id))
	await env.SCORES.put(INDEX_KEY, JSON.stringify(index))
	return true
}

/**
 * Ask the edge whether this address has any budget left.
 *
 * `bucket` separates the counters, so somebody guessing PINs at the score
 * endpoint cannot also jam the signup form for the friend sitting next to them.
 *
 * Fails open when the binding is absent — that is `wrangler dev` without the
 * binding, and the tests. It also fails open with no client IP, which is safe
 * only because Cloudflare sets that header at the edge and a client cannot
 * suppress it; off Cloudflare this function is not a control at all.
 */
export async function throttle(env, request, bucket) {
	if (!env.LIMITER) return null
	const ip = request.headers.get("CF-Connecting-IP") || ""
	if (!ip) return null
	try {
		const { success } = await env.LIMITER.limit({ key: `${bucket}:${ip}` })
		return success ? null : "too many tries — wait a minute"
	} catch {
		// The binding is a beta product and throwing is its likeliest failure. An
		// uncaught error here escapes as a 1101 on every signup and every failed
		// sign-in — a throttle that turns into an outage is worse than no throttle,
		// and this is the case the paragraph above claimed to cover but didn't.
		return null
	}
}
