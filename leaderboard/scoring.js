// Ranking and prize points. All pure functions — no KV, no clock, no request.
//
// Keeping this separate from the worker is what makes the payout arithmetic
// testable, and the payout arithmetic is the part someone will dispute.

import { GAMES, GAME_IDS, POINTS } from "./games.js"

/**
 * Board order: score descending, and on a tie the earlier submission wins.
 *
 * Ties do not share a place. "Whoever got there first" is a rule you can say
 * out loud to a kid, and it matches how v1 already sorted.
 */
export function byRank(a, b) {
	return b.score - a.score || a.at - b.at
}

export function rankEntries(entries) {
	return [...entries].sort(byRank)
}

/**
 * Award places and points within one game for one week.
 *
 * Returns the qualifying entries in rank order, each with `place` and `points`.
 * Entries below the game's qualifying score are dropped entirely — they are
 * still on the board, they just earn nothing.
 */
export function gameStandings(gameId, entries, points = POINTS) {
	const game = GAMES[gameId]
	const qualify = game ? game.qualify : 1
	const qualified = rankEntries(entries.filter((e) => e.score >= qualify))

	// The rule that stops a kid banking 10 points for playing their own game
	// alone. Everyone still gets their participation point.
	const placesAwarded = qualified.length >= points.minQualifiersForPlaces

	return qualified.map((e, i) => ({
		player: e.player,
		score: e.score,
		at: e.at,
		stats: e.stats,
		flags: e.flags || [],
		place: i + 1,
		points: (placesAwarded ? (points.places[i] ?? 0) : 0) + points.participation,
	}))
}

/**
 * The joint board: per-game points summed per player.
 *
 * `boards` is { gameId: entries[] }. Games with no entries contribute nothing,
 * and a player who never touched a game simply has no points from it.
 */
export function jointStandings(boards, points = POINTS) {
	const perPlayer = new Map()

	for (const gameId of GAME_IDS) {
		const standings = gameStandings(gameId, boards[gameId] || [], points)
		for (const row of standings) {
			let p = perPlayer.get(row.player)
			if (!p) {
				p = { player: row.player, total: 0, firsts: 0, gamesPlayed: 0, lastAt: 0, perGame: {} }
				perPlayer.set(row.player, p)
			}
			p.perGame[gameId] = { points: row.points, place: row.place, score: row.score }
			p.total += row.points
			p.gamesPlayed += 1
			if (row.place === 1) p.firsts += 1
			p.lastAt = Math.max(p.lastAt, row.at)
		}
	}

	// Tiebreaks, in order: points, then most wins, then most games played, then
	// whoever got their last qualifying run in first. If two players are still
	// level after all four, that is a genuine tie and the prize gets split by
	// hand — better than inventing a fifth arbitrary rule.
	return [...perPlayer.values()].sort(
		(a, b) =>
			b.total - a.total ||
			b.firsts - a.firsts ||
			b.gamesPlayed - a.gamesPlayed ||
			a.lastAt - b.lastAt,
	)
}

/**
 * True only when the top two are level on the total AND on every tiebreak.
 *
 * Checking the total alone would be wrong in a way that matters: the sort above
 * often does separate two level totals, and the dashboard renders this flag as
 * "level on every tiebreak — split it by hand". Saying that about a contest the
 * tiebreaks actually resolved would hand out half the larger prize to the wrong
 * kid, and the claim gets frozen into the week snapshot.
 */
export function jointIsTied(standings) {
	if (standings.length < 2) return false
	const [a, b] = standings
	return (
		a.total === b.total &&
		a.firsts === b.firsts &&
		a.gamesPlayed === b.gamesPlayed &&
		a.lastAt === b.lastAt
	)
}

/**
 * What a week's payouts should be: each game's winner, plus the joint winner.
 *
 * A proposal only. Nothing here pays anything — the dashboard shows this and a
 * human decides.
 */
export function payoutProposal(boards, points = POINTS) {
	const perGame = {}
	for (const gameId of GAME_IDS) {
		const standings = gameStandings(gameId, boards[gameId] || [], points)
		perGame[gameId] = {
			label: GAMES[gameId].label,
			qualifiers: standings.length,
			// Flagged so it's visible that this winner had nobody to beat.
			unopposed: standings.length === 1,
			winner: standings[0] ? standings[0].player : null,
			places: standings,
		}
	}
	const joint = jointStandings(boards, points)
	return {
		perGame,
		joint,
		jointWinner: joint[0] ? joint[0].player : null,
		jointTied: jointIsTied(joint),
	}
}
