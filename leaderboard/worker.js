// Family arcade — leaderboard API.
//
// Backs three games with a per-game weekly board each, plus a joint board that
// sums prize points across them. A weekly cash prize rides on this, which
// drives three decisions worth stating up front:
//
//  1. Every submission is stamped with its week AT WRITE TIME and lives under a
//     per-game, per-week key. Closing a week freezes it into an immutable
//     snapshot that embeds the rules in force and every underlying entry, so a
//     payout can be re-checked — by a kid, without asking — at /week/<monday>.
//
//  2. Scores still cannot be verified. The games are JavaScript on the player's
//     own machine and deliberately expose `window.game` so a kid can poke at
//     them. Nothing here pretends otherwise: submissions are attributed (a
//     roster PIN, so nobody can post as their sibling), anomalies are flagged
//     for a human to look at, and no code ever pays anyone.
//
//  3. One write per accepted submission. The board row carries its own rate
//     state and the joint board is computed on read, so there is no separate
//     counter key and no single hot key that every game writes to. v1's rate
//     limiter wrote on every request, which could exhaust the free tier's
//     1k writes/day in about ninety minutes.
//
// Reads are still read-modify-write on one value per game-week, so two runs
// finishing in the same instant in the SAME game could still lose one. That is
// now a much narrower window than v1's single global key, and the fix if it ever
// bites is a Durable Object behind readBoard/writeBoard — the only two functions
// that touch storage.

import { EYEBROW, FLAGS, GAME_IDS, GAMES, POINTS, RATE, cleanStats, validate } from "./games.js"
import { gameStandings, jointStandings, payoutProposal, rankEntries } from "./scoring.js"
import {
	LIMITS,
	PlayerShapeError,
	RESERVED,
	normalizeName,
	pinProblem,
	purgePlayers,
	readIndex,
	readPlayer,
	registerPlayer,
	removePlayer,
	restorePlayer,
	throttle,
	touchIndex,
} from "./players.js"
import { isWeekKey, nextWeek, weekHasEnded, weekKey } from "./week.js"
import { renderAdmin } from "./admin.js"

const MAX_ENTRIES = 100
const MAX_RETURN = 50

// ---------------------------------------------------------------- plumbing

const cors = (origin) => ({
	"Access-Control-Allow-Origin": origin || "*",
	"Access-Control-Allow-Methods": "GET,POST,OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
	"Access-Control-Max-Age": "86400",
	Vary: "Origin",
})

const json = (body, status, origin) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...cors(origin) },
	})

/**
 * Pick the Access-Control-Allow-Origin value.
 *
 * Worth being clear about what this does and doesn't do: it only sets a
 * response header. It does NOT block anything — a disallowed origin still gets
 * a 200, and curl, which sends no Origin at all, is unaffected entirely. The
 * gate on writing is the PIN, not this.
 */
function resolveOrigin(request, env) {
	const origin = request.headers.get("Origin")
	if (!env.ALLOWED_ORIGINS) return origin || "*"
	const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
	return allowed.includes(origin) ? origin : allowed[0]
}

/** Tests set env.__NOW to pin the clock; production never has it. */
const nowMs = (env) => Number(env.__NOW) || Date.now()

async function sha256hex(s) {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)))
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

function timingSafeEqual(a, b) {
	if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
	return diff === 0
}

// ---------------------------------------------------------------- storage

class BoardShapeError extends Error {
	constructor(key) {
		super(`stored value at ${key} is not a v2 board`)
		this.key = key
	}
}

const boardKey = (game, week) => `wk:${game}:${week}`
const finalKey = (week) => `week:${week}:final`

/**
 * Read one game-week board.
 *
 * Absent and corrupt must be different outcomes. v1 did
 * `Array.isArray(raw) ? raw : []`, so a wrong-shaped value looked exactly like
 * an empty board — which, with a prize attached, would silently erase a week's
 * standings and then overwrite them. A bad shape is a 500 and refuses to write.
 */
async function readBoard(env, game, week) {
	const key = boardKey(game, week)
	const raw = await env.SCORES.get(key, "json")
	if (raw == null) return { v: 2, game, week, entries: [] }
	if (raw.v !== 2 || !Array.isArray(raw.entries)) throw new BoardShapeError(key)
	return raw
}

async function writeBoard(env, board) {
	await env.SCORES.put(boardKey(board.game, board.week), JSON.stringify(board))
}

/**
 * Read a non-board JSON value, with the same absent-vs-corrupt discipline.
 *
 * `ok` validates the shape. Same reasoning as readBoard: silently substituting a
 * fallback for a corrupt value and then writing over it is how a week's payout
 * log or closed-week index would quietly disappear.
 */
async function readJson(env, key, fallback, ok) {
	const raw = await env.SCORES.get(key, "json")
	if (raw == null) return fallback
	if (ok && !ok(raw)) throw new BoardShapeError(key)
	return raw
}

const isWeekIndex = (v) => v && Array.isArray(v.weeks)
const isPayoutLog = (v) => v && Array.isArray(v.items)

/** Every game's entries for one week, for the joint board. */
async function readAllBoards(env, week) {
	const boards = {}
	for (const id of GAME_IDS) boards[id] = (await readBoard(env, id, week)).entries
	return boards
}

// ---------------------------------------------------------------- identity

/**
 * A PLAYERS secret that cannot be trusted.
 *
 * Its own error type because every read path used to paper over the null with
 * `|| {}`, which is worse than the 500 it was trying to avoid: an empty family
 * means every kid is served `visitor: true` on the boards they actually look at,
 * and the dashboard lists no family at all. Silently telling Danylo he is a
 * stranger is the exact outcome the refusal exists to prevent.
 */
export class RosterError extends Error {
	constructor() {
		super("PLAYERS secret is not a map of normalized player ids")
	}
}

/**
 * The family roster from the secret, or null if it cannot be trusted.
 *
 * The keys are put through `normalizeName` and must survive it unchanged. That
 * looks pedantic until you follow what a stray capital does: `{"Danylo": ...}`
 * matches no normalized id, so Danylo's own correct PIN stops signing him in as
 * family and instead REGISTERS HIM as an ordinary self-signup — after which his
 * name is a KV row anyone can be handed once it's removed. ARCADE.md asks for
 * this JSON to be hand-typed to rotate the placeholder PINs, so the typo has a
 * moment scheduled for it. Refusing to serve is the only safe answer: a 500 gets
 * looked at, a silently demoted kid does not.
 */
function familyRoster(env) {
	let parsed
	try {
		parsed = JSON.parse(env.PLAYERS || "{}")
	} catch {
		return null
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
	for (const key of Object.keys(parsed)) {
		if (normalizeName(key) !== key) return null
	}
	return parsed
}

/**
 * Who is submitting.
 *
 * Two registries, checked in that order. PLAYERS is a secret Andriy controls:
 * { "danylo": "<sha256 of pin>", ... }. Everyone else is looked up in KV, where
 * they put themselves via /join. A family name can therefore never be claimed by
 * a stranger — the secret is consulted first and /join refuses to create over it.
 *
 * A four-digit PIN between siblings who share a house is weak — one of them will
 * watch another type it. Its job isn't secrecy, it's attribution: it turns
 * posting as your brother from an accident (wrong name picked on a shared
 * device) into something you have to decide to do. For a visiting friend it does
 * one more thing: it stops the next visitor from posting onto their row.
 */
async function authPlayer(env, body) {
	const roster = familyRoster(env)
	if (!roster) return { error: "server roster misconfigured", status: 500 }

	// One refusal for every way of failing. Telling "unknown player" apart from
	// "wrong pin" turns this endpoint into a free test for whether a name has an
	// account — which is exactly the question /join is careful not to answer, so
	// answering it here would have made that care decorative. The wording keeps
	// the word "pin" because all three games key their WRONG PIN message on it.
	const refused = { error: "wrong player or pin", status: 403 }

	const player = normalizeName(body.player)
	if (!player) return refused
	const got = await sha256hex(body.pin || "")

	const want = roster[player]
	if (want) {
		if (!timingSafeEqual(got, String(want).toLowerCase())) return refused
		return { player, kind: "family" }
	}

	const record = await readPlayer(env, player)
	if (!record || record.banned || typeof record.pinHash !== "string") return refused
	if (!timingSafeEqual(got, String(record.pinHash).toLowerCase())) return refused
	return { player, kind: "open" }
}

/**
 * Claim a name, or prove you already own it.
 *
 * One route for both because from the player's side they are one act — you type
 * your name and your PIN and you are in. A friend on a new device, or after
 * clearing their browser, takes the same path they took the first time and it
 * just works. `created` tells the client which of the two happened so it can say
 * so, but nothing depends on it.
 *
 * A wrong PIN on an existing name is deliberately indistinguishable from any
 * other refusal to claim it: "that name is taken" either way, so this cannot be
 * used to enumerate who has an account.
 */
async function handleJoin(request, env, origin) {
	let body
	try {
		body = await request.json()
	} catch {
		return json({ error: "invalid JSON" }, 400, origin)
	}

	const player = normalizeName(body.player)
	if (!player) {
		return json(
			{ error: `pick a name: ${LIMITS.nameMin}–${LIMITS.nameMax} characters, at least one letter` },
			400,
			origin,
		)
	}
	if (RESERVED.has(player)) return json({ error: "that name is reserved — pick another" }, 400, origin)
	const badPin = pinProblem(body.pin)
	if (badPin) return json({ error: badPin }, 400, origin)

	const roster = familyRoster(env)
	if (!roster) return json({ error: "server roster misconfigured" }, 500, origin)

	// Before either lookup, so a guesser's failures cost nothing but the check.
	const limited = await throttle(env, request, "join")
	if (limited) return json({ error: limited }, 429, origin)

	const hash = await sha256hex(body.pin)
	const taken = { error: "that name is taken — if it's yours, check the PIN", status: 403 }

	const family = roster[player]
	if (family) {
		if (!timingSafeEqual(hash, String(family).toLowerCase())) return json({ error: taken.error }, taken.status, origin)
		return json({ ok: true, player, created: false, kind: "family" }, 200, origin)
	}

	const existing = await readPlayer(env, player)
	if (existing) {
		// A tombstone is a name that was thrown off the board. It refuses like any
		// other taken name, so being removed is not something you undo by typing
		// the same two things again.
		if (existing.banned || !timingSafeEqual(hash, String(existing.pinHash).toLowerCase())) {
			return json({ error: taken.error }, taken.status, origin)
		}
		// Repairs a signup whose index write didn't land; a no-op otherwise.
		await touchIndex(env, player, existing.createdAt || nowMs(env))
		return json({ ok: true, player, created: false, kind: "open" }, 200, origin)
	}

	const made = await registerPlayer(env, { id: player, pinHash: hash, at: nowMs(env) })
	if (made.error) return json({ error: made.error }, made.status, origin)
	return json({ ok: true, player, created: true, kind: "open" }, 200, origin)
}

// ---------------------------------------------------------------- projections

/**
 * The three names that came from the secret. Everyone else is a visitor.
 *
 * Throws rather than returning an empty set: "we don't know who the family are"
 * and "there is no family" have to be different answers, or a mis-typed secret
 * quietly badges all three kids as visitors.
 */
function familyNames(env) {
	const roster = familyRoster(env)
	if (!roster) throw new RosterError()
	return new Set(Object.keys(roster))
}

/**
 * What a player is allowed to see. Flags and rate state are for the dashboard only.
 *
 * `visitor` is public on purpose. The dashboard has marked non-family players
 * since open signup shipped, but the kids never see the dashboard — they see
 * these tables, and a name is not proof of who somebody is. Two rows reading
 * DANYLO, one of them a visitor, is a fact the kids should be able to see
 * without asking their dad to log in.
 */
const publicEntry = (family) => (e) => ({
	player: e.player,
	score: e.score,
	at: e.at,
	stats: e.stats,
	visitor: !family.has(e.player),
})

/**
 * Kinds where the value names a distinct thing rather than measuring one.
 *
 * `jump:8.2x` and `jump:100.0x` are the same signal re-measured, so only the
 * latest is worth keeping. `maxed:wave` and `maxed:combo` are different facts and
 * must both survive — collapsing them by kind would report only one maxed stat.
 */
const MULTI_VALUE_FLAGS = new Set(["maxed"])

/**
 * Union of flags already on the row and the ones this submission raised, keeping
 * one per kind so a re-measured signal doesn't grow without bound. Once a flag is
 * raised it stays raised for the week — see the entry construction below.
 */
function mergeFlags(previous = [], added = []) {
	const seen = new Map()
	for (const flag of [...(previous || []), ...added]) {
		const kind = String(flag).split(":")[0]
		seen.set(MULTI_VALUE_FLAGS.has(kind) ? String(flag) : kind, flag)
	}
	return [...seen.values()]
}

// ---------------------------------------------------------------- routes

async function handleTop(env, origin, gameId, url) {
	const week = url.searchParams.get("week") || "current"
	const resolved = week === "current" ? weekKey(nowMs(env)) : week
	if (!isWeekKey(resolved)) return json({ error: "bad week" }, 400, origin)

	const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), MAX_RETURN)
	const board = await readBoard(env, gameId, resolved)
	const ranked = rankEntries(board.entries)
	return json(
		{
			game: gameId,
			label: GAMES[gameId].label,
			week: resolved,
			entries: ranked.slice(0, limit).map(publicEntry(familyNames(env))),
			total: ranked.length,
		},
		200,
		origin,
	)
}

async function handleScore(request, env, origin, gameId) {
	const game = GAMES[gameId]

	let body
	try {
		body = await request.json()
	} catch {
		return json({ error: "invalid JSON" }, 400, origin)
	}

	const auth = await authPlayer(env, body)
	if (auth.error) {
		// The PIN is the only real gate on writing, and this endpoint is the one
		// an attacker would walk it at — /join's throttle is worth nothing if the
		// same guesses are free here. Only failures are charged, so an honest
		// player never meets this and an accepted submission still costs one write.
		const limited = await throttle(env, request, "auth")
		if (limited) return json({ error: limited }, 429, origin)
		return json({ error: auth.error }, auth.status, origin)
	}

	const problem = validate(game, body)
	if (problem) return json({ error: problem }, 400, origin)

	const now = nowMs(env)
	const week = weekKey(now)

	// A closed week is history. Say so rather than silently dropping the score.
	const closed = await env.SCORES.get(finalKey(week))
	if (closed) return json({ error: "this week is closed", week }, 409, origin)

	const score = Math.round(Number(body.score))
	const stats = cleanStats(game, body.stats)

	const board = await readBoard(env, gameId, week)
	const prevIndex = board.entries.findIndex((e) => e.player === auth.player)
	const prev = prevIndex === -1 ? null : board.entries[prevIndex]

	// One row per player: the board reads as "who is best this week", not "who
	// played most". Not beating your own best costs a read and nothing else —
	// no write, and it doesn't burn the cooldown either.
	if (prev && prev.score >= score) {
		const ranked = rankEntries(board.entries)
		return json(
			{
				ok: true,
				improved: false,
				week,
				rank: ranked.findIndex((e) => e.player === auth.player) + 1,
				points: pointsFor(gameId, ranked, auth.player),
				entries: ranked.slice(0, MAX_RETURN).map(publicEntry(familyNames(env))),
			},
			200,
			origin,
		)
	}

	// Rate limiting lives on the player's own row, so it costs no extra key and
	// is per-player rather than per-IP — three kids on one home wifi no longer
	// share a budget, and it can't fail open when a header is missing.
	if (prev && now - (prev.lastAcceptedAt || 0) < RATE.cooldownMs) {
		return json({ error: "slow down a moment" }, 429, origin)
	}
	if (prev && (prev.runs || 0) >= RATE.maxAcceptedPerWeek) {
		return json({ error: "weekly submission cap reached" }, 429, origin)
	}

	// Flags are for the dashboard. They never reject a score and never appear in
	// the player's response: blocking a genuinely spectacular run would punish
	// exactly the thing we want the kids doing.
	const added = []
	if (prev && prev.score > 0 && score / prev.score >= FLAGS.scoreJump) {
		added.push(`jump:${(score / prev.score).toFixed(1)}x`)
	}
	const runs = (prev ? prev.runs || 0 : 0) + 1
	if (runs > FLAGS.weeklyImprovements) added.push(`runs:${runs}`)
	if (game.plausible && !game.plausible(score, stats)) added.push("implausible")
	// The jump signal can't see a first-of-week submission, and a plausibility
	// curve keyed on a client-supplied stat is satisfied by maxing that stat.
	// These two cover the gap the other signals leave.
	if (EYEBROW[gameId] != null && score > EYEBROW[gameId]) added.push(`high:${score}`)
	for (const field of game.suspiciousMax || []) {
		// Guarded: a config typo naming an undeclared stat would otherwise 500 the
		// submit endpoint rather than just failing to flag.
		const range = game.stats[field]
		if (range && stats[field] === range.max) added.push(`maxed:${field}`)
	}
	if (Number.isFinite(Number(body.durationMs))) {
		const secs = Number(body.durationMs) / 1000
		// Self-inconsistent rather than impossible: a run claiming a huge score
		// in a few seconds contradicts its own numbers. Forgeable, so it proves
		// nothing — it just catches carelessness.
		if (secs > 0 && score / secs > 20_000) added.push(`rate:${Math.round(score / secs)}/s`)
	}

	const entry = {
		player: auth.player,
		score,
		at: now,
		stats,
		runs,
		lastAcceptedAt: now,
		// Carry forward what was already raised. The row is replaced wholesale on
		// every improvement, so without this a flagged cheat is cleaned up by its
		// own next ordinary submission — one +1 run and the dashboard, and the
		// frozen week snapshot, show a spotless top score. Flags are the whole
		// audit trail, so they have to be sticky for the week.
		flags: mergeFlags(prev ? prev.flags : [], added),
	}

	if (prevIndex !== -1) board.entries.splice(prevIndex, 1)
	board.entries.push(entry)
	board.entries = rankEntries(board.entries).slice(0, MAX_ENTRIES)
	await writeBoard(env, board)

	const ranked = board.entries
	const rank = ranked.findIndex((e) => e.player === auth.player) + 1
	return json(
		{
			ok: true,
			improved: true,
			week,
			rank: rank || null,
			points: pointsFor(gameId, ranked, auth.player),
			entries: ranked.slice(0, MAX_RETURN).map(publicEntry(familyNames(env))),
		},
		200,
		origin,
	)
}

/** This player's current prize points in this game-week, so the game can show them. */
function pointsFor(gameId, entries, player) {
	const row = gameStandings(gameId, entries).find((r) => r.player === player)
	return row ? row.points : 0
}

async function handleJoint(env, origin, url) {
	const asked = url.searchParams.get("week") || "current"
	const week = asked === "current" ? weekKey(nowMs(env)) : asked
	if (!isWeekKey(week)) return json({ error: "bad week" }, 400, origin)

	// A closed week serves its frozen snapshot, so the standings a payout was
	// based on can never drift.
	const snapshot = await readJson(env, finalKey(week), null)
	if (snapshot) {
		// The badge is recomputed here rather than frozen into the snapshot: who is
		// family is a property of the secret, not of the week. Without this the
		// VISITOR tag vanished from the hub the moment a week closed — which is
		// precisely the week a payout gets decided from.
		const family = familyNames(env)
		const mark = (p) => ({ ...p, visitor: !family.has(p.player) })
		return json(
			{
				week,
				closed: true,
				closedAt: snapshot.closedAt,
				standings: (snapshot.standings || []).map(mark),
				perGame: Object.fromEntries(
					Object.entries(snapshot.perGame || {}).map(([id, info]) => [
						id,
						{ ...info, places: (info.places || []).map(mark) },
					]),
				),
			},
			200,
			origin,
		)
	}

	const boards = await readAllBoards(env, week)
	const proposal = payoutProposal(boards)
	const family = familyNames(env)
	return json(
		{
			week,
			closed: false,
			closesAfter: nextWeek(week),
			standings: proposal.joint.map((p) => ({ ...p, visitor: !family.has(p.player) })),
			perGame: Object.fromEntries(
				GAME_IDS.map((id) => [
					id,
					{
						label: GAMES[id].label,
						qualifiers: proposal.perGame[id].qualifiers,
						places: proposal.perGame[id].places.map((p) => ({
							player: p.player,
							score: p.score,
							place: p.place,
							points: p.points,
							stats: p.stats,
							visitor: !family.has(p.player),
						})),
					},
				]),
			),
		},
		200,
		origin,
	)
}

// ---------------------------------------------------------------- admin

function basicOk(request, expected) {
	if (!expected) return false
	const header = request.headers.get("Authorization") || ""
	if (!header.startsWith("Basic ")) return false
	let decoded
	try {
		decoded = atob(header.slice(6))
	} catch {
		return false
	}
	const i = decoded.indexOf(":")
	return timingSafeEqual(i === -1 ? "" : decoded.slice(i + 1), expected)
}

const authRequired = () =>
	new Response("authorization required", {
		status: 401,
		headers: {
			"WWW-Authenticate": 'Basic realm="prize board"',
			"Cache-Control": "no-store",
			"Content-Type": "text/plain; charset=utf-8",
		},
	})

const html = (body, status = 200) =>
	new Response(body, {
		status,
		headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
	})

const adminJson = (body, status = 200) =>
	new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
	})

/**
 * Freeze a week.
 *
 * The snapshot embeds the rules that were in force and every qualifying entry,
 * so changing the point table later can't rewrite history and the arithmetic
 * stays re-checkable. Write-once: closing twice needs ?force=1, and a forced
 * close keeps the version it replaced rather than discarding it.
 */
async function handleClose(env, url) {
	const week = url.searchParams.get("week") || weekKey(nowMs(env))
	if (!isWeekKey(week)) return adminJson({ error: "bad week" }, 400)
	const force = url.searchParams.get("force") === "1"

	if (!weekHasEnded(week, nowMs(env)) && !force) {
		return adminJson({ error: "week is still running; pass ?force=1 to close it early", week }, 409)
	}

	const existing = await readJson(env, finalKey(week), null)
	if (existing && !force) {
		return adminJson({ error: "week already closed; pass ?force=1 to redo it", week, closedAt: existing.closedAt }, 409)
	}

	// Read everything that can fail BEFORE the irreversible write. Reading the
	// index afterwards meant a corrupt index left the week closed but missing
	// from the history — closed, unlisted, and not re-closable without ?force=1.
	const index = await readJson(env, "weeks:index", { v: 1, weeks: [] }, isWeekIndex)
	const boards = await readAllBoards(env, week)
	const proposal = payoutProposal(boards)

	const snapshot = {
		v: 1,
		week,
		closedAt: nowMs(env),
		tz: "America/Toronto",
		// The rules as applied, so this week's maths can never be re-interpreted.
		rules: { points: POINTS, qualify: Object.fromEntries(GAME_IDS.map((id) => [id, GAMES[id].qualify])) },
		perGame: proposal.perGame,
		standings: proposal.joint,
		jointWinner: proposal.jointWinner,
		jointTied: proposal.jointTied,
		// Every entry verbatim, flags included, so the numbers can be re-derived.
		entries: boards,
		flags: GAME_IDS.flatMap((id) =>
			(boards[id] || []).flatMap((e) =>
				(e.flags || []).map((f) => ({ player: e.player, game: id, signal: f })),
			),
		),
		...(existing ? { replaced: existing } : {}),
	}

	await env.SCORES.put(finalKey(week), JSON.stringify(snapshot))

	if (!index.weeks.includes(week)) {
		index.weeks.push(week)
		index.weeks.sort()
		await env.SCORES.put("weeks:index", JSON.stringify(index))
	}

	return adminJson({ ok: true, week, proposal, snapshotUrl: `/week/${week}` })
}

async function handlePayout(request, env) {
	let body
	try {
		body = await request.json()
	} catch {
		return adminJson({ error: "invalid JSON" }, 400)
	}
	const week = String(body.week || "")
	if (!isWeekKey(week)) return adminJson({ error: "bad week" }, 400)
	const amount = Number(body.amount)
	if (!Number.isFinite(amount) || amount < 0) return adminJson({ error: "bad amount" }, 400)

	const log = await readJson(env, "payouts:log", { v: 1, items: [] }, isPayoutLog)
	const item = {
		week,
		player: String(body.player || "").toLowerCase(),
		amount,
		reason: String(body.reason || "").slice(0, 120),
		at: nowMs(env),
	}
	log.items.push(item)
	await env.SCORES.put("payouts:log", JSON.stringify(log))
	return adminJson({ ok: true, recorded: item })
}

/**
 * Clear one player's entries from one week's boards.
 *
 * Split out because both removing a player and purging a squat need it, and
 * because it must happen BEFORE the account goes: a BoardShapeError halfway
 * through the other order leaves the name free with the scores still standing —
 * removed from the registry, still on the board, still in the payout proposal.
 */
async function clearEntries(env, ids, week) {
	const targets = new Set(ids)
	const cleared = {}
	for (const gameId of GAME_IDS) {
		const board = await readBoard(env, gameId, week)
		const kept = board.entries.filter((e) => !targets.has(e.player))
		if (kept.length !== board.entries.length) {
			cleared[gameId] = board.entries.length - kept.length
			board.entries = kept
			await writeBoard(env, board)
		}
	}
	return cleared
}

/**
 * The player a removal acts on.
 *
 * Prefers an exact match against the registry over `normalizeName`. The
 * dashboard hands back the id it rendered, which is already normalized, so
 * re-normalizing it should be a no-op — and was not, once, in a way that made the
 * remove button report success while leaving the player on the board. Matching
 * what is actually stored means a future slip in the same place cannot do that
 * again: the id either exists or it doesn't.
 */
async function resolveTarget(env, raw, list) {
	const wanted = String(raw ?? "")
	const index = await readIndex(env)
	const exact = index[list].find((p) => p.id === wanted)
	return exact ? exact.id : normalizeName(raw)
}

/**
 * The week a removal acts on, or an error response.
 *
 * The dashboard can be looking at an older week than today's, so it says which
 * one it means rather than letting the two disagree about what got cleared. A
 * closed week is refused outright: the frozen snapshot is what a kid re-checks
 * the arithmetic against, and history that can be edited is worth nothing.
 */
async function removalWeek(env, body) {
	const week = String(body.week || "") || weekKey(nowMs(env))
	if (!isWeekKey(week)) return { error: adminJson({ error: "bad week" }, 400) }
	if (await env.SCORES.get(finalKey(week))) {
		return { error: adminJson({ error: `week ${week} is closed — its standings are frozen`, week }, 409) }
	}
	return { week }
}

/**
 * Remove a self-registered player, and take this week's scores with them.
 *
 * Signup is open to anyone who finds the URL, so this is the counterweight: the
 * one button that gets a stranger off a board a cash prize is riding on. It
 * leaves a tombstone, so being removed is not undone by signing up again with
 * the same two words — see `removePlayer`.
 *
 * Family players are refused: their PINs live in a secret, so removing the KV
 * record would delete nothing and imply otherwise.
 */
async function handleRemovePlayer(request, env) {
	let body
	try {
		body = await request.json()
	} catch {
		return adminJson({ error: "invalid JSON" }, 400)
	}
	const id = await resolveTarget(env, body.player, "players")
	if (!id) return adminJson({ error: "bad player" }, 400)

	const roster = familyRoster(env)
	if (!roster) return adminJson({ error: "server roster misconfigured" }, 500)
	if (roster[id]) {
		return adminJson({ error: "family players live in the PLAYERS secret — edit it with wrangler" }, 400)
	}

	const resolved = await removalWeek(env, body)
	if (resolved.error) return resolved.error

	// De-register first, then clear the boards. The other order was chosen when
	// removal deleted the record — back then, failing halfway left the name free
	// with the scores standing. Now that removal leaves a tombstone, going first
	// is strictly better: if clearing a board throws, the player is already unable
	// to post anything more, and the retry is safe to repeat.
	const removed = await removePlayer(env, id, nowMs(env))
	const cleared = await clearEntries(env, [id], resolved.week)
	return adminJson({ ok: true, player: id, removed, week: resolved.week, cleared })
}

/**
 * Throw off every self-registered player, or everyone who signed up before a
 * given moment, and clear their scores for the week in view.
 *
 * The registry holds 60 names and a single address can fill it in about an hour,
 * after which the next real friend is told the arcade is full. Undoing that one
 * row at a time is not a recovery. `before` lets a squat be cleared without
 * taking out the friends who signed up after it.
 */
async function handlePurgePlayers(request, env) {
	let body
	try {
		body = await request.json()
	} catch {
		return adminJson({ error: "invalid JSON" }, 400)
	}
	// Omitted means everyone. Anything else must be an actual number — Number()
	// would have accepted the string "Infinity" and read it as "everyone", which
	// is not what a caller passing a cutoff can possibly have meant.
	const cutoff = body.before
	if (cutoff !== undefined && cutoff !== null && !Number.isFinite(cutoff)) {
		return adminJson({ error: "bad before" }, 400)
	}
	const before = cutoff === undefined || cutoff === null ? Infinity : cutoff

	const resolved = await removalWeek(env, body)
	if (resolved.error) return resolved.error

	const index = await readIndex(env)
	const doomed = index.players.filter((p) => !Number.isFinite(before) || p.at < before).map((p) => p.id)
	if (!doomed.length) return adminJson({ ok: true, removed: [], week: resolved.week, cleared: {} })

	const removed = await purgePlayers(env, { before, at: nowMs(env) })
	const cleared = await clearEntries(env, doomed, resolved.week)
	return adminJson({ ok: true, removed, week: resolved.week, cleared })
}

/** Lift a ban, putting the name back in circulation. */
async function handleRestorePlayer(request, env) {
	let body
	try {
		body = await request.json()
	} catch {
		return adminJson({ error: "invalid JSON" }, 400)
	}
	const id = await resolveTarget(env, body.player, "banned")
	if (!id) return adminJson({ error: "bad player" }, 400)
	const restored = await restorePlayer(env, id)
	return adminJson({ ok: true, player: id, restored })
}

/** Everyone who can post, and which of the two registries they came from. */
async function adminPlayers(env) {
	const roster = familyRoster(env)
	if (!roster) throw new RosterError()
	const index = await readIndex(env)
	return {
		family: Object.keys(roster).sort(),
		open: index.players,
		banned: index.banned,
		max: LIMITS.maxOpenPlayers,
	}
}

/**
 * The same, but never fatal.
 *
 * The dashboard's job is the standings, the flag column and the close button,
 * and a corrupt registry key used to take all three down with it — the page
 * 500'd and there was no way back from inside the UI. The registry is worth
 * refusing to WRITE over; it is not worth refusing to show a week's standings
 * for. `error` is rendered in place of the Players section.
 */
async function adminPlayersSafe(env) {
	try {
		return await adminPlayers(env)
	} catch (err) {
		if (err instanceof RosterError) {
			// Same trade as below, for the other half: the page still has to be
			// reachable, because it is where you go to look when something is wrong.
			// But with the roster unreadable nothing can be told from anything, so
			// the badges are suppressed rather than guessed.
			return { family: [], open: [], banned: [], max: LIMITS.maxOpenPlayers, rosterError: true, unmarked: true }
		}
		if (!(err instanceof PlayerShapeError)) throw err
		return {
			family: Object.keys(familyRoster(env) || {}).sort(),
			open: [],
			banned: [],
			max: LIMITS.maxOpenPlayers,
			error: err.key,
		}
	}
}

async function handleAdminHistory(env) {
	const index = await readJson(env, "weeks:index", { v: 1, weeks: [] }, isWeekIndex)
	const log = await readJson(env, "payouts:log", { v: 1, items: [] }, isPayoutLog)
	const weeks = []
	for (const week of index.weeks) {
		const snap = await readJson(env, finalKey(week), null)
		if (snap) weeks.push({ week, closedAt: snap.closedAt, jointWinner: snap.jointWinner, standings: snap.standings })
	}
	return adminJson({ weeks, payouts: log.items })
}

// ---------------------------------------------------------------- dispatch

export default {
	async fetch(request, env) {
		const origin = resolveOrigin(request, env)

		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: cors(origin) })
		}
		if (!env.SCORES) {
			return json({ error: "KV namespace SCORES is not bound" }, 500, origin)
		}

		const url = new URL(request.url)
		const path = url.pathname.replace(/\/+$/, "") || "/"

		// Note every handler below is `return await`, not `return`. Returning the
		// promise unawaited would settle it outside this try, so a
		// BoardShapeError would escape as an unhandled 500 with no explanation.
		try {
			// ------------------------------------------------------------ admin
			if (path === "/admin" || path.startsWith("/admin/")) {
				if (!basicOk(request, env.DASHBOARD_PASSWORD)) return authRequired()

				if (request.method === "GET" && path === "/admin") {
					const week = url.searchParams.get("week") || weekKey(nowMs(env))
					if (!isWeekKey(week)) return html("<p>bad week</p>", 400)
					const boards = await readAllBoards(env, week)
					const snapshot = await readJson(env, finalKey(week), null)
					const log = await readJson(env, "payouts:log", { v: 1, items: [] }, isPayoutLog)
					return html(
						renderAdmin({
							week,
							boards,
							proposal: payoutProposal(boards),
							closed: Boolean(snapshot),
							closedAt: snapshot ? snapshot.closedAt : null,
							ended: weekHasEnded(week, nowMs(env)),
							payouts: log.items.filter((p) => p.week === week),
							players: await adminPlayersSafe(env),
						}),
					)
				}
				// Basic auth alone doesn't protect a write here: a cross-origin
				// <form method="POST"> is a CORS-simple request, so the browser
				// would attach the cached credentials and the opaque response
				// wouldn't matter — the side effect is the point, and the side
				// effects are "freeze a week" and "overwrite a frozen week".
				// A custom header can't be set by a form, only by the dashboard.
				if (request.method === "POST" && path.startsWith("/admin/")) {
					if (request.headers.get("X-Prize-Admin") !== "1") {
						return adminJson({ error: "missing X-Prize-Admin header" }, 403)
				}
				}
				if (request.method === "POST" && path === "/admin/close") return await handleClose(env, url)
				if (request.method === "POST" && path === "/admin/payout") return await handlePayout(request, env)
				if (request.method === "POST" && path === "/admin/player/remove") {
					return await handleRemovePlayer(request, env)
				}
				if (request.method === "POST" && path === "/admin/players/purge") {
					return await handlePurgePlayers(request, env)
				}
				if (request.method === "POST" && path === "/admin/player/restore") {
					return await handleRestorePlayer(request, env)
				}
				if (request.method === "GET" && path === "/admin/players") {
					return adminJson(await adminPlayers(env))
				}
				if (request.method === "GET" && path === "/admin/history") return await handleAdminHistory(env)
				return adminJson({ error: "not found" }, 404)
			}

			// ------------------------------------------------------------ public
			if (request.method === "GET" && (path === "/games" || path === "/")) {
				return json(
					{ games: GAME_IDS.map((id) => ({ id, label: GAMES[id].label })), week: weekKey(nowMs(env)) },
					200,
					origin,
				)
			}

			if (request.method === "GET" && path === "/joint") {
				return await handleJoint(env, origin, url)
			}

				if (request.method === "POST" && path === "/join") {
					return await handleJoin(request, env, origin)
				}

				const weekMatch = path.match(/^\/week\/([^/]+)$/)
			if (request.method === "GET" && weekMatch) {
				if (!isWeekKey(weekMatch[1])) return json({ error: "bad week" }, 400, origin)
				const snapshot = await readJson(env, finalKey(weekMatch[1]), null)
				if (!snapshot) return json({ error: "week not closed" }, 404, origin)
				return json(snapshot, 200, origin)
			}

			const gameMatch = path.match(/^\/g\/([^/]+)\/(top|score)$/)
			if (gameMatch) {
				const [, gameId, action] = gameMatch
				if (!GAMES[gameId]) return json({ error: "unknown game" }, 404, origin)
				if (request.method === "GET" && action === "top") return await handleTop(env, origin, gameId, url)
				if (request.method === "POST" && action === "score") {
					return await handleScore(request, env, origin, gameId)
				}
			}

			return json({ error: "not found" }, 404, origin)
		} catch (err) {
			if (err instanceof RosterError) {
				// The same answer the write paths already gave. Reads used to serve a
				// 200 with the family silently empty, which badged all three kids as
				// visitors on the boards they look at.
				return json({ error: "server roster misconfigured" }, 500, origin)
			}
			if (err instanceof BoardShapeError || err instanceof PlayerShapeError) {
				// Loud on purpose. The alternative is treating a corrupt board as
				// empty and then overwriting it, which would destroy a week of
				// scores that money depends on. A corrupt player registry is the
				// same bet: read as empty, it would un-register every friend and
				// leave their names free for anyone to claim.
				return json({ error: "stored data is corrupt", key: err.key }, 500, origin)
			}
			throw err
		}
	},
}
