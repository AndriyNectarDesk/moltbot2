// Worker integration tests.
//
// Ported from the hand-rolled leaderboard/worker.test.mjs, which sat unrun for
// its whole life because vitest's include glob only covered src/**/*.test.ts.
// A few of the originals tested things that no longer exist — free-text names
// are gone, replaced by a fixed roster, so "name stripped of markup" and "name
// capped at 14" are now enforced by construction and the equivalent tests check
// that an unknown player is refused instead.

import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it } from "vitest"
import worker from "./worker.js"

const sha = (s) => createHash("sha256").update(String(s)).digest("hex")

const PINS = { danylo: "1111", mike: "2222", sofia: "3333" }
const PLAYERS = JSON.stringify({
	danylo: sha(PINS.danylo),
	mike: sha(PINS.mike),
	sofia: sha(PINS.sofia),
})

// Wednesday 2026-07-29 14:00 Toronto — inside week 2026-07-27.
const NOW = Date.parse("2026-07-29T18:00:00Z")
const WEEK = "2026-07-27"

/**
 * In-memory KV.
 *
 * Unlike the original mock this honours put options (so expiry is expressible)
 * and counts writes — the write count is an assertion target of its own, because
 * one write per accepted submission is what keeps this inside the free tier.
 */
function makeKV(clock = () => NOW) {
	const m = new Map()
	let writes = 0
	return {
		m,
		get writes() {
			return writes
		},
		resetWrites() {
			writes = 0
		},
		async get(k, type) {
			const rec = m.get(k)
			if (rec === undefined) return null
			if (rec.expiresAt && clock() >= rec.expiresAt) {
				m.delete(k)
				return null
			}
			return type === "json" ? JSON.parse(rec.value) : rec.value
		},
		async put(k, v, opts = {}) {
			writes++
			m.set(k, {
				value: v,
				expiresAt: opts.expirationTtl ? clock() + opts.expirationTtl * 1000 : null,
			})
		},
		async delete(k) {
			writes++
			m.delete(k)
		},
	}
}

let env

beforeEach(() => {
	env = {
		SCORES: makeKV(),
		PLAYERS,
		DASHBOARD_PASSWORD: "hunter2",
		__NOW: NOW,
	}
})

const call = (method, path, body, headers = {}) =>
	worker.fetch(
		new Request("https://x" + path, {
			method,
			headers: {
				"Content-Type": "application/json",
				"CF-Connecting-IP": "1.2.3.4",
				Origin: "https://andriynectardesk.github.io",
				...headers,
			},
			body: body ? JSON.stringify(body) : undefined,
		}),
		env,
	)

const post = (player, score, stats = { wave: 6, kills: 40, combo: 5 }, game = "nova", extra = {}) =>
	call("POST", `/g/${game}/score`, { player, pin: PINS[player], score, stats, ...extra })

const top = async (game = "nova") => (await call("GET", `/g/${game}/top`)).json()

/**
 * Stands in for the edge rate-limit binding.
 *
 * Absent by default, because most tests are not about throttling and the real
 * binding fails open off Cloudflare anyway. A test that cares assigns one.
 */
const fakeLimiter = (limit) => {
	const seen = new Map()
	return {
		async limit({ key }) {
			const n = (seen.get(key) || 0) + 1
			seen.set(key, n)
			return { success: n <= limit }
		},
	}
}

// Mirrors what the dashboard page sends: Basic credentials plus the custom
// header that a cross-origin form can't set.
const admin = (method, path, body) =>
	call(method, path, body, {
		Authorization: "Basic " + btoa("dad:hunter2"),
		"X-Prize-Admin": "1",
	})

// ------------------------------------------------------------ basics

describe("basics", () => {
	it("returns an empty board for a fresh week", async () => {
		const r = await call("GET", "/g/nova/top")
		const d = await r.json()
		expect(r.status).toBe(200)
		expect(d.entries).toEqual([])
		expect(d.total).toBe(0)
		expect(d.week).toBe(WEEK)
	})

	it("sends a CORS header", async () => {
		const r = await call("GET", "/g/nova/top")
		expect(r.headers.get("Access-Control-Allow-Origin")).not.toBeNull()
		// Without Vary, a shared cache could hand one origin's header to another.
		expect(r.headers.get("Vary")).toBe("Origin")
	})

	it("answers an OPTIONS preflight with 204", async () => {
		expect((await call("OPTIONS", "/g/nova/score")).status).toBe(204)
	})

	it("says clearly when KV is not bound", async () => {
		const r = await worker.fetch(new Request("https://x/g/nova/top"), { PLAYERS })
		expect(r.status).toBe(500)
		expect((await r.json()).error).toMatch(/not bound/)
	})

	it("404s an unknown path", async () => {
		expect((await call("GET", "/nope")).status).toBe(404)
	})

	it("404s an unknown game before touching storage", async () => {
		const r = await call("GET", "/g/pinball/top")
		expect(r.status).toBe(404)
		expect(env.SCORES.writes).toBe(0)
	})

	it("lists the games it knows", async () => {
		const d = await (await call("GET", "/games")).json()
		expect(d.games.map((g) => g.id)).toEqual(["nova", "fish", "city"])
		expect(d.week).toBe(WEEK)
	})

	it("rejects invalid JSON", async () => {
		const r = await worker.fetch(
			new Request("https://x/g/nova/score", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{not json",
			}),
			env,
		)
		expect(r.status).toBe(400)
	})
})

// ------------------------------------------------------------ storing scores

describe("storing scores", () => {
	it("stores several entries and sorts by score", async () => {
		await post("danylo", 12000)
		await post("mike", 30000)
		await post("sofia", 500, { wave: 1, kills: 3, combo: 1 })
		const d = await top()
		expect(d.entries).toHaveLength(3)
		expect(d.entries.map((e) => e.player)).toEqual(["mike", "danylo", "sofia"])
	})

	it("keeps the old row when a lower score arrives", async () => {
		await post("mike", 30000)
		const r = await post("mike", 10, { wave: 1, kills: 1, combo: 1 })
		expect((await r.json()).improved).toBe(false)
		const d = await top()
		expect(d.entries).toHaveLength(1)
		expect(d.entries[0].score).toBe(30000)
	})

	it("treats an exact tie with yourself as no improvement", async () => {
		await post("mike", 30000)
		expect((await (await post("mike", 30000)).json()).improved).toBe(false)
	})

	it("replaces the row when a higher score arrives, without duplicating", async () => {
		await post("mike", 30000)
		env.__NOW = NOW + 60_000 // past the cooldown
		const r = await post("mike", 45000, { wave: 12, kills: 120, combo: 8 })
		const d = await r.json()
		expect(d.improved).toBe(true)
		expect(d.rank).toBe(1)
		const board = await top()
		expect(board.entries).toHaveLength(1)
		expect(board.entries[0].score).toBe(45000)
	})

	it("treats a player id as case-insensitive", async () => {
		await post("danylo", 12000)
		await call("POST", "/g/nova/score", {
			player: "DANYLO",
			pin: PINS.danylo,
			score: 20000,
			stats: { wave: 8, kills: 60, combo: 6 },
		})
		const d = await top()
		expect(d.entries.filter((e) => e.player === "danylo")).toHaveLength(1)
	})

	it("keeps each game's board separate", async () => {
		await post("danylo", 12000)
		await post("mike", 3, { landed: 3, heaviest: 2200, species: 2, flow: 10 }, "fish")
		expect((await top("nova")).entries.map((e) => e.player)).toEqual(["danylo"])
		expect((await top("fish")).entries.map((e) => e.player)).toEqual(["mike"])
	})

	it("hides flags and rate state from players", async () => {
		await post("danylo", 12000)
		const d = await top()
		// `visitor` is public on purpose — the kids never see the dashboard, and a
		// name is not proof of who somebody is. Flags, runs and lastAcceptedAt are
		// still dashboard-only.
		expect(Object.keys(d.entries[0]).sort()).toEqual(["at", "player", "score", "stats", "visitor"])
		expect(d.entries[0].visitor).toBe(false)
	})

	it("stamps its own time, ignoring anything the client sends", async () => {
		await call("POST", "/g/nova/score", {
			player: "danylo",
			pin: PINS.danylo,
			score: 12000,
			stats: { wave: 6, kills: 40, combo: 5 },
			at: 999,
		})
		expect((await top()).entries[0].at).toBe(NOW)
	})

	it("honours the limit param and clamps it", async () => {
		await post("danylo", 12000)
		await post("mike", 30000)
		expect((await (await call("GET", "/g/nova/top?limit=1")).json()).entries).toHaveLength(1)
		// total still reflects the whole board
		expect((await (await call("GET", "/g/nova/top?limit=1")).json()).total).toBe(2)
		expect((await (await call("GET", "/g/nova/top?limit=9999")).json()).entries).toHaveLength(2)
	})
})

// ------------------------------------------------------------ write budget

describe("write budget", () => {
	it("uses exactly one write for an accepted submission", async () => {
		env.SCORES.resetWrites()
		await post("danylo", 12000)
		expect(env.SCORES.writes).toBe(1)
	})

	// v1 wrote a rate-limit counter on every request, which could exhaust the
	// free tier's 1k writes/day in about ninety minutes.
	it("uses no writes at all when a score does not improve", async () => {
		await post("danylo", 12000)
		env.SCORES.resetWrites()
		await post("danylo", 5000)
		expect(env.SCORES.writes).toBe(0)
	})

	it("uses no writes for a read", async () => {
		await post("danylo", 12000)
		env.SCORES.resetWrites()
		await call("GET", "/g/nova/top")
		await call("GET", "/joint")
		expect(env.SCORES.writes).toBe(0)
	})
})

// ------------------------------------------------------------ validation

describe("validation", () => {
	const bad = [
		["a negative score", { score: -5, stats: { wave: 1, kills: 0, combo: 1 } }],
		["a combo above the game maximum", { score: 100, stats: { wave: 1, kills: 1, combo: 99 } }],
		["a non-numeric score", { score: "abc", stats: { wave: 1, kills: 1, combo: 1 } }],
		["wave zero", { score: 10, stats: { wave: 0, kills: 1, combo: 1 } }],
		["a score beyond any game", { score: 999_999_999, stats: { wave: 1, kills: 1, combo: 1 } }],
		["missing stats entirely", { score: 100 }],
		["a missing stat field", { score: 100, stats: { wave: 1, kills: 1 } }],
	]

	for (const [label, body] of bad) {
		it(`rejects ${label}`, async () => {
			const r = await call("POST", "/g/nova/score", { player: "danylo", pin: PINS.danylo, ...body })
			expect(r.status).toBe(400)
		})
	}

	// The regression test for the whole multi-game exercise: v1's validator
	// required wave/kills/combo, so a fishing score was a 400.
	it("accepts a fishing score that has no wave", async () => {
		const r = await post("mike", 4200, { landed: 6, heaviest: 4200, species: 3, flow: 20 }, "fish")
		expect(r.status).toBe(200)
		expect((await r.json()).improved).toBe(true)
	})

	it("rejects a shooter stat sent to the fishing game", async () => {
		const r = await call("POST", "/g/fish/score", {
			player: "mike",
			pin: PINS.mike,
			score: 100,
			stats: { wave: 3, kills: 5, combo: 2 },
		})
		expect(r.status).toBe(400)
	})

	// The fishing game now exists, so its config is real rather than a placeholder.
	it("accepts a realistic fishing run", async () => {
		const r = await post(
			"mike",
			1651,
			{ landed: 7, heaviest: 4748, species: 4, flow: 30 },
			"fish",
		)
		expect(r.status).toBe(200)
		expect((await r.json()).improved).toBe(true)
	})

	it("accepts a blank morning with nothing caught", async () => {
		const r = await post("mike", 0, { landed: 0, heaviest: 0, species: 0, flow: 10 }, "fish")
		expect(r.status).toBe(200)
	})

	it("rejects a fish heavier than the lake holds", async () => {
		const r = await post(
			"mike",
			500,
			{ landed: 1, heaviest: 250_000, species: 1, flow: 10 },
			"fish",
		)
		expect(r.status).toBe(400)
	})

	it("rejects more species than exist", async () => {
		const r = await post("mike", 500, { landed: 9, heaviest: 900, species: 9, flow: 10 }, "fish")
		expect(r.status).toBe(400)
	})

	it("flags a fishing score too big for the fish landed", async () => {
		// Two fish cannot be worth 200k — the best single fish in the lake is a
		// 17kg sturgeon at a 3x multiplier, which is 10,200.
		await post("mike", 200_000, { landed: 2, heaviest: 17_000, species: 2, flow: 30 }, "fish")
		const raw = JSON.parse(env.SCORES.m.get(`wk:fish:${WEEK}`).value)
		expect(raw.entries[0].flags).toContain("implausible")
	})

	it("does not flag an honest big morning", async () => {
		await post("mike", 9000, { landed: 6, heaviest: 12_000, species: 4, flow: 30 }, "fish")
		const raw = JSON.parse(env.SCORES.m.get(`wk:fish:${WEEK}`).value)
		expect(raw.entries[0].flags).toEqual([])
	})

	// The city exists now too, so all three configs are real.
	it("accepts a realistic delivery shift", async () => {
		const r = await post("sofia", 12_400, { deliveries: 14, stars: 22, bestRun: 9 }, "city")
		expect(r.status).toBe(200)
		expect((await r.json()).improved).toBe(true)
	})

	it("accepts a shift where nothing was delivered", async () => {
		const r = await post("sofia", 0, { deliveries: 0, stars: 0, bestRun: 0 }, "city")
		expect(r.status).toBe(200)
	})

	it("rejects more stars than the city holds", async () => {
		const r = await post("sofia", 500, { deliveries: 2, stars: 999, bestRun: 9 }, "city")
		expect(r.status).toBe(400)
	})

	it("rejects a delivery slower than the whole shift", async () => {
		const r = await post("sofia", 500, { deliveries: 2, stars: 4, bestRun: 900 }, "city")
		expect(r.status).toBe(400)
	})

	it("flags a shift score too big for the jobs done", async () => {
		await post("sofia", 400_000, { deliveries: 3, stars: 10, bestRun: 5 }, "city")
		const raw = JSON.parse(env.SCORES.m.get(`wk:city:${WEEK}`).value)
		expect(raw.entries[0].flags).toContain("implausible")
	})

	it("does not flag an honest big shift", async () => {
		await post("sofia", 30_000, { deliveries: 26, stars: 40, bestRun: 6 }, "city")
		const raw = JSON.parse(env.SCORES.m.get(`wk:city:${WEEK}`).value)
		expect(raw.entries[0].flags).toEqual([])
	})

	it("keeps all three games' boards separate", async () => {
		await post("danylo", 12000)
		await post("mike", 1651, { landed: 7, heaviest: 4748, species: 4, flow: 30 }, "fish")
		await post("sofia", 8000, { deliveries: 9, stars: 12, bestRun: 11 }, "city")
		expect((await top("nova")).entries.map((e) => e.player)).toEqual(["danylo"])
		expect((await top("fish")).entries.map((e) => e.player)).toEqual(["mike"])
		expect((await top("city")).entries.map((e) => e.player)).toEqual(["sofia"])
	})

	it("drops stats the game never declared", async () => {
		await post("danylo", 12000, { wave: 6, kills: 40, combo: 5, secret: 99 })
		expect((await top()).entries[0].stats).toEqual({ wave: 6, kills: 40, combo: 5 })
	})

	// v1 rejected an implausible score outright. Flagging instead means a kid
	// having a spectacular run is never blocked — the flag is for the dashboard.
	it("flags an implausible score instead of rejecting it", async () => {
		const r = await post("danylo", 5_000_000, { wave: 1, kills: 1, combo: 1 })
		expect(r.status).toBe(200)
		const raw = JSON.parse(env.SCORES.m.get(`wk:nova:${WEEK}`).value)
		expect(raw.entries[0].flags).toContain("implausible")
	})
})

// ------------------------------------------------------------ identity

describe("identity", () => {
	it("refuses a wrong pin", async () => {
		const r = await call("POST", "/g/nova/score", {
			player: "danylo",
			pin: "9999",
			score: 12000,
			stats: { wave: 6, kills: 40, combo: 5 },
		})
		expect(r.status).toBe(403)
		expect((await r.json()).error).toMatch(/pin/)
	})

	// The score endpoint used to say "unknown player" for a name with no account
	// and "wrong pin" for one that had it — which answered, for free and with no
	// side effect, the exact question /join is careful not to answer. Wording
	// parity at /join is worth nothing while this endpoint tells you anyway.
	it("does not say whether a name has an account", async () => {
		const bad = (player) =>
			call("POST", "/g/nova/score", { player, pin: "9999", score: 12000, stats: { wave: 6, kills: 40, combo: 5 } })

		await join("zoe", "4242")
		const [known, unknown, family] = await Promise.all([bad("zoe"), bad("nobodyhere"), bad("danylo")])
		expect([known.status, unknown.status, family.status]).toEqual([403, 403, 403])
		const errors = await Promise.all([known.json(), unknown.json(), family.json()])
		expect(new Set(errors.map((e) => e.error)).size).toBe(1)
	})

	// The PIN is the only real gate on writing, so the endpoint an attacker would
	// actually walk it at has to cost something.
	it("throttles failed sign-ins at the score endpoint", async () => {
		env.LIMITER = fakeLimiter(2)
		const bad = () =>
			call("POST", "/g/nova/score", {
				player: "danylo",
				pin: "9999",
				score: 12000,
				stats: { wave: 6, kills: 40, combo: 5 },
			})
		expect((await bad()).status).toBe(403)
		expect((await bad()).status).toBe(403)
		expect((await bad()).status).toBe(429)
		// An honest player never meets it: only failures are charged.
		expect((await post("danylo", 12000)).status).toBe(200)
	})

	it("refuses a missing pin", async () => {
		const r = await call("POST", "/g/nova/score", {
			player: "danylo",
			score: 100,
			stats: { wave: 1, kills: 1, combo: 1 },
		})
		expect(r.status).toBe(403)
	})

	// Replaces v1's name-sanitising tests: free text can't reach the board at
	// all now, so there is nothing to strip and no shared ANON row to collide on.
	it("refuses a player who is not on the roster", async () => {
		for (const player of ["<script>alert(1)</script>", "guest", "averyverylongname", ""]) {
			const r = await call("POST", "/g/nova/score", {
				player,
				pin: "1111",
				score: 100,
				stats: { wave: 1, kills: 1, combo: 1 },
			})
			expect(r.status).toBe(403)
		}
	})

	it("checks identity before validating, and writes nothing either way", async () => {
		const r = await call("POST", "/g/nova/score", { player: "mike", pin: "wrong", score: -1, stats: {} })
		expect(r.status).toBe(403)
		expect(env.SCORES.writes).toBe(0)
	})

	it("stops a kid overwriting a sibling's row", async () => {
		await post("danylo", 12000)
		const r = await call("POST", "/g/nova/score", {
			player: "danylo",
			pin: PINS.mike, // mike knows his own pin, not his brother's
			score: 99999,
			stats: { wave: 20, kills: 200, combo: 8 },
		})
		expect(r.status).toBe(403)
		expect((await top()).entries[0].score).toBe(12000)
	})
})

// ------------------------------------------------------------ rate limiting

describe("rate limiting", () => {
	it("rejects a second improving submission inside the cooldown", async () => {
		await post("danylo", 12000)
		const r = await post("danylo", 13000)
		expect(r.status).toBe(429)
	})

	it("allows it once the cooldown has passed", async () => {
		await post("danylo", 12000)
		env.__NOW = NOW + 21_000
		expect((await post("danylo", 13000)).status).toBe(200)
	})

	it("caps accepted submissions per week", async () => {
		let t = NOW
		let last
		for (let i = 0; i < 60; i++) {
			env.__NOW = t
			last = await post("danylo", 1000 + i * 10)
			if (last.status === 429 && (await last.clone().json()).error.includes("cap")) break
			t += 21_000
		}
		expect(last.status).toBe(429)
		expect((await last.json()).error).toMatch(/cap/)
	})

	// Three kids on one home wifi used to share a single 12/min IP budget.
	it("does not let one player's cooldown block another", async () => {
		await post("danylo", 12000)
		expect((await post("mike", 9000)).status).toBe(200)
	})

	it("does not burn the cooldown on a non-improving submission", async () => {
		await post("danylo", 12000)
		await post("danylo", 10) // no improvement, no write, no cooldown consumed
		env.__NOW = NOW + 21_000
		expect((await post("danylo", 13000)).status).toBe(200)
	})
})

// ------------------------------------------------------------ flags

describe("flags", () => {
	const flagsOf = (game = "nova") =>
		JSON.parse(env.SCORES.m.get(`wk:${game}:${WEEK}`).value).entries[0].flags

	it("flags a big jump over the player's own best", async () => {
		await post("danylo", 1000)
		env.__NOW = NOW + 21_000
		await post("danylo", 9000)
		expect(flagsOf().some((f) => f.startsWith("jump:"))).toBe(true)
	})

	it("does not flag a normal improvement", async () => {
		await post("danylo", 1000)
		env.__NOW = NOW + 21_000
		await post("danylo", 2000)
		expect(flagsOf()).toEqual([])
	})

	it("flags a score that contradicts its own claimed duration", async () => {
		await post("danylo", 900_000, { wave: 40, kills: 400, combo: 8 }, "nova", { durationMs: 15_000 })
		expect(flagsOf().some((f) => f.startsWith("rate:"))).toBe(true)
	})

	it("leaves an honest short run alone", async () => {
		await post("danylo", 1200, { wave: 2, kills: 4, combo: 2 }, "nova", { durationMs: 45_000 })
		expect(flagsOf()).toEqual([])
	})

	it("never tells the player about a flag", async () => {
		const r = await post("danylo", 5_000_000, { wave: 1, kills: 1, combo: 1 })
		expect(JSON.stringify(await r.json())).not.toContain("implausible")
	})

	// The row is replaced wholesale on every improvement, so without carrying
	// flags forward a cheat cleans up after itself: post an absurd score, then
	// one ordinary +1 run, and the dashboard and the frozen week snapshot both
	// show a spotless top score. Flags are the entire audit trail.
	it("keeps a flag after a later ordinary submission", async () => {
		await post("danylo", 1000)
		env.__NOW = NOW + 21_000
		await post("danylo", 900_000) // jump + high
		expect(flagsOf().some((f) => f.startsWith("jump:"))).toBe(true)

		env.__NOW = NOW + 42_000
		await post("danylo", 900_001) // a normal-looking 1.000001x improvement
		const after = flagsOf()
		expect(after.some((f) => f.startsWith("jump:"))).toBe(true)
		expect(after.some((f) => f.startsWith("high:"))).toBe(true)
	})

	it("keeps flags in the frozen week snapshot", async () => {
		await post("danylo", 1000)
		env.__NOW = NOW + 21_000
		await post("danylo", 900_000)
		env.__NOW = NOW + 42_000
		await post("danylo", 900_001)

		env.__NOW = Date.parse("2026-08-04T18:00:00Z")
		await admin("POST", `/admin/close?week=${WEEK}`)
		const snap = await (await call("GET", `/week/${WEEK}`)).json()
		expect(snap.flags.length).toBeGreaterThan(0)
		expect(snap.flags.some((f) => f.signal.startsWith("jump:"))).toBe(true)
	})

	it("keeps only the latest flag of each kind", async () => {
		await post("danylo", 1000)
		env.__NOW = NOW + 21_000
		await post("danylo", 9000) // jump:9.0x
		env.__NOW = NOW + 42_000
		await post("danylo", 900_000) // jump:100.0x
		const jumps = flagsOf().filter((f) => f.startsWith("jump:"))
		expect(jumps).toHaveLength(1)
		expect(jumps[0]).toBe("jump:100.0x")
	})

	// The jump signal needs a previous row, so the simplest attack of all — one
	// enormous first submission — was invisible to every other signal, and a
	// plausibility curve keyed on a client-supplied stat is beaten by maxing it.
	it("flags a huge first submission of the week", async () => {
		await post("danylo", 49_999_999, { wave: 500, kills: 100_000, combo: 8 })
		const flags = flagsOf()
		expect(flags.some((f) => f.startsWith("high:"))).toBe(true)
		expect(flags).toContain("maxed:wave")
	})

	it("leaves an ordinary first submission unflagged", async () => {
		await post("danylo", 12_000, { wave: 6, kills: 40, combo: 5 })
		expect(flagsOf()).toEqual([])
	})
})

// ------------------------------------------------------------ corrupt storage

describe("corrupt storage", () => {
	// v1 did `Array.isArray(raw) ? raw : []`, so a bad shape looked exactly like
	// an empty board — and the next write would erase the week.
	it("returns 500 rather than treating a bad shape as empty", async () => {
		env.SCORES.m.set(`wk:nova:${WEEK}`, { value: JSON.stringify({ nope: true }), expiresAt: null })
		const r = await call("GET", "/g/nova/top")
		expect(r.status).toBe(500)
		expect((await r.json()).error).toMatch(/corrupt/)
	})

	it("refuses to overwrite a corrupt board", async () => {
		env.SCORES.m.set(`wk:nova:${WEEK}`, { value: JSON.stringify([{ old: "v1" }]), expiresAt: null })
		env.SCORES.resetWrites()
		const r = await post("danylo", 12000)
		expect(r.status).toBe(500)
		expect(env.SCORES.writes).toBe(0)
	})

	it("still treats a genuinely absent board as empty", async () => {
		const r = await call("GET", "/g/nova/top")
		expect(r.status).toBe(200)
		expect((await r.json()).entries).toEqual([])
	})

	it("refuses to close a week when the week index is corrupt", async () => {
		env.SCORES.m.set("weeks:index", { value: JSON.stringify("nope"), expiresAt: null })
		env.__NOW = Date.parse("2026-08-04T18:00:00Z")
		env.SCORES.resetWrites()
		const r = await admin("POST", `/admin/close?week=${WEEK}`)
		expect(r.status).toBe(500)
		// The snapshot write used to happen before the index was read, so a bad
		// index left the week closed but missing from the history.
		expect(env.SCORES.writes).toBe(0)
	})

	it("refuses to record a payout when the log is corrupt", async () => {
		env.SCORES.m.set("payouts:log", { value: JSON.stringify([1, 2]), expiresAt: null })
		const r = await admin("POST", "/admin/payout", { week: WEEK, player: "mike", amount: 5 })
		expect(r.status).toBe(500)
	})
})

describe("bad week parameters", () => {
	// The regex shape alone let "2026-13-45" through, which parsed to NaN and made
	// Intl throw — surfacing as an opaque 500 with no CORS headers on a public
	// route rather than the intended 400.
	for (const week of ["2026-13-45", "0000-00-00", "9999-99-99", "2026-02-31", "current-ish"]) {
		it(`returns 400 for week=${week}`, async () => {
			expect((await call("GET", `/g/nova/top?week=${week}`)).status).toBe(400)
			expect((await call("GET", `/joint?week=${week}`)).status).toBe(400)
		})
	}

	it("returns 400, not a crash, for a bad week on /week/", async () => {
		expect((await call("GET", "/week/2026-13-45")).status).toBe(400)
	})

	it("rejects a bad week on close", async () => {
		expect((await admin("POST", "/admin/close?week=2026-13-45")).status).toBe(400)
	})
})

describe("admin write protection", () => {
	// Basic auth alone doesn't stop a cross-origin form post, and the side effects
	// are "freeze a week" and "overwrite a frozen week".
	it("rejects a close without the custom header", async () => {
		env.__NOW = Date.parse("2026-08-04T18:00:00Z")
		const r = await call("POST", `/admin/close?week=${WEEK}`, null, {
			Authorization: "Basic " + btoa("dad:hunter2"),
		})
		expect(r.status).toBe(403)
	})

	it("rejects a payout without the custom header", async () => {
		const r = await call("POST", "/admin/payout", { week: WEEK, player: "mike", amount: 5 }, {
			Authorization: "Basic " + btoa("dad:hunter2"),
		})
		expect(r.status).toBe(403)
	})

	it("still checks auth before the header", async () => {
		expect((await call("POST", "/admin/close")).status).toBe(401)
	})
})

// ------------------------------------------------------------ joint board

describe("joint board", () => {
	it("sums prize points across games", async () => {
		await post("danylo", 12000)
		await post("mike", 30000)
		await post("mike", 5000, { landed: 6, heaviest: 5000, species: 3, flow: 20 }, "fish")
		const d = await (await call("GET", "/joint")).json()
		expect(d.closed).toBe(false)
		expect(d.week).toBe(WEEK)
		// nova: mike 11, danylo 7. fish: mike alone, so participation only (1).
		expect(d.standings[0]).toMatchObject({ player: "mike", total: 12 })
		expect(d.standings[1]).toMatchObject({ player: "danylo", total: 7 })
	})

	it("reports each game's places", async () => {
		await post("danylo", 12000)
		await post("mike", 30000)
		const d = await (await call("GET", "/joint")).json()
		expect(d.perGame.nova.qualifiers).toBe(2)
		expect(d.perGame.fish.places).toEqual([])
	})

	it("rejects a week that is not a Monday", async () => {
		expect((await call("GET", "/joint?week=2026-07-28")).status).toBe(400)
	})
})

// ------------------------------------------------------------ closing a week

describe("closing a week", () => {
	it("requires auth on every admin route", async () => {
		for (const [m, p] of [["GET", "/admin"], ["POST", "/admin/close"], ["GET", "/admin/history"]]) {
			const r = await call(m, p)
			expect(r.status).toBe(401)
			expect(r.headers.get("WWW-Authenticate")).toMatch(/Basic/)
		}
	})

	it("rejects a wrong password", async () => {
		const r = await call("GET", "/admin", null, { Authorization: "Basic " + btoa("dad:nope") })
		expect(r.status).toBe(401)
	})

	it("renders the dashboard", async () => {
		await post("danylo", 12000)
		const r = await admin("GET", "/admin")
		expect(r.status).toBe(200)
		expect(r.headers.get("Cache-Control")).toBe("no-store")
		const body = await r.text()
		expect(body).toContain("PRIZE BOARD")
		expect(body).toContain("danylo")
	})

	it("refuses to close a week that is still running", async () => {
		expect((await admin("POST", "/admin/close")).status).toBe(409)
	})

	it("closes a finished week and freezes the standings", async () => {
		await post("danylo", 12000)
		await post("mike", 30000)
		env.__NOW = Date.parse("2026-08-04T18:00:00Z") // the following week
		const r = await admin("POST", `/admin/close?week=${WEEK}`)
		expect(r.status).toBe(200)
		const d = await r.json()
		expect(d.proposal.jointWinner).toBe("mike")

		const snap = await (await call("GET", `/week/${WEEK}`)).json()
		// The rules in force are embedded, so changing the point table later
		// cannot retroactively rewrite who won.
		expect(snap.rules.points.places).toEqual([10, 6, 3])
		expect(snap.rules.points.minQualifiersForPlaces).toBe(2)
		// Every underlying entry is kept so the arithmetic stays re-checkable.
		expect(snap.entries.nova).toHaveLength(2)
		expect(snap.standings[0].player).toBe("mike")
	})

	it("404s a week that was never closed", async () => {
		expect((await call("GET", `/week/${WEEK}`)).status).toBe(404)
	})

	it("rejects a new score for a closed week", async () => {
		env.__NOW = Date.parse("2026-08-04T18:00:00Z")
		await admin("POST", `/admin/close?week=${WEEK}`)
		env.__NOW = NOW // back inside the closed week
		const r = await post("danylo", 12000)
		expect(r.status).toBe(409)
		expect((await r.json()).error).toMatch(/closed/)
	})

	it("refuses to close the same week twice without force", async () => {
		env.__NOW = Date.parse("2026-08-04T18:00:00Z")
		expect((await admin("POST", `/admin/close?week=${WEEK}`)).status).toBe(200)
		expect((await admin("POST", `/admin/close?week=${WEEK}`)).status).toBe(409)
	})

	it("keeps the replaced snapshot when forced", async () => {
		env.__NOW = Date.parse("2026-08-04T18:00:00Z")
		await admin("POST", `/admin/close?week=${WEEK}`)
		await admin("POST", `/admin/close?week=${WEEK}&force=1`)
		const snap = await (await call("GET", `/week/${WEEK}`)).json()
		expect(snap.replaced).toBeDefined()
		expect(snap.replaced.week).toBe(WEEK)
	})

	it("serves the frozen snapshot for a closed joint board", async () => {
		await post("danylo", 12000)
		env.__NOW = Date.parse("2026-08-04T18:00:00Z")
		await admin("POST", `/admin/close?week=${WEEK}`)
		const d = await (await call("GET", `/joint?week=${WEEK}`)).json()
		expect(d.closed).toBe(true)
		expect(d.closedAt).toBeDefined()
	})

	it("lists closed weeks without a KV list call", async () => {
		env.__NOW = Date.parse("2026-08-04T18:00:00Z")
		await admin("POST", `/admin/close?week=${WEEK}`)
		const d = await (await admin("GET", "/admin/history")).json()
		expect(d.weeks.map((w) => w.week)).toEqual([WEEK])
		// The mock has no list() at all, so reaching this line proves none is used.
		expect(env.SCORES.list).toBeUndefined()
	})
})

// ------------------------------------------------------------ payouts

describe("payouts", () => {
	it("records a payout without paying anything", async () => {
		const r = await admin("POST", "/admin/payout", {
			week: WEEK,
			player: "mike",
			amount: 5,
			reason: "joint winner",
		})
		expect(r.status).toBe(200)
		const d = await (await admin("GET", "/admin/history")).json()
		expect(d.payouts).toEqual([
			expect.objectContaining({ week: WEEK, player: "mike", amount: 5, reason: "joint winner" }),
		])
	})

	it("rejects a bad amount or week", async () => {
		expect((await admin("POST", "/admin/payout", { week: WEEK, player: "mike", amount: -1 })).status).toBe(400)
		expect((await admin("POST", "/admin/payout", { week: "nope", player: "mike", amount: 5 })).status).toBe(400)
	})
})

// ------------------------------------------------------------ open signup
//
// The three kids are in a secret. Everyone else — the friends they bring home —
// signs themselves up here and competes for the same prize, which is what these
// tests are really guarding: an open player is not a second-class one.

const join = (player, pin, headers = {}) => call("POST", "/join", { player, pin }, headers)

const postAs = (player, pin, score, stats = { wave: 6, kills: 40, combo: 5 }, game = "nova") =>
	call("POST", `/g/${game}/score`, { player, pin, score, stats })

describe("signing up", () => {
	it("creates a player and lets them post straight away", async () => {
		const r = await join("Zoe", "4242")
		expect(r.status).toBe(200)
		expect(await r.json()).toMatchObject({ ok: true, player: "zoe", created: true, kind: "open" })

		expect((await postAs("zoe", "4242", 9000)).status).toBe(200)
		expect((await top()).entries.map((e) => e.player)).toEqual(["zoe"])
	})

	it("signs an existing player back in rather than refusing them", async () => {
		await join("zoe", "4242")
		// Same call from a different device, or after clearing the browser.
		const r = await join("ZOE", "4242")
		expect(r.status).toBe(200)
		expect(await r.json()).toMatchObject({ ok: true, player: "zoe", created: false })
	})

	it("refuses a name that is taken, without confirming it exists", async () => {
		await join("zoe", "4242")
		const r = await join("zoe", "1234")
		expect(r.status).toBe(403)
		// Same wording as claiming a kid's name — this must not be an oracle for
		// who has an account.
		const mine = await join("danylo", "9999")
		expect((await r.json()).error).toBe((await mine.json()).error)
	})

	it("lets a kid sign in with their own PIN but never lets one be created", async () => {
		expect(await (await join("danylo", PINS.danylo)).json()).toMatchObject({
			ok: true,
			player: "danylo",
			created: false,
			kind: "family",
		})
		// and nothing was written to the registry for them
		expect((await (await admin("GET", "/admin/players")).json()).open).toEqual([])
	})

	it("rejects names that can't be one and PINs that can't be typed", async () => {
		expect((await join("z", "4242")).status).toBe(400)
		expect((await join("1234", "4242")).status).toBe(400)
		expect((await join("guest", "4242")).status).toBe(400)
		expect((await join("zoe", "12")).status).toBe(400)
		expect((await join("zoe", "abcd")).status).toBe(400)
	})

	it("stops a PIN guesser without locking out the rest of the house", async () => {
		env.LIMITER = fakeLimiter(3)
		for (let i = 0; i < 3; i++) expect((await join("danylo", String(1000 + i))).status).toBe(403)
		expect((await join("danylo", "1111")).status).toBe(429)
		// A different address is unaffected.
		expect((await join("zoe", "4242", { "CF-Connecting-IP": "5.6.7.8" })).status).toBe(200)
	})

	// The counter this replaced wrote to KV on every attempt, which is how v1
	// could burn a day's free-tier writes in an afternoon.
	it("costs no KV writes when it refuses", async () => {
		env.LIMITER = fakeLimiter(0)
		env.SCORES.resetWrites()
		expect((await join("zoe", "4242")).status).toBe(429)
		expect(env.SCORES.writes).toBe(0)
	})

	it("stops taking signups once the arcade is full", async () => {
		const index = { v: 1, players: [] }
		for (let i = 0; i < 60; i++) index.players.push({ id: `kid${i}`, at: NOW })
		env.SCORES.m.set("players:index", { value: JSON.stringify(index), expiresAt: null })
		expect((await join("zoe", "4242")).status).toBe(409)
	})
})

describe("an open player is a full player", () => {
	beforeEach(async () => {
		await join("zoe", "4242")
	})

	it("earns place points and appears on the joint board", async () => {
		await postAs("zoe", "4242", 20000)
		await post("danylo", 9000)

		const d = await (await call("GET", "/joint")).json()
		expect(d.standings[0]).toMatchObject({ player: "zoe", total: 11 })
		expect(d.standings[1]).toMatchObject({ player: "danylo", total: 7 })
	})

	it("can win the whole week, and the payout proposal says so", async () => {
		await postAs("zoe", "4242", 20000)
		await post("danylo", 9000)
		const d = await (await admin("POST", `/admin/close?week=${WEEK}&force=1`)).json()
		expect(d.proposal.jointWinner).toBe("zoe")
	})

	it("cannot post as somebody else", async () => {
		expect((await postAs("zoe", "1111", 9000)).status).toBe(403)
		expect((await postAs("danylo", "4242", 9000)).status).toBe(403)
	})

	it("gets its own row rather than sharing one", async () => {
		await join("mo", "5555")
		await postAs("zoe", "4242", 9000)
		await postAs("mo", "5555", 8000)
		expect((await top()).entries.map((e) => e.player)).toEqual(["zoe", "mo"])
	})
})

describe("removing a player", () => {
	beforeEach(async () => {
		await join("zoe", "4242")
		await postAs("zoe", "4242", 20000)
		await post("danylo", 9000)
	})

	it("takes their account and this week's scores with them", async () => {
		const r = await admin("POST", "/admin/player/remove", { player: "zoe", week: WEEK })
		expect(r.status).toBe(200)
		expect(await r.json()).toMatchObject({ ok: true, player: "zoe", removed: true, cleared: { nova: 1 } })

		expect((await top()).entries.map((e) => e.player)).toEqual(["danylo"])
		expect((await (await admin("GET", "/admin/players")).json()).open).toEqual([])
		// and the name is free again, which is the point of removing it
		expect((await postAs("zoe", "4242", 9000)).status).toBe(403)
	})

	it("leaves the other games alone", async () => {
		await postAs("zoe", "4242", 5, { landed: 3, heaviest: 4000, species: 2, flow: 15 }, "fish")
		await admin("POST", "/admin/player/remove", { player: "zoe", week: WEEK })
		expect((await top("fish")).entries).toEqual([])
		expect((await top("city")).entries).toEqual([])
	})

	// History that can be edited is worth nothing to a kid disputing a payout.
	it("refuses to touch a week that has been closed", async () => {
		await admin("POST", `/admin/close?week=${WEEK}&force=1`)
		const r = await admin("POST", "/admin/player/remove", { player: "zoe", week: WEEK })
		expect(r.status).toBe(409)
		const snap = await (await call("GET", `/week/${WEEK}`)).json()
		expect(snap.standings[0].player).toBe("zoe")
	})

	it("will not pretend to remove a kid", async () => {
		const r = await admin("POST", "/admin/player/remove", { player: "danylo", week: WEEK })
		expect(r.status).toBe(400)
		expect((await top()).entries.map((e) => e.player)).toContain("danylo")
	})

	it("needs the same auth and header as every other admin write", async () => {
		expect((await call("POST", "/admin/player/remove", { player: "zoe" })).status).toBe(401)
		const noHeader = await call("POST", "/admin/player/remove", { player: "zoe" }, {
			Authorization: "Basic " + btoa("dad:hunter2"),
		})
		expect(noHeader.status).toBe(403)
	})
})

describe("the dashboard tells family from visitors", () => {
	it("marks a self-registered player in the standings", async () => {
		await join("zoe", "4242")
		await postAs("zoe", "4242", 20000)
		await post("danylo", 9000)

		const page = await (await admin("GET", "/admin")).text()
		expect(page).toMatch(/zoe <span class="visitor">visitor<\/span>/)
		expect(page).not.toMatch(/danylo <span class="visitor">/)
		expect(page).toMatch(/1 of 60 self-signup slots used/)
	})

	// Removed from the registry, still on the board: the row must not quietly
	// start reading as one of the kids.
	it("still marks someone who has been removed but has scores", async () => {
		await join("zoe", "4242")
		await postAs("zoe", "4242", 20000)
		env.SCORES.m.delete("player:zoe")
		env.SCORES.m.set("players:index", { value: JSON.stringify({ v: 1, players: [] }), expiresAt: null })

		expect(await (await admin("GET", "/admin")).text()).toMatch(/zoe <span class="visitor">/)
	})
})

// ------------------------------------------------------------ the roster trap

describe("the PLAYERS secret", () => {
	// The trap this closes: a stray capital used to mean the kid's own correct PIN
	// no longer signed him in as family, and instead REGISTERED him as an ordinary
	// self-signup whose name could later be handed to somebody else. ARCADE.md
	// asks for this JSON to be hand-typed to rotate the placeholder PINs, so the
	// typo has a moment scheduled for it.
	it("refuses to serve at all if a key is not a normalized id", async () => {
		env.PLAYERS = JSON.stringify({ Danylo: sha("1111") })
		const r = await join("Danylo", "1111")
		expect(r.status).toBe(500)
		expect((await r.json()).error).toMatch(/misconfigured/)
		// and above all it has not quietly created him as a self-signup
		expect(env.SCORES.m.has("player:danylo")).toBe(false)
	})

	it("refuses a key with spaces, punctuation or the wrong length just the same", async () => {
		for (const bad of [" danylo", "danylo ", "d", "a".repeat(20), "danyl0!"]) {
			env.PLAYERS = JSON.stringify({ [bad]: sha("1111") })
			expect((await post("danylo", 12000)).status).toBe(500)
		}
	})

	// This used to assert reads were "fine" and never look at what they said. They
	// said every kid was a visitor: `familyRoster` returning null was swallowed by
	// `|| {}` on every read path, so the badge added to protect the kids inverted
	// and called all three of them strangers, with no error anywhere.
	it("refuses reads too, rather than serving a board with no family on it", async () => {
		await post("danylo", 12000)
		env.PLAYERS = JSON.stringify({ Danylo: sha("1111") })

		for (const path of ["/g/nova/top", "/joint", "/admin/players"]) {
			const r = await (path === "/admin/players" ? admin("GET", path) : call("GET", path))
			expect(r.status, path).toBe(500)
			expect((await r.json()).error, path).toMatch(/misconfigured/)
		}
	})

	// …except the dashboard, which is where you go to look when something is
	// wrong. It stays reachable and says what is broken, and marks nobody rather
	// than marking everybody wrongly.
	it("still renders the dashboard, unmarked, and says what to fix", async () => {
		await post("danylo", 12000)
		env.PLAYERS = JSON.stringify({ Danylo: sha("1111") })

		const r = await admin("GET", "/admin")
		expect(r.status).toBe(200)
		const page = await r.text()
		expect(page).toMatch(/danylo/)
		expect(page).toMatch(/PLAYERS/)
		expect(page).not.toMatch(/class="visitor"/)
	})

	it("says so rather than serving when the secret isn't even JSON", async () => {
		env.PLAYERS = "{oops"
		expect((await post("danylo", 12000)).status).toBe(500)
	})
})

// ------------------------------------------------------------ tombstones

describe("a removed player stays removed", () => {
	beforeEach(async () => {
		await join("troll", "4242")
		await postAs("troll", "4242", 20000)
		await admin("POST", "/admin/player/remove", { player: "troll", week: WEEK })
	})

	// Without this the dashboard's only enforcement action is a suggestion: the
	// person you just threw off signs up again with the same two words.
	it("refuses the same name and PIN straight back", async () => {
		const r = await join("troll", "4242")
		expect(r.status).toBe(403)
		expect((await r.json()).error).toMatch(/taken/)
		expect((await postAs("troll", "4242", 9000)).status).toBe(403)
	})

	it("refuses a different PIN too, and does not free a slot", async () => {
		expect((await join("troll", "9999")).status).toBe(403)
		const d = await (await admin("GET", "/admin/players")).json()
		expect(d.open).toEqual([])
		expect(d.banned.map((b) => b.id)).toEqual(["troll"])
	})

	it("can be let back in", async () => {
		expect((await admin("POST", "/admin/player/restore", { player: "troll" })).status).toBe(200)
		expect((await join("troll", "1234")).status).toBe(200)
		const d = await (await admin("GET", "/admin/players")).json()
		expect(d.banned).toEqual([])
		expect(d.open.map((p) => p.id)).toEqual(["troll"])
	})
})

describe("clearing a squat", () => {
	beforeEach(async () => {
		for (const name of ["squata", "squatb", "squatc"]) {
			await join(name, "4242")
			await postAs(name, "4242", 9000)
		}
	})

	it("removes every self-signup at once, and their scores", async () => {
		const r = await admin("POST", "/admin/players/purge", { week: WEEK })
		expect(r.status).toBe(200)
		expect((await r.json()).removed.sort()).toEqual(["squata", "squatb", "squatc"])
		expect((await top()).entries).toEqual([])
		expect((await (await admin("GET", "/admin/players")).json()).open).toEqual([])
	})

	it("leaves the kids alone", async () => {
		await post("danylo", 12000)
		await admin("POST", "/admin/players/purge", { week: WEEK })
		expect((await top()).entries.map((e) => e.player)).toEqual(["danylo"])
		expect((await post("mike", 30000)).status).toBe(200)
	})

	it("can spare the friends who signed up after the squat", async () => {
		env.__NOW = NOW + 60_000
		await join("realfriend", "5555")
		const r = await admin("POST", "/admin/players/purge", { week: WEEK, before: NOW + 1 })
		expect((await r.json()).removed.sort()).toEqual(["squata", "squatb", "squatc"])
		expect((await (await admin("GET", "/admin/players")).json()).open.map((p) => p.id)).toEqual(["realfriend"])
	})

	it("refuses on a closed week, like every other removal", async () => {
		await admin("POST", `/admin/close?week=${WEEK}&force=1`)
		expect((await admin("POST", "/admin/players/purge", { week: WEEK })).status).toBe(409)
	})

	it("needs the same auth and header as every other admin write", async () => {
		expect((await call("POST", "/admin/players/purge", { week: WEEK })).status).toBe(401)
		const noHeader = await call("POST", "/admin/players/purge", { week: WEEK }, {
			Authorization: "Basic " + btoa("dad:hunter2"),
		})
		expect(noHeader.status).toBe(403)
	})
})

// ------------------------------------------------------------ the dashboard

describe("the dashboard survives a corrupt registry", () => {
	beforeEach(async () => {
		await post("danylo", 12000)
		env.SCORES.m.set("players:index", { value: JSON.stringify({ v: 1, players: "nope" }), expiresAt: null })
	})

	// It is worth refusing to WRITE over a corrupt registry. It is not worth
	// refusing to show a week's standings, the flag column and the close button
	// for — which is what a 500 here used to take out, with no way back from
	// inside the UI.
	it("still renders the standings and says which key is bad", async () => {
		const r = await admin("GET", "/admin")
		expect(r.status).toBe(200)
		const page = await r.text()
		expect(page).toMatch(/danylo/)
		expect(page).toMatch(/players:index/)
		expect(page).toMatch(/is corrupt/)
	})

	it("still closes the week", async () => {
		expect((await admin("POST", `/admin/close?week=${WEEK}&force=1`)).status).toBe(200)
	})

	// The JSON route keeps the old behaviour: a caller asking specifically for the
	// registry should hear that it is broken, not be handed an empty list.
	it("still refuses on the players endpoint itself", async () => {
		expect((await admin("GET", "/admin/players")).status).toBe(500)
	})
})

describe("the remove button", () => {
	// It rendered as an onclick whose own quotes closed the HTML attribute, so the
	// handler never compiled and clicking the one control that gets a stranger off
	// a cash board did nothing at all. Every test at the time called the endpoint
	// directly, so the suite stayed green over a dead button.
	it("renders with the id in an attribute that survives quoting", async () => {
		await join("zoe", "4242")
		const page = await (await admin("GET", "/admin")).text()
		expect(page).toMatch(/<button class="tiny drop" data-player="zoe">/)
		// No inline handler anywhere carries a player id — that is the whole fix.
		expect(page).not.toMatch(/onclick="[a-z_]+\((?!\)|true|false)/i)
	})

	it("has a handler bound to it by the page script", async () => {
		await join("zoe", "4242")
		const page = await (await admin("GET", "/admin")).text()
		expect(page).toMatch(/querySelectorAll\("button\.drop"\)/)
		expect(page).toMatch(/btn\.dataset\.player/)
	})

	it("escapes a name that would otherwise break out of the attribute", async () => {
		// normalizeName already makes this impossible from /join; the escaping is
		// the belt to those braces, because the failure mode is script injection on
		// the one page that can freeze a week and record a payout.
		const nasty = String.fromCharCode(34) + "><script>x</script>"
		env.SCORES.m.set("players:index", {
			value: JSON.stringify({ v: 1, players: [{ id: nasty, at: NOW }], banned: [] }),
			expiresAt: null,
		})
		const page = await (await admin("GET", "/admin")).text()
		expect(page).not.toMatch(/<script>x<\/script>/)
	})
})

describe("visitors are marked where the kids can see them", () => {
	it("marks non-family players on the public game board", async () => {
		await join("zoe", "4242")
		await postAs("zoe", "4242", 20000)
		await post("danylo", 9000)
		const d = await top()
		expect(d.entries.map((e) => [e.player, e.visitor])).toEqual([
			["zoe", true],
			["danylo", false],
		])
	})

	it("marks them on the joint board too", async () => {
		await join("zoe", "4242")
		await postAs("zoe", "4242", 20000)
		await post("danylo", 9000)
		const d = await (await call("GET", "/joint")).json()
		expect(d.standings.map((p) => [p.player, p.visitor])).toEqual([
			["zoe", true],
			["danylo", false],
		])
		expect(d.perGame.nova.places.map((p) => p.visitor)).toEqual([true, false])
	})

	it("marks a name that only LOOKS like a kid's", async () => {
		// Rejected at signup now, so it can only reach a board that predates the
		// rule — which is exactly when the badge earns its place.
		env.SCORES.m.set("wk:nova:" + WEEK, {
			value: JSON.stringify({
				v: 2,
				game: "nova",
				week: WEEK,
				entries: [{ player: "danylо", score: 30000, at: NOW, stats: {}, runs: 1 }],
			}),
			expiresAt: null,
		})
		const d = await top()
		expect(d.entries[0].visitor).toBe(true)
	})
})


describe("a name that re-normalises to something else", () => {
	// The blocker this closes: the remove button hands back the id it rendered, so
	// a name whose normalisation was not a fixed point resolved to a player who
	// did not exist. The button alerted "Removed", reloaded, and left the row —
	// the same silent no-op the button was rebuilt to stop being.
	const TRICKY = "İvil"

	it("registers as one stable id", async () => {
		const r = await join(TRICKY, "4242")
		expect(r.status).toBe(200)
		const { player } = await r.json()
		// Whatever it normalises to, signing in again must reach the same account.
		expect((await (await join(player, "4242")).json())).toMatchObject({ player, created: false })
	})

	it("can actually be removed, scores and all", async () => {
		const { player } = await (await join(TRICKY, "4242")).json()
		await postAs(player, "4242", 20000)
		expect((await top()).entries.map((e) => e.player)).toEqual([player])

		const r = await admin("POST", "/admin/player/remove", { player, week: WEEK })
		expect(await r.json()).toMatchObject({ ok: true, player, removed: true, cleared: { nova: 1 } })
		expect((await top()).entries).toEqual([])

		const listed = await (await admin("GET", "/admin/players")).json()
		expect(listed.open).toEqual([])
		expect(listed.banned.map((b) => b.id)).toEqual([player])
		// and no phantom second tombstone under a differently-normalised id
		expect(listed.banned).toHaveLength(1)
	})

	it("can be let back in again", async () => {
		const { player } = await (await join(TRICKY, "4242")).json()
		await admin("POST", "/admin/player/remove", { player, week: WEEK })
		expect((await admin("POST", "/admin/player/restore", { player })).status).toBe(200)
		expect((await (await admin("GET", "/admin/players")).json()).banned).toEqual([])
	})
})

describe("a closed week keeps its badges", () => {
	// The badge vanished from the hub the moment a week closed, because the frozen
	// snapshot has no `visitor` field — so it disappeared for exactly the week a
	// payout is decided from, while /g/:game/top still showed it. Two boards on
	// one page, disagreeing.
	it("marks visitors in the frozen standings too", async () => {
		await join("zoe", "4242")
		await postAs("zoe", "4242", 20000)
		await post("danylo", 9000)
		await admin("POST", `/admin/close?week=${WEEK}&force=1`)

		const d = await (await call("GET", `/joint?week=${WEEK}`)).json()
		expect(d.closed).toBe(true)
		expect(d.standings.map((p) => [p.player, p.visitor])).toEqual([
			["zoe", true],
			["danylo", false],
		])
		expect(d.perGame.nova.places.map((p) => p.visitor)).toEqual([true, false])
	})

	it("leaves the snapshot itself untouched", async () => {
		await join("zoe", "4242")
		await postAs("zoe", "4242", 20000)
		await admin("POST", `/admin/close?week=${WEEK}&force=1`)
		// Recomputed on read, never frozen: who is family is a property of the
		// secret, not of the week.
		const snap = await (await call("GET", `/week/${WEEK}`)).json()
		expect(snap.standings[0].visitor).toBeUndefined()
	})
})

describe("purge input", () => {
	it("refuses a cutoff that isn't a number rather than reading it as everyone", async () => {
		await join("zoe", "4242")
		for (const before of ["Infinity", "yesterday", {}, true]) {
			const r = await admin("POST", "/admin/players/purge", { week: WEEK, before })
			expect(r.status, JSON.stringify(before)).toBe(400)
		}
		expect((await (await admin("GET", "/admin/players")).json()).open).toHaveLength(1)
	})
})

describe("removal survives a corrupt board", () => {
	// clearEntries writes each game's board as it goes, so a bad one throws
	// partway. De-registering first means the player cannot post anything more
	// while that is being sorted out — the reason the order was swapped back once
	// removal started leaving a tombstone instead of a hole.
	it("de-registers the player even when clearing their scores fails", async () => {
		await join("troll", "4242")
		await postAs("troll", "4242", 20000)
		env.SCORES.m.set("wk:fish:" + WEEK, { value: JSON.stringify({ v: 9, junk: true }), expiresAt: null })

		const r = await admin("POST", "/admin/player/remove", { player: "troll", week: WEEK })
		expect(r.status).toBe(500)
		// but they are already off the registry and can no longer post
		expect((await postAs("troll", "4242", 30000)).status).toBe(403)
		expect((await join("troll", "4242")).status).toBe(403)
	})
})
