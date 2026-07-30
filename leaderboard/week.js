// Week boundaries for the weekly prize.
//
// Every submission is stamped with the week it belongs to AT WRITE TIME, and
// that stamp is part of its KV key. The alternative — one all-time board
// filtered by timestamp when you read it — was rejected deliberately: it makes
// the standings a function of when you look ("the board said I won when I
// checked at 11:59"), and a week that can't be closed can't reject a late
// score. With money involved, a week has to become immutable history.
//
// Weeks run Monday 00:00 to Sunday 23:59:59.999 in America/Toronto. Monday is
// not just convention here: Toronto's DST switches happen on Sundays, so a
// Monday boundary never lands on a clock change, while a Sunday one would land
// on it every spring and fall.

export const WEEK_TZ = "America/Toronto"

const DAY = 86_400_000

/**
 * The local calendar date in Toronto as [y, m, d].
 *
 * Read through Intl rather than by adding a fixed offset, so DST is ICU's
 * problem and not ours. Everything downstream rests on this, which is why
 * there's a test asserting the runtime actually resolves this timezone.
 */
function localYMD(ms) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: WEEK_TZ,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(new Date(ms))
	const get = (type) => Number(parts.find((p) => p.type === type).value)
	return [get("year"), get("month"), get("day")]
}

/**
 * The week key for a moment in time: the date of that week's Monday, as
 * "2026-07-27".
 *
 * A Monday date rather than an ISO week number ("2026-W31") because it needs no
 * week-53 or year-boundary special cases, it sorts lexicographically, and a kid
 * looking at the URL can tell what it means.
 */
export function weekKey(ms) {
	const [y, m, d] = localYMD(ms)
	// Work on a date-only UTC value so the Monday arithmetic can't be dragged
	// across a boundary by a time-of-day component.
	const t = Date.UTC(y, m - 1, d)
	const dow = (new Date(t).getUTCDay() + 6) % 7 // Mon=0 … Sun=6
	return new Date(t - dow * DAY).toISOString().slice(0, 10)
}

/** True once `week` is over. Both are Monday dates, so a string compare is the comparison. */
export function weekHasEnded(week, nowMs) {
	return weekKey(nowMs) > week
}

/** The Monday after `week` — used to say when an open week will close. */
export function nextWeek(week) {
	const [y, m, d] = week.split("-").map(Number)
	return new Date(Date.UTC(y, m - 1, d) + 7 * DAY).toISOString().slice(0, 10)
}

/** A week key is only ever a Monday date; reject anything else before it reaches KV. */
export function isWeekKey(s) {
	return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && weekKey(Date.parse(s + "T12:00:00Z")) === s
}
