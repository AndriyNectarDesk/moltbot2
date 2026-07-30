// The naming rules and the KV registry behind open signup.
//
// The name rules get their own file because they are the one thing two deploy
// targets each implement: this copy is the authority, and
// site/shared/leaderboard.test.js runs the SAME case table (test/name-cases.js)
// against the client's copy. If the two ever drift, one of those two files fails.

import { beforeEach, describe, expect, it } from "vitest"
import { NAME_CASES } from "../test/name-cases.js"
import {
	LIMITS,
	PlayerShapeError,
	RESERVED,
	joinThrottle,
	normalizeName,
	pinProblem,
	readIndex,
	readPlayer,
	registerPlayer,
	removePlayer,
	touchIndex,
} from "./players.js"

describe("normalizeName", () => {
	for (const [input, want, why] of NAME_CASES) {
		it(`${JSON.stringify(input)} → ${JSON.stringify(want)} (${why})`, () => {
			expect(normalizeName(input)).toBe(want)
		})
	}

	it("survives values that aren't strings", () => {
		expect(normalizeName(null)).toBe("")
		expect(normalizeName(undefined)).toBe("")
		expect(normalizeName(12345)).toBe("")
		expect(normalizeName({})).toBe("")
	})
})

describe("pinProblem", () => {
	it("accepts 4 to 8 digits", () => {
		expect(pinProblem("1111")).toBeNull()
		expect(pinProblem("12345678")).toBeNull()
	})

	it("rejects anything else", () => {
		expect(pinProblem("123")).toBeTruthy()
		expect(pinProblem("123456789")).toBeTruthy()
		expect(pinProblem("12a4")).toBeTruthy()
		expect(pinProblem("")).toBeTruthy()
		expect(pinProblem(null)).toBeTruthy()
	})
})

describe("reserved names", () => {
	it("keeps guest out of the registry", () => {
		// "guest" is what the client calls a local-only player, so a registered
		// player by that name would put a real row under the label the UI uses for
		// "not posting anywhere".
		expect(RESERVED.has("guest")).toBe(true)
		expect(normalizeName("GUEST")).toBe("guest")
	})
})

// ---------------------------------------------------------------- registry

function makeKV() {
	const m = new Map()
	return {
		m,
		async get(k, type) {
			const v = m.get(k)
			if (v === undefined) return null
			return type === "json" ? JSON.parse(v) : v
		},
		async put(k, v) {
			m.set(k, v)
		},
		async delete(k) {
			m.delete(k)
		},
	}
}

let env

beforeEach(() => {
	env = { SCORES: makeKV() }
})

describe("registry", () => {
	it("stores a player and lists them", async () => {
		expect(await registerPlayer(env, { id: "zoe", pinHash: "abc", at: 10 })).toEqual({ ok: true })
		expect(await readPlayer(env, "zoe")).toMatchObject({ id: "zoe", pinHash: "abc", kind: "open" })
		expect((await readIndex(env)).players).toEqual([{ id: "zoe", at: 10 }])
	})

	it("is absent, not empty, for a name nobody has claimed", async () => {
		expect(await readPlayer(env, "nobody-here")).toBeNull()
		expect(await readIndex(env)).toEqual({ v: 1, players: [] })
	})

	it("keeps the listing sorted so the dashboard is stable", async () => {
		await registerPlayer(env, { id: "zoe", pinHash: "a", at: 3 })
		await registerPlayer(env, { id: "ali", pinHash: "b", at: 1 })
		await registerPlayer(env, { id: "mo", pinHash: "c", at: 2 })
		expect((await readIndex(env)).players.map((p) => p.id)).toEqual(["ali", "mo", "zoe"])
	})

	it("refuses to grow past the ceiling", async () => {
		for (let i = 0; i < LIMITS.maxOpenPlayers; i++) {
			await registerPlayer(env, { id: `kid${i}`, pinHash: "a", at: i })
		}
		const res = await registerPlayer(env, { id: "onemore", pinHash: "a", at: 99 })
		expect(res.status).toBe(409)
		expect(await readPlayer(env, "onemore")).toBeNull()
	})

	// The record is written before the index, so a failure between the two leaves
	// an account that works but isn't listed. That is the survivable order, and
	// this is the repair.
	it("re-lists a player whose index write was lost", async () => {
		await registerPlayer(env, { id: "zoe", pinHash: "a", at: 10 })
		env.SCORES.m.set("players:index", JSON.stringify({ v: 1, players: [] }))

		expect(await touchIndex(env, "zoe", 10)).toBe(true)
		expect((await readIndex(env)).players).toEqual([{ id: "zoe", at: 10 }])
		// and it is a no-op the second time
		expect(await touchIndex(env, "zoe", 10)).toBe(false)
	})

	it("removes a player from both the record and the listing", async () => {
		await registerPlayer(env, { id: "zoe", pinHash: "a", at: 10 })
		await registerPlayer(env, { id: "mo", pinHash: "b", at: 11 })

		expect(await removePlayer(env, "zoe")).toBe(true)
		expect(await readPlayer(env, "zoe")).toBeNull()
		expect((await readIndex(env)).players.map((p) => p.id)).toEqual(["mo"])
		// removing someone who was never here changes nothing and says so
		expect(await removePlayer(env, "ghost")).toBe(false)
	})

	// Reading a corrupt registry as "no players" would un-register every friend
	// mid-week and free their names for anyone to claim. Same bet as the boards.
	it("throws rather than treating corrupt storage as empty", async () => {
		env.SCORES.m.set("players:index", JSON.stringify({ v: 1, players: "not an array" }))
		await expect(readIndex(env)).rejects.toBeInstanceOf(PlayerShapeError)

		env.SCORES.m.set("player:zoe", JSON.stringify({ v: 99, id: "zoe" }))
		await expect(readPlayer(env, "zoe")).rejects.toBeInstanceOf(PlayerShapeError)
	})
})

describe("join throttle", () => {
	const req = (ip) => new Request("https://x/join", { headers: ip ? { "CF-Connecting-IP": ip } : {} })

	it("lets a typo-prone kid keep trying, then stops a guesser", async () => {
		for (let i = 0; i < LIMITS.joinTriesPerWindow; i++) {
			expect(await joinThrottle(env, req("9.9.9.9"))).toBeNull()
		}
		expect(await joinThrottle(env, req("9.9.9.9"))).toMatch(/too many/)
	})

	it("budgets per IP, so one guesser doesn't lock out the house", async () => {
		for (let i = 0; i < LIMITS.joinTriesPerWindow; i++) await joinThrottle(env, req("9.9.9.9"))
		expect(await joinThrottle(env, req("1.1.1.1"))).toBeNull()
	})

	it("fails open with no IP header, so the worker is testable off Cloudflare", async () => {
		for (let i = 0; i < LIMITS.joinTriesPerWindow + 5; i++) {
			expect(await joinThrottle(env, req(null))).toBeNull()
		}
	})
})
