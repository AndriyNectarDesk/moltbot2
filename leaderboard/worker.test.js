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
		await post("mike", 3, { landed: 3, heaviest: 2200, species: 2, flow: 1 }, "fish")
		expect((await top("nova")).entries.map((e) => e.player)).toEqual(["danylo"])
		expect((await top("fish")).entries.map((e) => e.player)).toEqual(["mike"])
	})

	it("hides flags and rate state from players", async () => {
		await post("danylo", 12000)
		const d = await top()
		expect(Object.keys(d.entries[0]).sort()).toEqual(["at", "player", "score", "stats"])
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
		const r = await post("mike", 4200, { landed: 6, heaviest: 4200, species: 3, flow: 2 }, "fish")
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
			pin: "0000",
			score: 100,
			stats: { wave: 1, kills: 1, combo: 1 },
		})
		expect(r.status).toBe(403)
		expect((await r.json()).error).toBe("wrong pin")
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
		await post("mike", 5000, { landed: 6, heaviest: 5000, species: 3, flow: 2 }, "fish")
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
