// Prize points and standings.
//
// This is the arithmetic a kid will argue about, so it gets tested directly
// rather than only through the worker.

import { describe, expect, it } from "vitest"
import { gameStandings, jointIsTied, jointStandings, payoutProposal, rankEntries } from "./scoring.js"

const e = (player, score, at = 1000, stats = { wave: 3, kills: 5, combo: 2 }) => ({
	player,
	score,
	at,
	stats,
})

describe("rankEntries", () => {
	it("sorts by score descending", () => {
		const out = rankEntries([e("mike", 100), e("danylo", 300), e("sofia", 200)])
		expect(out.map((r) => r.player)).toEqual(["danylo", "sofia", "mike"])
	})

	it("breaks a tie in favour of whoever got there first", () => {
		const out = rankEntries([e("mike", 500, 2000), e("danylo", 500, 1000)])
		expect(out.map((r) => r.player)).toEqual(["danylo", "mike"])
	})

	it("does not mutate the input", () => {
		const input = [e("mike", 100), e("danylo", 300)]
		rankEntries(input)
		expect(input[0].player).toBe("mike")
	})
})

describe("gameStandings", () => {
	it("awards 10/6/3 plus a participation point each", () => {
		const out = gameStandings("nova", [e("danylo", 9000), e("mike", 5000), e("sofia", 1000)])
		expect(out.map((r) => [r.player, r.place, r.points])).toEqual([
			["danylo", 1, 11],
			["mike", 2, 7],
			["sofia", 3, 4],
		])
	})

	it("gives 4th place the participation point only", () => {
		const out = gameStandings("nova", [
			e("a", 9000),
			e("b", 5000),
			e("c", 3000),
			e("d", 1000),
		])
		expect(out[3].points).toBe(1)
	})

	// The rule that stops a kid banking 10 points for playing their own game
	// alone. Without it the joint board is decided by who owns which game.
	it("awards participation only when a single player qualified", () => {
		const out = gameStandings("nova", [e("sofia", 40000)])
		expect(out).toHaveLength(1)
		expect(out[0].place).toBe(1)
		expect(out[0].points).toBe(1)
	})

	it("awards places once two players qualify", () => {
		const out = gameStandings("nova", [e("sofia", 40000), e("mike", 600)])
		expect(out.map((r) => r.points)).toEqual([11, 7])
	})

	it("drops runs below the game's qualifying score", () => {
		// nova qualifies at 500.
		const out = gameStandings("nova", [e("danylo", 9000), e("mike", 499)])
		expect(out.map((r) => r.player)).toEqual(["danylo"])
		// and with only one qualifier left, no place points
		expect(out[0].points).toBe(1)
	})

	it("returns nothing for a game nobody played", () => {
		expect(gameStandings("fish", [])).toEqual([])
	})

	it("carries flags through for the dashboard", () => {
		const out = gameStandings("nova", [{ ...e("danylo", 9000), flags: ["jump:8.2x"] }, e("mike", 5000)])
		expect(out[0].flags).toEqual(["jump:8.2x"])
	})
})

describe("jointStandings", () => {
	it("sums points across games", () => {
		const out = jointStandings({
			nova: [e("danylo", 9000), e("mike", 5000)],
			fish: [e("mike", 900), e("danylo", 400)],
			city: [],
		})
		// nova: danylo 11, mike 7. fish: mike 11, danylo 7.
		expect(out.map((r) => [r.player, r.total])).toEqual([
			["danylo", 18],
			["mike", 18],
		])
	})

	// These three tiebreaks decide the larger of the two prizes, so each one is
	// exercised in isolation with the earlier tiebreaks held equal. An earlier
	// version of this test had totals that differed by 11, so the sort never
	// reached the tiebreaks at all and it passed for the wrong reason.
	it("breaks a level total on most first places", () => {
		const out = jointStandings({
			// nova: danylo 11, mike 7, sofia 4   fish: mike 11, sofia 7
			// danylo 11 in one game with a win; sofia 11 in two games with none.
			nova: [e("danylo", 9000, 1000), e("mike", 5000, 1000), e("sofia", 1000, 1000)],
			fish: [e("mike", 900, 1000), e("sofia", 500, 1000)],
			city: [],
		})
		const danylo = out.find((p) => p.player === "danylo")
		const sofia = out.find((p) => p.player === "sofia")
		expect(danylo.total).toBe(sofia.total)
		expect(danylo.firsts).toBeGreaterThan(sofia.firsts)
		// And sofia played MORE games, so this only passes if wins are compared
		// before games played — the ordering of the tiebreaks, not just their values.
		expect(danylo.gamesPlayed).toBeLessThan(sofia.gamesPlayed)
		expect(out.findIndex((p) => p.player === "danylo")).toBeLessThan(
			out.findIndex((p) => p.player === "sofia"),
		)
	})

	it("falls through to the earliest last run when everything else is level", () => {
		const out = jointStandings({
			// Both win one contested game and place second in the other: 18 each,
			// one win each, two games each. Only the timestamps differ.
			nova: [e("danylo", 9000, 1000), e("mike", 5000, 1000)],
			fish: [e("mike", 900, 3000), e("danylo", 400, 2000)],
			city: [],
		})
		expect(out.map((p) => p.total)).toEqual([18, 18])
		expect(out.map((p) => p.firsts)).toEqual([1, 1])
		expect(out.map((p) => p.gamesPlayed)).toEqual([2, 2])
		// danylo's last qualifying run is at 2000, mike's at 3000 — earlier wins.
		expect(out[0].player).toBe("danylo")
	})

	// Worth recording what came out of trying to build this fixture: with the
	// default table (11/7/4 plus a participation point) and three games, there is
	// no combination where two players are level on total AND on wins but differ
	// on games played — so this tiebreak can never actually decide anything today.
	// It's kept because it's correct and the point table is meant to be tuned, and
	// it's tested against a table where it IS reachable so a future edit to
	// POINTS doesn't silently break it.
	it("prefers more games played when totals and wins are equal", () => {
		const points = { places: [4, 2], participation: 0, minQualifiersForPlaces: 2 }
		const out = jointStandings(
			{
				// danylo: 1st nova (4)                  -> 4, one game, one win
				// mike:   1st fish (4) + 3rd city (0)   -> 4, two games, one win
				nova: [e("danylo", 9000, 1000), e("sofia", 5000, 1000)],
				fish: [e("mike", 9000, 1000), e("sofia", 5000, 1000)],
				city: [e("sofia", 900, 1000), e("tato", 500, 1000), e("mike", 100, 1000)],
			},
			points,
		)
		const danylo = out.find((p) => p.player === "danylo")
		const mike = out.find((p) => p.player === "mike")
		expect(mike.total).toBe(danylo.total)
		expect(mike.firsts).toBe(danylo.firsts)
		expect(mike.gamesPlayed).toBeGreaterThan(danylo.gamesPlayed)
		expect(out.findIndex((p) => p.player === "mike")).toBeLessThan(
			out.findIndex((p) => p.player === "danylo"),
		)
	})

	it("gives a kid who played nothing no row at all", () => {
		const out = jointStandings({ nova: [e("danylo", 9000), e("mike", 5000)], fish: [], city: [] })
		expect(out.map((r) => r.player)).not.toContain("sofia")
	})

	it("records which games each player scored in", () => {
		const out = jointStandings({ nova: [e("danylo", 9000), e("mike", 5000)], fish: [], city: [] })
		expect(Object.keys(out[0].perGame)).toEqual(["nova"])
		expect(out[0].perGame.nova.place).toBe(1)
	})
})

describe("jointIsTied", () => {
	const row = (over) => ({ total: 11, firsts: 1, gamesPlayed: 2, lastAt: 500, ...over })

	it("spots a genuine tie on every tiebreak", () => {
		expect(jointIsTied([row(), row()])).toBe(true)
	})

	it("is false when the totals differ", () => {
		expect(jointIsTied([row({ total: 12 }), row()])).toBe(false)
	})

	// The dashboard renders this as "level on every tiebreak — split it by hand".
	// Saying that about a contest the tiebreaks resolved would pay half the
	// bigger prize to the wrong kid, and it gets frozen into the week snapshot.
	it("is false when a tiebreak separates them", () => {
		expect(jointIsTied([row({ firsts: 2 }), row()])).toBe(false)
		expect(jointIsTied([row({ gamesPlayed: 3 }), row()])).toBe(false)
		expect(jointIsTied([row({ lastAt: 400 }), row()])).toBe(false)
	})

	it("is false with fewer than two players", () => {
		expect(jointIsTied([row()])).toBe(false)
		expect(jointIsTied([])).toBe(false)
	})
})

describe("payoutProposal", () => {
	it("names a winner per game and overall", () => {
		const p = payoutProposal({
			nova: [e("danylo", 9000), e("mike", 5000)],
			fish: [e("mike", 900), e("sofia", 400)],
			city: [],
		})
		expect(p.perGame.nova.winner).toBe("danylo")
		expect(p.perGame.fish.winner).toBe("mike")
		expect(p.perGame.city.winner).toBe(null)
		expect(p.jointWinner).toBe("mike") // 7 + 11 = 18 vs danylo 11
	})

	// Surfaced so the dashboard can show it: a "win" with nobody to beat is a
	// payout decision, not an achievement.
	it("flags a game won unopposed", () => {
		const p = payoutProposal({ nova: [e("danylo", 9000)], fish: [], city: [] })
		expect(p.perGame.nova.unopposed).toBe(true)
		expect(p.perGame.nova.qualifiers).toBe(1)
	})

	it("does not flag a contested game as unopposed", () => {
		const p = payoutProposal({ nova: [e("danylo", 9000), e("mike", 5000)], fish: [], city: [] })
		expect(p.perGame.nova.unopposed).toBe(false)
	})
})
