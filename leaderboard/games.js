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
		// Stats where sitting exactly on the declared ceiling is not a boast but a
		// tell. Only list a stat here if its max is an absurd outer bound — a real
		// run reaches wave 10, not 500. `combo` is deliberately absent: the game
		// caps it at 8 and a good player hits that most runs, so flagging it would
		// bury the dashboard in false positives and teach Andriy to ignore flags.
		suspiciousMax: ["wave", "kills"],
		// A loose ceiling: even a perfect run can't out-earn this. Kept from v1.
		// It no longer rejects — see FLAG_ONLY below.
		plausible: (score, s) => score <= s.wave * 200_000 + 100_000,
	},

	fish: {
		label: "MIKE: QUIET WATER",
		// One landed fish is enough to be in the running. The smallest sunfish is
		// worth 1, so a blank morning still scores 0 and earns nothing.
		qualify: 1,
		brag: (s) => (s.heaviest ? `${(s.heaviest / 1000).toFixed(1)}kg` : ""),
		stats: {
			landed: { min: 0, max: 500 },
			heaviest: { min: 0, max: 20_000 }, // grams; the biggest sturgeon is 17kg
			species: { min: 0, max: 6 },
			flow: { min: 10, max: 30 }, // best multiplier ×10, so 1.0× … 3.0×
		},
		// `species` and `flow` are omitted on purpose: catching every species
		// and maxing the flow multiplier are both things the game is asking you to
		// do, and a measured skilled run hits the flow cap routinely.
		suspiciousMax: ["landed", "heaviest"],
		// Tuned against measured play rather than guessed: a simulated attentive
		// three-minute run scores 10–15k over 14–16 fish, and the single best
		// possible fish is a 17kg sturgeon at a 3× multiplier, which is 10,200. So a
		// score far above eleven thousand per landed fish did not come from playing.
		plausible: (score, s) => score <= s.landed * 11_000 + 500,
	},

	city: {
		label: "SOFIA: CITY LIGHTS",
		// One delivery is enough to be in the running. Free-roam driving scores
		// nothing at all, by design — only a SHIFT reaches this board.
		qualify: 1,
		brag: (s) => (s.deliveries ? `${s.deliveries} JOBS` : ""),
		stats: {
			deliveries: { min: 0, max: 200 },
			// There are 51 stars in the city; the ceiling just leaves headroom.
			stars: { min: 0, max: 60 },
			// Seconds for the quickest single delivery. Can't exceed the shift.
			bestRun: { min: 0, max: 300 },
		},
		// Only `deliveries` — 200 in a five-minute shift is absurd. `bestRun` is a
		// minimum-type stat, so sitting at its ceiling is a slow delivery rather
		// than a suspicious one, and `stars` is a collection the game is actively
		// asking you to complete, so flagging a full set would punish finishing it.
		suspiciousMax: ["deliveries"],
		// Measured: a simulated beeline driver at 22 m/s banks ~29k over a
		// five-minute shift and one at 31 m/s ~55k, and a real player navigating
		// actual streets will be well under that. The single richest possible
		// delivery is a full-width run, clean, at a 3x streak — about 3,700.
		plausible: (score, s) => score <= s.deliveries * 3_800 + 500,
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
	// Improvements accepted in one game-week. Note this counts improvements, not
	// posts — a non-improving submission is deliberately free, so it isn't
	// counted. Beating your own best 40 times in a week is already a lot.
	weeklyImprovements: 40,
}

/**
 * Scores above this get a look, per game.
 *
 * The jump signal needs a previous row to compare against, so it can't see the
 * simplest attack of all: one enormous submission as your first run of the week.
 * And a plausibility curve keyed on a stat the client also supplies is trivially
 * satisfied by maxing that stat. This is the backstop for both — a flat "that is
 * a very big number" line. Tune it once there are real scores; being a little
 * low is harmless, since a flag never blocks anything.
 */
export const EYEBROW = {
	nova: 100_000,
	// A very good measured run lands around 15k; 30k is a morning worth asking about.
	fish: 30_000,
	// A simulated flat-out beeline shift banks ~55k; 70k is a shift worth asking about.
	city: 70_000,
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
