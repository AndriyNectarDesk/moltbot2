// The game registry and the prize rules.
//
// This file exists so the worker has no per-game knowledge hardcoded in its
// logic. The previous version required every submission to carry `wave`,
// `kills` and `combo` — shooter vocabulary that would have 400'd a fishing
// score. Now a game declares its own stat fields and its own plausibility
// ceiling, and everything else is generic.
//
// fish and city are registered before they exist, with permissive limits. That
// is the point: when those games ship they can post scores without the worker
// changing at all. Their `qualify` and `plausible` values are placeholders —
// nobody can know the right numbers until there are real scores to look at.

export const GAMES = {
	nova: {
		label: "DANYLO: NECTAR NOVA",
		// Below this a run earns no prize points. Stops a 3-second death from
		// counting as "participated" for the weekly board.
		qualify: 500,
		// The middle column on the score table, rendered from `stats`.
		brag: (s) => (s.wave ? `W${s.wave}` : ""),
		stats: {
			wave: { min: 1, max: 500 },
			kills: { min: 0, max: 100_000 },
			combo: { min: 1, max: 8 },
		},
		// A loose ceiling: even a perfect run can't out-earn this. Kept from v1.
		// It no longer rejects — see FLAG_ONLY below.
		plausible: (score, s) => score <= s.wave * 200_000 + 100_000,
	},

	fish: {
		label: "MIKE: QUIET WATER",
		qualify: 1,
		brag: (s) => (s.heaviest ? `${(s.heaviest / 1000).toFixed(1)}kg` : ""),
		stats: {
			landed: { min: 0, max: 500 },
			heaviest: { min: 0, max: 60_000 }, // grams
			species: { min: 0, max: 40 },
			flow: { min: 1, max: 20 },
		},
		plausible: null, // TODO Phase 2: set once real scores exist
	},

	city: {
		label: "SOFIA: CITY LIGHTS",
		qualify: 1,
		brag: (s) => (s.deliveries ? `${s.deliveries}d` : ""),
		stats: {
			deliveries: { min: 0, max: 200 },
			stars: { min: 0, max: 200 },
			bestRun: { min: 0, max: 600 }, // seconds
		},
		plausible: null, // TODO Phase 3
	},
}

export const GAME_IDS = Object.keys(GAMES)

/** No score above this is accepted for any game, whatever its own rules say. */
export const MAX_SCORE = 50_000_000

/**
 * Weekly prize points, summed across games for the joint board.
 *
 * Raw scores can't be compared across games — 12,400 Nova points and a 12.4 kg
 * carp are different units — so the joint board ranks on these instead. The
 * side effect that matters more: it makes playing a sibling's game worth
 * something, which is the only reason to have a joint board at all.
 *
 * These are NOT an anti-cheat measure. With three kids and three games the
 * whole thing is decided by a handful of points, so a bounded 10 is still a
 * third of the achievable spread — and bounding it makes the cheapest cheat
 * "beat my sibling by one", which is quieter and harder to spot than an absurd
 * number would be. The defence is the dashboard and a human approving payouts.
 */
export const POINTS = {
	places: [10, 6, 3], // 1st, 2nd, 3rd
	participation: 1, // any qualifying run, stacks with a place
	/**
	 * Places are only awarded if at least this many players posted a qualifying
	 * run in that game that week.
	 *
	 * Without this rule the whole joint board falls over: each kid owns a game
	 * and will play it most, so the default outcome is one kid posting alone in
	 * their own game and banking 10 points for showing up. That isn't a contest.
	 */
	minQualifiersForPlaces: 2,
}

/** Flag thresholds for the dashboard. Nothing here ever rejects a score. */
export const FLAGS = {
	// A run this many times better than the player's own previous best. One
	// divide, and it catches the lazy console cheat that is most of what a kid
	// would actually try.
	scoreJump: 5,
	// Accepted submissions in one game-week.
	weeklyRuns: 40,
}

/** Rate limiting, held on the player's own board row rather than a separate KV key. */
export const RATE = {
	cooldownMs: 20_000,
	maxAcceptedPerWeek: 50,
}

/**
 * Check a submission against its game's declared stats.
 *
 * Returns an error string to reject, or null to accept. Deliberately narrow:
 * this stops typos and nonsense, not cheating. Cheating is unstoppable while
 * the game is JavaScript on the player's own machine, which the README says
 * plainly and which the prize process is designed around.
 */
export function validate(game, body) {
	const score = Number(body.score)
	if (!Number.isFinite(score)) return "non-numeric score"
	if (score < 0) return "negative score"
	if (score > MAX_SCORE) return "score out of range"

	const stats = body.stats
	if (stats == null || typeof stats !== "object" || Array.isArray(stats)) return "missing stats"

	for (const [field, range] of Object.entries(game.stats)) {
		// Number(null) is 0 and Number(undefined) is NaN, so require the key to
		// be present rather than letting a missing field coerce to a valid 0.
		if (!(field in stats)) return `missing stat: ${field}`
		const v = Number(stats[field])
		if (!Number.isFinite(v)) return `non-numeric stat: ${field}`
		if (v < range.min || v > range.max) return `stat out of range: ${field}`
	}
	return null
}

/** Round every declared stat to an integer, dropping anything the game didn't declare. */
export function cleanStats(game, stats) {
	const out = {}
	for (const field of Object.keys(game.stats)) out[field] = Math.round(Number(stats[field]))
	return out
}
