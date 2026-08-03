// The hub's week arithmetic, pinned to the worker's.
//
// site/hub-weeks.js deliberately duplicates leaderboard/week.js's stepping
// maths (the published site can't import worker code at runtime), and a
// duplicated rule is only safe while a test runs both against the same keys.
// This is that test — same discipline as test/name-cases.js for the name rule.

import { describe, expect, it } from "vitest"
import { HISTORY_WEEKS, clampWeek, isWeekKeyShape, nextWeekKey, prevWeekKey } from "./hub-weeks.js"
import { isWeekKey, nextWeek } from "../leaderboard/week.js"

describe("week stepping", () => {
	// DST-adjacent Mondays matter because America/Toronto shifts on
	// 2026-03-08 and 2026-11-01 — a client doing local-time maths would slip a
	// day exactly there. These keys bracket both changes, plus the year end.
	const KEYS = [
		"2026-03-02",
		"2026-03-09",
		"2026-10-26",
		"2026-11-02",
		"2026-12-28",
		"2027-01-04",
		"2026-07-27",
		"2026-08-03",
	]

	it("agrees with the worker's own nextWeek on every probe key", () => {
		for (const key of KEYS) {
			expect(nextWeekKey(key), key).toBe(nextWeek(key))
		}
	})

	it("round-trips: prev of next is the key itself", () => {
		for (const key of KEYS) {
			expect(prevWeekKey(nextWeekKey(key)), key).toBe(key)
			expect(nextWeekKey(prevWeekKey(key)), key).toBe(key)
		}
	})

	it("always lands on a Monday", () => {
		let key = "2026-08-03" // a known Monday
		for (let i = 0; i < 120; i++) {
			key = prevWeekKey(key)
			const [y, m, d] = key.split("-").map(Number)
			expect(new Date(Date.UTC(y, m - 1, d)).getUTCDay(), key).toBe(1)
		}
	})

	it("crosses the year boundary cleanly", () => {
		expect(nextWeekKey("2026-12-28")).toBe("2027-01-04")
		expect(prevWeekKey("2027-01-04")).toBe("2026-12-28")
	})
})

describe("key shape", () => {
	// The file's whole justification is that a duplicated rule stays pinned to
	// the worker's. Shape alone was pinned; "is it a Monday" was not, and a
	// Tuesday sailed through the client to a guaranteed 400.
	it("agrees with the worker on what is a week, Mondays and not", () => {
		const probes = [
			"2026-07-27", // Monday
			"2026-07-28", // Tuesday
			"2026-07-30", // Thursday
			"2026-08-02", // Sunday
			"2026-08-03", // Monday
			"2026-02-30", // not a date at all
			"2026-7-27", // unpadded
		]
		for (const k of probes) {
			const clamped = clampWeek(k, "2026-08-03")
			// Whatever the client hands the worker must be a key the worker accepts.
			expect(isWeekKey(clamped), `${k} → ${clamped}`).toBe(true)
		}
	})


	it("accepts real dates and rejects everything else", () => {
		expect(isWeekKeyShape("2026-07-27")).toBe(true)
		expect(isWeekKeyShape("2026-02-30")).toBe(false) // not a real date
		expect(isWeekKeyShape("2026-7-27")).toBe(false) // padding matters — keys sort as strings
		expect(isWeekKeyShape("garbage")).toBe(false)
		expect(isWeekKeyShape("")).toBe(false)
		expect(isWeekKeyShape(null)).toBe(false)
	})
})

describe("clamping a shared link", () => {
	const CURRENT = "2026-08-03"

	it("passes a valid in-range week through", () => {
		expect(clampWeek("2026-07-27", CURRENT)).toBe("2026-07-27")
	})

	it("clamps the future to the present — no peeking at next week", () => {
		expect(clampWeek("2026-08-10", CURRENT)).toBe(CURRENT)
	})

	it("clamps beyond the horizon to the horizon", () => {
		let floor = CURRENT
		for (let i = 0; i < HISTORY_WEEKS; i++) floor = prevWeekKey(floor)
		expect(clampWeek("2020-01-06", CURRENT)).toBe(floor)
	})

	it("turns garbage into the current week, silently", () => {
		expect(clampWeek("not-a-week", CURRENT)).toBe(CURRENT)
		expect(clampWeek(undefined, CURRENT)).toBe(CURRENT)
	})
})
