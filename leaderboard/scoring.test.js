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

	it("breaks a total tie on most first places", () => {
		const out = jointStandings({
			// danylo wins nova and comes 2nd in fish: 11 + 7 = 18
			// mike wins fish and comes 2nd in nova: 11 + 7 = 18
			// both have one win, so it falls through to games played, then time
			nova: [e("danylo", 9000, 1000), e("mike", 5000, 1000)],
			fish: [e("mike", 900, 1000), e("danylo", 400, 2000)],
			city: [e("danylo", 100, 500), e("sofia", 90, 500)],
		})
		// danylo now has 3 games and 2 wins
		expect(out[0].player).toBe("danylo")
		expect(out[0].firsts).toBe(2)
		expect(out[0].gamesPlayed).toBe(3)
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
	it("spots a level top two", () => {
		expect(jointIsTied([{ total: 11 }, { total: 11 }])).toBe(true)
		expect(jointIsTied([{ total: 12 }, { total: 11 }])).toBe(false)
		expect(jointIsTied([{ total: 11 }])).toBe(false)
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
