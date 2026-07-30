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

import { FLAGS, GAME_IDS, GAMES, POINTS, RATE, cleanStats, validate } from "./games.js"
import { gameStandings, jointStandings, payoutProposal, rankEntries } from "./scoring.js"
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

async function readJson(env, key, fallback) {
	const raw = await env.SCORES.get(key, "json")
	return raw == null ? fallback : raw
}

/** Every game's entries for one week, for the joint board. */
async function readAllBoards(env, week) {
	const boards = {}
	for (const id of GAME_IDS) boards[id] = (await readBoard(env, id, week)).entries
	return boards
}

// ---------------------------------------------------------------- identity

/**
 * Who is submitting.
 *
 * PLAYERS is a secret: { "danylo": "<sha256 of pin>", ... }. Free-text names are
 * gone, which also removes v1's habit of collapsing every unnameable player
 * onto one shared "ANON" row.
 *
 * A four-digit PIN between siblings who share a house is weak — one of them will
 * watch another type it. Its job isn't secrecy, it's attribution: it turns
 * posting as your brother from an accident (wrong name picked on a shared
 * device) into something you have to decide to do.
 */
async function authPlayer(env, body) {
	let roster
	try {
		roster = JSON.parse(env.PLAYERS || "{}")
	} catch {
		return { error: "server roster misconfigured", status: 500 }
	}
	const player = String(body.player || "").toLowerCase().trim()
	if (!player) return { error: "no player", status: 403 }
	const want = roster[player]
	if (!want) return { error: "unknown player", status: 403 }
	const got = await sha256hex(body.pin || "")
	if (!timingSafeEqual(got, String(want).toLowerCase())) return { error: "wrong pin", status: 403 }
	return { player }
}

// ---------------------------------------------------------------- projections

/** What a player is allowed to see. Flags and rate state are for the dashboard only. */
const publicEntry = (e) => ({ player: e.player, score: e.score, at: e.at, stats: e.stats })

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
			entries: ranked.slice(0, limit).map(publicEntry),
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
	if (auth.error) return json({ error: auth.error }, auth.status, origin)

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
				entries: ranked.slice(0, MAX_RETURN).map(publicEntry),
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
	const flags = []
	if (prev && prev.score > 0 && score / prev.score >= FLAGS.scoreJump) {
		flags.push(`jump:${(score / prev.score).toFixed(1)}x`)
	}
	const runs = (prev ? prev.runs || 0 : 0) + 1
	if (runs > FLAGS.weeklyRuns) flags.push(`runs:${runs}`)
	if (game.plausible && !game.plausible(score, stats)) flags.push("implausible")
	if (Number.isFinite(Number(body.durationMs))) {
		const secs = Number(body.durationMs) / 1000
		// Self-inconsistent rather than impossible: a run claiming a huge score
		// in a few seconds contradicts its own numbers. Forgeable, so it proves
		// nothing — it just catches carelessness.
		if (secs > 0 && score / secs > 20_000) flags.push(`rate:${Math.round(score / secs)}/s`)
	}

	const entry = {
		player: auth.player,
		score,
		at: now,
		stats,
		runs,
		lastAcceptedAt: now,
		flags,
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
			entries: ranked.slice(0, MAX_RETURN).map(publicEntry),
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
		return json(
			{ week, closed: true, closedAt: snapshot.closedAt, standings: snapshot.standings, perGame: snapshot.perGame },
			200,
			origin,
		)
	}

	const boards = await readAllBoards(env, week)
	const proposal = payoutProposal(boards)
	return json(
		{
			week,
			closed: false,
			closesAfter: nextWeek(week),
			standings: proposal.joint,
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

	const index = await readJson(env, "weeks:index", { v: 1, weeks: [] })
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

	const log = await readJson(env, "payouts:log", { v: 1, items: [] })
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

async function handleAdminHistory(env) {
	const index = await readJson(env, "weeks:index", { v: 1, weeks: [] })
	const log = await readJson(env, "payouts:log", { v: 1, items: [] })
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
					const log = await readJson(env, "payouts:log", { v: 1, items: [] })
					return html(
						renderAdmin({
							week,
							boards,
							proposal: payoutProposal(boards),
							closed: Boolean(snapshot),
							closedAt: snapshot ? snapshot.closedAt : null,
							ended: weekHasEnded(week, nowMs(env)),
							payouts: log.items.filter((p) => p.week === week),
						}),
					)
				}
				if (request.method === "POST" && path === "/admin/close") return await handleClose(env, url)
				if (request.method === "POST" && path === "/admin/payout") return await handlePayout(request, env)
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
			if (err instanceof BoardShapeError) {
				// Loud on purpose. The alternative is treating a corrupt board as
				// empty and then overwriting it, which would destroy a week of
				// scores that money depends on.
				return json({ error: "stored board is corrupt", key: err.key }, 500, origin)
			}
			throw err
		}
	},
}
