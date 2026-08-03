// Week-key arithmetic for the hub's history navigation. DOM-free on purpose:
// hub.js touches `document` at import time, so anything a test needs to import
// has to live here instead.
//
// This deliberately DUPLICATES the maths in ../leaderboard/week.js rather than
// importing it — the site is published alone, without the worker's code, so a
// runtime import can't exist. The duplication is pinned by a test that runs
// both implementations against the same keys; if they ever drift, that test
// names the key they disagree on.
//
// Everything here works on plain YYYY-MM-DD Monday strings in UTC. Week keys
// are dates, not instants, so ±7 days in UTC arithmetic is DST-proof: the
// client never touches America/Toronto — the server names the current week and
// the client only steps backwards and forwards from it.

const DAY = 86_400_000

/** Strictly a plausible week key: a real date, correctly zero-padded. */
export function isWeekKeyShape(key) {
	if (typeof key !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return false
	const [y, m, d] = key.split("-").map(Number)
	const t = new Date(Date.UTC(y, m - 1, d))
	return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
}

function shift(key, days) {
	const [y, m, d] = key.split("-").map(Number)
	return new Date(Date.UTC(y, m - 1, d) + days * DAY).toISOString().slice(0, 10)
}

export const nextWeekKey = (key) => shift(key, 7)
export const prevWeekKey = (key) => shift(key, -7)

/**
 * How far back the hub lets you page: six months of Mondays. There is no
 * public index of which weeks exist, so the horizon is a constant rather than
 * a probe — an empty week renders as "nobody played", which is itself true.
 */
export const HISTORY_WEEKS = 26

/**
 * Clamp a requested week (e.g. from a shared #2026-07-27 link) into the
 * navigable range. Week keys sort lexicographically, which leaderboard/week.js
 * relies on too, so string comparison is exact. Garbage in → current week out.
 */
export function clampWeek(requested, currentWeek) {
	if (!isWeekKeyShape(requested)) return currentWeek
	if (requested >= currentWeek) return currentWeek
	let floor = currentWeek
	for (let i = 0; i < HISTORY_WEEKS; i++) floor = prevWeekKey(floor)
	return requested <= floor ? floor : requested
}
