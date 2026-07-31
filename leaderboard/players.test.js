// The naming rules and the KV registry behind open signup.
//
// The name rules get their own file because they are the one thing two deploy
// targets each implement: this copy is the authority, and
// site/shared/leaderboard.test.js runs the SAME case table (test/name-cases.js)
// against the client's copy. If the two ever drift, one of those two files fails.

import { beforeEach, describe, expect, it } from "vitest"
import { NAME_CASES, NAME_LIMITS, PIN_CASES, RESERVED_NAMES } from "../test/name-cases.js"
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

describe("normalizeName", () => {
	for (const [input, want, why] of NAME_CASES) {
		it(`${JSON.stringify(input)} → ${JSON.stringify(want)} (${why})`, () => {
			expect(normalizeName(input)).toBe(want)
		})
	}

	/**
	 * Normalising an already-normalised id must be a no-op.
	 *
	 * It wasn't, once: the character filter ran before `.toLowerCase()`, and "İ"
	 * lowercases to "i" plus a combining dot that the filter would have stripped.
	 * So `normalizeName("İvil")` gave `i̇vil` and normalising THAT gave `ivil` — a
	 * different player. Everything downstream assumes otherwise, and the dashboard
	 * remove button in particular hands back the id it was rendered with, so it
	 * reported success while removing somebody who did not exist.
	 */
	it("is idempotent, including for letters whose lowercase grows a mark", () => {
		const probes = [
			...NAME_CASES.map(([input]) => input),
			"İvil",
			"İ".repeat(20),
			"ǅoe",
			"ﬁona",
			"Ⅻzoe",
			"ǰoe",
			"ẞoe",
		]
		for (const probe of probes) {
			const once = normalizeName(probe)
			expect(normalizeName(once), `re-normalising ${JSON.stringify(probe)} → ${JSON.stringify(once)}`).toBe(once)
		}
	})

	it("survives values that aren't strings", () => {
		expect(normalizeName(null)).toBe("")
		expect(normalizeName(undefined)).toBe("")
		expect(normalizeName(12345)).toBe("")
		expect(normalizeName({})).toBe("")
	})
})

describe("pinProblem", () => {
	for (const [pin, ok, why] of PIN_CASES) {
		it(`${JSON.stringify(pin)} is ${ok ? "fine" : "no good"} (${why})`, () => {
			expect(pinProblem(pin) === null).toBe(ok)
		})
	}
})

describe("the rules the client also implements", () => {
	// normalizeName had a shared table from the start; these did not, which left
	// most of the duplication unchecked.
	it("reserves the same names", () => {
		expect([...RESERVED].sort()).toEqual([...RESERVED_NAMES].sort())
	})

	it("uses the same length bounds", () => {
		expect({ min: LIMITS.nameMin, max: LIMITS.nameMax }).toEqual(NAME_LIMITS)
	})

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
		expect(await readIndex(env)).toEqual({ v: 1, players: [], banned: [] })
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

	it("removes a player from the listing, leaving a tombstone behind", async () => {
		await registerPlayer(env, { id: "zoe", pinHash: "a", at: 10 })
		await registerPlayer(env, { id: "mo", pinHash: "b", at: 11 })

		expect(await removePlayer(env, "zoe", 12)).toBe(true)
		expect(await readPlayer(env, "zoe")).toMatchObject({ banned: true })
		expect((await readIndex(env)).players.map((p) => p.id)).toEqual(["mo"])
		// Removing someone who was never here still holds the name — that is what
		// pre-emptively reserving a name looks like — but it says they weren't here.
		expect(await removePlayer(env, "ghost", 12)).toBe(false)
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

describe("throttle", () => {
	const req = (ip) => new Request("https://x/join", { headers: ip ? { "CF-Connecting-IP": ip } : {} })

	/** Stands in for the edge binding: allows `limit` calls per key, then refuses. */
	const limiter = (limit) => {
		const seen = new Map()
		const calls = []
		return {
			calls,
			async limit({ key }) {
				calls.push(key)
				const n = (seen.get(key) || 0) + 1
				seen.set(key, n)
				return { success: n <= limit }
			},
		}
	}

	// The whole reason this moved off KV. The counter it replaced wrote on every
	// attempt, which is the mistake worker.js's own header warns about.
	it("costs no KV writes at all", async () => {
		const writes = []
		env.SCORES.put = async (k) => writes.push(k)
		env.LIMITER = limiter(2)
		await throttle(env, req("9.9.9.9"), "join")
		await throttle(env, req("9.9.9.9"), "join")
		await throttle(env, req("9.9.9.9"), "join")
		expect(writes).toEqual([])
	})

	it("refuses once the budget is spent", async () => {
		env.LIMITER = limiter(2)
		expect(await throttle(env, req("9.9.9.9"), "join")).toBeNull()
		expect(await throttle(env, req("9.9.9.9"), "join")).toBeNull()
		expect(await throttle(env, req("9.9.9.9"), "join")).toMatch(/too many/)
	})

	it("budgets per address, so one guesser doesn't lock out the house", async () => {
		env.LIMITER = limiter(1)
		await throttle(env, req("9.9.9.9"), "join")
		expect(await throttle(env, req("1.1.1.1"), "join")).toBeNull()
	})

	// Otherwise somebody walking PINs at the score endpoint also jams the signup
	// form for the friend sitting next to them.
	it("keeps separate budgets per bucket", async () => {
		env.LIMITER = limiter(1)
		await throttle(env, req("9.9.9.9"), "auth")
		expect(await throttle(env, req("9.9.9.9"), "join")).toBeNull()
		expect(env.LIMITER.calls).toEqual(["auth:9.9.9.9", "join:9.9.9.9"])
	})

	// A throttle that turns into an outage is worse than no throttle, and the
	// binding is a beta product whose likeliest failure is exactly this.
	it("fails open when the binding throws, not just when it is missing", async () => {
		env.LIMITER = {
			async limit() {
				throw new Error("boom")
			},
		}
		await expect(throttle(env, req("9.9.9.9"), "join")).resolves.toBeNull()
	})

	it("fails open with no binding, and with no client IP", async () => {
		expect(await throttle(env, req("9.9.9.9"), "join")).toBeNull() // no binding at all
		env.LIMITER = limiter(0)
		// Cloudflare always sets CF-Connecting-IP and a client cannot suppress it,
		// so a missing one means we are off the edge — where this was never a
		// control. It must not become an outage instead.
		expect(await throttle(env, req(null), "join")).toBeNull()
		expect(env.LIMITER.calls).toEqual([])
	})
})

describe("tombstones", () => {
	it("holds the name after a removal, so signing up again is refused", async () => {
		await registerPlayer(env, { id: "troll", pinHash: "a", at: 10 })
		await removePlayer(env, "troll", 20)

		const stone = await readPlayer(env, "troll")
		expect(stone).toMatchObject({ id: "troll", banned: true })
		expect(stone.pinHash).toBeUndefined()
		expect((await readIndex(env)).players).toEqual([])
		expect((await readIndex(env)).banned).toEqual([{ id: "troll", at: 20 }])
	})

	it("lets a ban be lifted, freeing the name again", async () => {
		await registerPlayer(env, { id: "troll", pinHash: "a", at: 10 })
		await removePlayer(env, "troll", 20)

		expect(await restorePlayer(env, "troll")).toBe(true)
		expect(await readPlayer(env, "troll")).toBeNull()
		expect((await readIndex(env)).banned).toEqual([])
		// and it is a no-op for somebody who was never banned
		expect(await restorePlayer(env, "troll")).toBe(false)
	})

	// The player you most need to remove must not be the one you cannot.
	it("removes a player whose record is too corrupt to read", async () => {
		env.SCORES.m.set("player:troll", JSON.stringify({ v: 99, junk: true }))
		await expect(readPlayer(env, "troll")).rejects.toBeInstanceOf(PlayerShapeError)

		expect(await removePlayer(env, "troll", 20)).toBe(true)
		expect(await readPlayer(env, "troll")).toMatchObject({ banned: true })
	})

	it("reads an index written before bans existed", async () => {
		env.SCORES.m.set("players:index", JSON.stringify({ v: 1, players: [{ id: "zoe", at: 1 }] }))
		expect((await readIndex(env)).banned).toEqual([])
		// but a wrong shape is still a wrong shape
		env.SCORES.m.set("players:index", JSON.stringify({ v: 1, players: [], banned: "nope" }))
		await expect(readIndex(env)).rejects.toBeInstanceOf(PlayerShapeError)
	})
})

describe("purge", () => {
	beforeEach(async () => {
		await registerPlayer(env, { id: "squat1", pinHash: "a", at: 100 })
		await registerPlayer(env, { id: "squat2", pinHash: "a", at: 200 })
		await registerPlayer(env, { id: "realfriend", pinHash: "a", at: 900 })
	})

	it("clears a squat without taking out the friends who came after it", async () => {
		expect(await purgePlayers(env, { before: 500, at: 1000 })).toEqual(["squat1", "squat2"])
		expect((await readIndex(env)).players.map((p) => p.id)).toEqual(["realfriend"])
		expect(await readPlayer(env, "squat1")).toMatchObject({ banned: true })
		expect(await readPlayer(env, "realfriend")).toMatchObject({ pinHash: "a" })
	})

	it("takes everyone when no cutoff is given", async () => {
		expect((await purgePlayers(env, { before: Infinity, at: 1000 })).sort()).toEqual([
			"realfriend",
			"squat1",
			"squat2",
		])
		expect((await readIndex(env)).players).toEqual([])
	})

	it("writes the index once, not once per player", async () => {
		let indexWrites = 0
		const put = env.SCORES.put.bind(env.SCORES)
		env.SCORES.put = async (k, v) => {
			if (k === "players:index") indexWrites++
			return put(k, v)
		}
		await purgePlayers(env, { before: Infinity, at: 1000 })
		expect(indexWrites).toBe(1)
	})

	it("does nothing, and writes nothing, when there is nobody to purge", async () => {
		const writes = []
		env.SCORES.put = async (k) => writes.push(k)
		expect(await purgePlayers(env, { before: 1, at: 1000 })).toEqual([])
		expect(writes).toEqual([])
	})
})
