// The leaderboard client's storage contract.
//
// This is the only cross-game logic in the site and the only place a bug
// silently corrupts data: three games share one origin, so getting the key
// namespacing wrong means they trample each other's saved scores, and getting
// the migration wrong resets Danylo's saved name and personal best on the day
// the arcade ships.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { GUEST, Leaderboard, ROSTER, cleanName, normalizeName } from "./leaderboard.js"
import { NAME_CASES } from "../../test/name-cases.js"

/** Just enough localStorage to exercise the real code paths. */
function installStorage() {
	const store = new Map()
	globalThis.localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
		clear: () => store.clear(),
	}
	return store
}

let store

beforeEach(() => {
	store = installStorage()
	vi.restoreAllMocks()
})

describe("key namespacing", () => {
	it("keeps each game's scores under its own key", () => {
		const nova = new Leaderboard("nova", "https://board.test")
		const fish = new Leaderboard("fish", "https://board.test")
		nova._saveLocal({ player: "danylo", score: 100, at: 1 })
		fish._saveLocal({ player: "mike", score: 7, at: 1 })

		expect(nova.localEntries().map((e) => e.score)).toEqual([100])
		expect(fish.localEntries().map((e) => e.score)).toEqual([7])
		expect(store.has("play.scores.nova")).toBe(true)
		expect(store.has("play.scores.fish")).toBe(true)
	})

	it("shares one identity across games", () => {
		const nova = new Leaderboard("nova", "https://board.test")
		nova.setName("danylo")
		nova.setPin("1111")

		// A different game, constructed fresh, should already know who you are.
		const fish = new Leaderboard("fish", "https://board.test")
		expect(fish.name).toBe("danylo")
		expect(fish.pin).toBe("1111")
	})

	it("does not let one game's score land on another's board", () => {
		const nova = new Leaderboard("nova", "https://board.test")
		nova._saveLocal({ player: "danylo", score: 100, at: 1 })
		expect(new Leaderboard("city", "https://board.test").localEntries()).toEqual([])
	})
})

describe("legacy migration", () => {
	// v1 stored whatever was typed, so the one kid who actually has legacy state
	// has "Danylo" — which matches no roster id. Left as-is he'd land on the
	// game-over screen with nothing selected, no PIN prompt and local-only
	// saving, which is the exact player this shim exists to protect.
	it("carries the old name over and makes it postable", () => {
		store.set("nectarnova.name", JSON.stringify("Danylo"))
		store.set("nectarnova.scores", JSON.stringify([{ name: "Danylo", score: 3100, wave: 2 }]))

		const nova = new Leaderboard("nova", "https://board.test")
		expect(nova.name).toBe("danylo")
		expect(nova.isRostered).toBe(true)
		expect(nova.personalBest()).toBe(3100)
	})

	it("leaves a non-roster old name alone, as a guest", () => {
		store.set("nectarnova.name", JSON.stringify("Grandma"))
		const b = new Leaderboard("nova", "https://board.test")
		expect(b.name).toBe("Grandma")
		expect(b.isRostered).toBe(false)
	})

	it("is idempotent across constructions", () => {
		store.set("nectarnova.name", JSON.stringify("Danylo"))
		store.set("nectarnova.scores", JSON.stringify([{ score: 3100 }]))

		new Leaderboard("nova", "https://board.test")
		const b = new Leaderboard("nova", "https://board.test")
		b._saveLocal({ player: "danylo", score: 50, at: 1 })
		// Re-running must not re-import the old rows on top of the new ones.
		const c = new Leaderboard("nova", "https://board.test")
		expect(c.localEntries()).toHaveLength(2)
	})

	it("never clobbers a name already set under the new key", () => {
		store.set("play.name", JSON.stringify("sofia"))
		store.set("nectarnova.name", JSON.stringify("Danylo"))
		expect(new Leaderboard("nova", "https://board.test").name).toBe("sofia")
	})

	it("does not give Nova's old scores to another game", () => {
		store.set("nectarnova.scores", JSON.stringify([{ score: 3100 }]))
		expect(new Leaderboard("fish", "https://board.test").localEntries()).toEqual([])
	})

	it("survives storage being unavailable", () => {
		globalThis.localStorage = {
			getItem() {
				throw new Error("denied")
			},
			setItem() {
				throw new Error("denied")
			},
		}
		// Private mode and some embedded webviews throw on access; the game must
		// still start, just without a saved board.
		const b = new Leaderboard("nova", "https://board.test")
		expect(b.name).toBe("")
		expect(b.localEntries()).toEqual([])
	})
})

describe("identity", () => {
	it("recognises roster players and lowercases them", () => {
		const b = new Leaderboard("nova", "https://board.test")
		expect(b.setName("DANYLO")).toBe("danylo")
		expect(b.isRostered).toBe(true)
		expect(ROSTER).toContain("danylo")
	})

	it("treats anyone else as a guest who cannot post", () => {
		const b = new Leaderboard("nova", "https://board.test")
		b.setName("")
		b.setPin("1111")
		expect(b.isRostered).toBe(false)
		expect(b.canPost).toBe(false)
	})

	it("needs a pin before it will post", () => {
		const b = new Leaderboard("nova", "https://board.test")
		b.setName("danylo")
		expect(b.canPost).toBe(false)
		b.setPin("1111")
		expect(b.canPost).toBe(true)
		b.forgetPin()
		expect(b.canPost).toBe(false)
	})

	it("cannot post with no board configured", () => {
		const b = new Leaderboard("nova", "")
		b.setName("danylo")
		b.setPin("1111")
		expect(b.shared).toBe(false)
		expect(b.canPost).toBe(false)
	})
})

describe("submit", () => {
	const ok = (body) =>
		vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body })

	it("sends the game in the path and the pin in the body", async () => {
		globalThis.fetch = ok({ rank: 1, points: 11, entries: [], improved: true, week: "2026-07-27" })
		const b = new Leaderboard("nova", "https://board.test")
		b.setName("danylo")
		b.setPin("1111")

		const res = await b.submit({ score: 12000, stats: { wave: 6, kills: 40, combo: 5 } })

		const [url, opts] = globalThis.fetch.mock.calls[0]
		expect(url).toBe("https://board.test/g/nova/score")
		const sent = JSON.parse(opts.body)
		expect(sent).toMatchObject({ player: "danylo", pin: "1111", score: 12000 })
		expect(sent.stats).toEqual({ wave: 6, kills: 40, combo: 5 })
		expect(res).toMatchObject({ ok: true, shared: true, rank: 1, points: 11 })
	})

	it("saves locally even when the post succeeds", async () => {
		globalThis.fetch = ok({ rank: 1, entries: [] })
		const b = new Leaderboard("nova", "https://board.test")
		b.setName("danylo")
		b.setPin("1111")
		await b.submit({ score: 12000, stats: {} })
		expect(b.personalBest()).toBe(12000)
	})

	// v1 threw a bare "HTTP 403" here, so the game told the player the board was
	// unreachable when in fact their PIN was wrong — the wrong thing to go fix.
	it("reports a rejected pin as a 403 with the server's reason", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 403,
			json: async () => ({ error: "wrong pin" }),
		})
		const b = new Leaderboard("nova", "https://board.test")
		b.setName("danylo")
		b.setPin("9999")

		const res = await b.submit({ score: 12000, stats: {} })
		expect(res.ok).toBe(false)
		expect(res.status).toBe(403)
		expect(res.error).toBe("wrong pin")
		// and the run is still safe on this device
		expect(b.personalBest()).toBe(12000)
	})

	it("falls back to local on a network failure", async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline"))
		const b = new Leaderboard("nova", "https://board.test")
		b.setName("danylo")
		b.setPin("1111")

		const res = await b.submit({ score: 12000, stats: {} })
		expect(res.ok).toBe(false)
		expect(res.shared).toBe(false)
		expect(res.rank).toBe(1)
	})

	it("does not call the network for a guest", async () => {
		globalThis.fetch = vi.fn()
		const b = new Leaderboard("nova", "https://board.test")
		b.setName(GUEST === "guest" ? "" : GUEST)

		const res = await b.submit({ score: 500, stats: {} })
		expect(globalThis.fetch).not.toHaveBeenCalled()
		expect(res).toMatchObject({ ok: true, shared: false })
		expect(b.personalBest()).toBe(500)
	})

	// The game re-enables the button after a wrong PIN so the kid can retry, so
	// without this every retry appended another copy of the same run and the
	// twenty-row local table filled up with duplicates of it.
	it("does not re-save the same run on a retry", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 403,
			json: async () => ({ error: "wrong pin" }),
		})
		const b = new Leaderboard("nova", "https://board.test")
		b.setName("danylo")
		b.setPin("9999")

		await b.submit({ score: 12000, stats: {} })
		await b.submit({ score: 12000, stats: {}, skipLocal: true })
		await b.submit({ score: 12000, stats: {}, skipLocal: true })
		expect(b.localEntries()).toHaveLength(1)
	})

	it("still reports the local rank on a skipped re-save", async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline"))
		const b = new Leaderboard("nova", "https://board.test")
		b.setName("danylo")
		b.setPin("1111")
		await b.submit({ score: 12000, stats: {} })
		const res = await b.submit({ score: 12000, stats: {}, skipLocal: true })
		expect(res.rank).toBe(1)
		expect(b.localEntries()).toHaveLength(1)
	})

	// The game maps these to different messages: a wrong PIN is worth retyping,
	// an unconfigured roster is not.
	it("distinguishes a wrong pin from an unset roster", async () => {
		const b = new Leaderboard("nova", "https://board.test")
		b.setName("danylo")
		b.setPin("1111")

		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 403,
			json: async () => ({ error: "unknown player" }),
		})
		const res = await b.submit({ score: 100, stats: {} })
		expect(res.status).toBe(403)
		expect(res.error).toBe("unknown player")
		expect(/pin/i.test(res.error)).toBe(false)
	})

	it("carries improved through so the game can tell the truth", async () => {
		globalThis.fetch = ok({ rank: 2, improved: false, entries: [] })
		const b = new Leaderboard("nova", "https://board.test")
		b.setName("danylo")
		b.setPin("1111")
		const res = await b.submit({ score: 100, stats: {} })
		expect(res.improved).toBe(false)
	})

	it("omits durationMs when it is not a number", async () => {
		globalThis.fetch = ok({ rank: 1, entries: [] })
		const b = new Leaderboard("nova", "https://board.test")
		b.setName("danylo")
		b.setPin("1111")
		await b.submit({ score: 100, stats: {}, durationMs: undefined })
		expect(JSON.parse(globalThis.fetch.mock.calls[0][1].body).durationMs).toBeUndefined()
	})
})

describe("local table", () => {
	it("sorts descending and keeps at most twenty rows", () => {
		const b = new Leaderboard("nova", "")
		for (let i = 0; i < 25; i++) b._saveLocal({ player: "danylo", score: i * 10, at: i })
		const rows = b.localEntries()
		expect(rows).toHaveLength(20)
		expect(rows[0].score).toBe(240)
		expect(b.personalBest()).toBe(240)
	})

	// v1 reported "rank 21" for a run that had just been trimmed off a 20-row
	// table, which is a rank that does not exist.
	it("reports no rank for a run that did not make the table", () => {
		const b = new Leaderboard("nova", "")
		for (let i = 0; i < 20; i++) b._saveLocal({ player: "danylo", score: 1000 + i, at: i })
		expect(b._saveLocal({ player: "danylo", score: 1, at: 99 })).toBe(null)
	})
})

describe("cleanName", () => {
	it("strips markup and caps the length", () => {
		expect(cleanName("<script>alert(1)</script>Bob")).not.toMatch(/[<>]/)
		expect(cleanName("a".repeat(40))).toHaveLength(14)
	})

	it("handles nothing gracefully", () => {
		expect(cleanName(null)).toBe("")
		expect(cleanName("   ")).toBe("")
	})
})

// The same table the worker's own test runs against leaderboard/players.js. The
// client's copy of the rule only exists so the signup form can complain while
// you type; if it ever disagrees with the worker, one of these two files fails
// with the case that differs.
describe("normalizeName agrees with the worker", () => {
	for (const [input, want, why] of NAME_CASES) {
		it(`${JSON.stringify(input)} → ${JSON.stringify(want)} (${why})`, () => {
			expect(normalizeName(input)).toBe(want)
		})
	}
})

describe("signing up", () => {
	const ok = (body) => vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body })

	it("registers, then plays as that name", async () => {
		globalThis.fetch = ok({ ok: true, player: "zoe", created: true, kind: "open" })
		const b = new Leaderboard("nova", "https://board.test")

		const res = await b.join("ZOE", "4242")

		const [url, opts] = globalThis.fetch.mock.calls[0]
		expect(url).toBe("https://board.test/join")
		// Normalised before it leaves, so the id the player sees is the id the
		// board will show.
		expect(JSON.parse(opts.body)).toEqual({ player: "zoe", pin: "4242" })
		expect(res).toMatchObject({ ok: true, player: "zoe", created: true })
		expect(b.name).toBe("zoe")
		expect(b.hasIdentity).toBe(true)
		expect(b.canPost).toBe(true)
	})

	it("remembers them on this device, next to the kids", async () => {
		globalThis.fetch = ok({ ok: true, player: "zoe", created: true })
		const b = new Leaderboard("nova", "https://board.test")
		await b.join("zoe", "4242")

		// A different game, freshly constructed, offers the same button.
		expect(new Leaderboard("city", "https://board.test").knownPlayers()).toEqual(["zoe"])
	})

	it("does not list the kids as device players — they have their own buttons", async () => {
		globalThis.fetch = ok({ ok: true, player: "danylo", created: false, kind: "family" })
		const b = new Leaderboard("nova", "https://board.test")
		await b.join("danylo", "1111")
		expect(b.knownPlayers()).toEqual([])
		expect(b.name).toBe("danylo")
	})

	it("checks the obvious things before spending a request", async () => {
		globalThis.fetch = vi.fn()
		const b = new Leaderboard("nova", "https://board.test")

		expect((await b.join("z", "4242")).ok).toBe(false)
		expect((await b.join("1234", "4242")).ok).toBe(false)
		expect((await b.join("guest", "4242")).ok).toBe(false)
		expect((await b.join("zoe", "12")).ok).toBe(false)
		expect(globalThis.fetch).not.toHaveBeenCalled()
	})

	// A mistyped PIN must not quietly log a signed-in kid out and turn their next
	// run into a local-only guest score.
	it("leaves the current player alone when it fails", async () => {
		const b = new Leaderboard("nova", "https://board.test")
		b.setName("danylo")
		b.setPin("1111")

		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 403,
			json: async () => ({ error: "that name is taken — if it's yours, check the PIN" }),
		})
		const res = await b.join("zoe", "9999")

		expect(res.ok).toBe(false)
		expect(res.status).toBe(403)
		expect(res.error).toMatch(/taken/)
		expect(b.name).toBe("danylo")
		expect(b.pin).toBe("1111")
		expect(b.knownPlayers()).toEqual([])
	})

	it("keeps a typed name with no board configured, rather than posting nowhere", async () => {
		globalThis.fetch = vi.fn()
		const b = new Leaderboard("nova", "")
		const res = await b.join("zoe", "4242")
		expect(res).toMatchObject({ ok: true, player: "zoe", shared: false })
		expect(b.name).toBe("zoe")
		expect(b.canPost).toBe(false)
		expect(globalThis.fetch).not.toHaveBeenCalled()
	})

	it("survives a device list that isn't a list", () => {
		localStorage.setItem("play.players", JSON.stringify({ zoe: true }))
		expect(new Leaderboard("nova", "https://board.test").knownPlayers()).toEqual([])
	})

	it("stops the button row growing without bound at a party", async () => {
		globalThis.fetch = vi.fn()
		const b = new Leaderboard("nova", "")
		for (let i = 0; i < 12; i++) await b.join(`kid${i}`, "4242")
		const known = b.knownPlayers()
		expect(known).toHaveLength(8)
		expect(known.at(-1)).toBe("kid11")
	})
})

describe("who may post", () => {
	// The bug this whole change exists to fix: a friend picked GUEST because it
	// was the only thing left, and GUEST could never reach the board.
	it("lets anyone with a name and a pin post, not just the three kids", () => {
		const b = new Leaderboard("nova", "https://board.test")
		b.setName("zoe")
		b.setPin("4242")
		expect(b.isRostered).toBe(false)
		expect(b.hasIdentity).toBe(true)
		expect(b.canPost).toBe(true)
	})

	it("still treats a nameless player as a guest who saves locally", () => {
		const b = new Leaderboard("nova", "https://board.test")
		b.setName("")
		b.setPin("4242")
		expect(b.hasIdentity).toBe(false)
		expect(b.canPost).toBe(false)
	})

	it("sends the guest label with a local run", async () => {
		globalThis.fetch = vi.fn()
		const b = new Leaderboard("nova", "https://board.test")
		b.setName("")
		const res = await b.submit({ score: 900, stats: {} })
		expect(res).toMatchObject({ ok: true, shared: false })
		expect(b.localEntries()[0].player).toBe(GUEST)
		expect(globalThis.fetch).not.toHaveBeenCalled()
	})
})
