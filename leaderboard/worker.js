// DANYLO: NECTAR NOVA — leaderboard API.
//
// A deliberately tiny Cloudflare Worker: two routes, one KV key.
//
//   GET  /top?limit=20   -> { entries: [...] }
//   POST /score          -> { rank, entries: [...] }
//
// Scale here is "a family and their friends", so the whole board lives in a
// single KV value that gets read, merged and written back. That is not safe
// against simultaneous writes — two runs finishing in the same instant can lose
// one of the two — which is an acceptable trade for zero setup at this size.
// If it ever matters, move the board into a Durable Object.

const BOARD_KEY = "board:v1"
const MAX_ENTRIES = 100
const MAX_RETURN = 50
const RATE_LIMIT = 12 // submissions allowed per IP per window
const RATE_WINDOW = 60 // seconds

const cors = (origin) => ({
	"Access-Control-Allow-Origin": origin || "*",
	"Access-Control-Allow-Methods": "GET,POST,OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
	"Access-Control-Max-Age": "86400",
})

const json = (body, status, origin) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...cors(origin) },
	})

/** Allow any origin by default; set ALLOWED_ORIGINS to lock it down. */
function resolveOrigin(request, env) {
	const origin = request.headers.get("Origin")
	if (!env.ALLOWED_ORIGINS) return origin || "*"
	const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
	return allowed.includes(origin) ? origin : allowed[0]
}

function cleanName(raw) {
	return String(raw || "")
		.replace(/[^\p{L}\p{N} _\-.]/gu, "")
		.trim()
		.slice(0, 14) || "ANON"
}

/**
 * Nothing here can stop a determined cheater — the client is JavaScript on the
 * player's own machine, so any "proof" it sends can be forged. These checks
 * only keep casual nonsense and typos out of the table.
 */
function validate(body) {
	const score = Number(body.score)
	const wave = Number(body.wave)
	const kills = Number(body.kills)
	const combo = Number(body.combo)

	if (![score, wave, kills, combo].every(Number.isFinite)) return "non-numeric fields"
	if (score < 0 || wave < 1 || kills < 0 || combo < 1) return "negative or zero values"
	if (wave > 500 || kills > 100000 || combo > 8) return "values out of range"
	// Loose plausibility ceiling: even a perfect run can't out-earn this.
	if (score > wave * 200000 + 100000) return "score implausible for wave reached"
	return null
}

async function readBoard(env) {
	const raw = await env.SCORES.get(BOARD_KEY, "json")
	return Array.isArray(raw) ? raw : []
}

async function rateLimited(env, ip) {
	if (!ip) return false
	const key = `rl:${ip}`
	const current = Number((await env.SCORES.get(key)) || 0)
	if (current >= RATE_LIMIT) return true
	// expirationTtl restarts on write, so the window slides; good enough here.
	await env.SCORES.put(key, String(current + 1), { expirationTtl: RATE_WINDOW })
	return false
}

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

		// ---------------------------------------------------------- GET /top
		if (request.method === "GET" && (url.pathname === "/top" || url.pathname === "/")) {
			const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), MAX_RETURN)
			const board = await readBoard(env)
			return json({ entries: board.slice(0, limit), total: board.length }, 200, origin)
		}

		// ------------------------------------------------------- POST /score
		if (request.method === "POST" && url.pathname === "/score") {
			let body
			try {
				body = await request.json()
			} catch {
				return json({ error: "invalid JSON" }, 400, origin)
			}

			const problem = validate(body)
			if (problem) return json({ error: problem }, 400, origin)

			const ip = request.headers.get("CF-Connecting-IP")
			if (await rateLimited(env, ip)) {
				return json({ error: "too many submissions, slow down" }, 429, origin)
			}

			const entry = {
				name: cleanName(body.name),
				score: Math.round(Number(body.score)),
				wave: Math.round(Number(body.wave)),
				kills: Math.round(Number(body.kills)),
				combo: Math.round(Number(body.combo)),
				at: Date.now(),
			}

			const board = await readBoard(env)
			// One row per name — the board should read as "who is best", not as
			// "who played most", and a leaderboard full of one person is no fun.
			const previous = board.findIndex((e) => e.name.toLowerCase() === entry.name.toLowerCase())
			if (previous !== -1) {
				if (board[previous].score >= entry.score) {
					const rank = board.findIndex((e) => e === board[previous]) + 1
					return json({ rank, improved: false, entries: board.slice(0, MAX_RETURN) }, 200, origin)
				}
				board.splice(previous, 1)
			}

			board.push(entry)
			board.sort((a, b) => b.score - a.score || a.at - b.at)
			const trimmed = board.slice(0, MAX_ENTRIES)
			await env.SCORES.put(BOARD_KEY, JSON.stringify(trimmed))

			const rank = trimmed.findIndex((e) => e === entry) + 1
			return json(
				{ rank: rank || null, improved: true, entries: trimmed.slice(0, MAX_RETURN) },
				200,
				origin,
			)
		}

		return json({ error: "not found" }, 404, origin)
	},
}
