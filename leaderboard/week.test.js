// Week boundary maths.
//
// This is the highest-value test file in the repo. If the week key is wrong,
// a score lands in the wrong week and the wrong kid gets paid — and the bug is
// invisible until someone disputes a payout. All pure functions, so no mocks
// and no clock injection needed: just fixed instants in, strings out.

import { describe, expect, it } from "vitest"
import { WEEK_TZ, isWeekKey, nextWeek, weekHasEnded, weekKey } from "./week.js"

const at = (iso) => Date.parse(iso)

describe("the runtime can do Toronto time", () => {
	// Everything below rests on full-ICU being present. Assert it rather than
	// assume it — if this fails, every other test here is meaningless.
	it("resolves the America/Toronto timezone", () => {
		const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: WEEK_TZ, timeZoneName: "short" })
		expect(fmt.resolvedOptions().timeZone).toBe("America/Toronto")
	})

	it("actually shifts the calendar date, not just the label", () => {
		// 01:00 UTC on Aug 3 is still Aug 2 in Toronto. A runtime without real
		// timezone data would report Aug 3 here and the week would be off by one.
		const parts = new Intl.DateTimeFormat("en-CA", {
			timeZone: WEEK_TZ,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).format(new Date(at("2026-08-03T01:00:00Z")))
		expect(parts).toBe("2026-08-02")
	})
})

describe("weekKey", () => {
	it("returns the Monday that starts the week", () => {
		// Wednesday 2026-07-29, the day this was built.
		expect(weekKey(at("2026-07-29T18:00:00Z"))).toBe("2026-07-27")
	})

	it("puts Monday 00:00 EST in its own week", () => {
		expect(weekKey(at("2026-01-05T05:00:00Z"))).toBe("2026-01-05")
	})

	it("puts the millisecond before Monday in the previous week", () => {
		expect(weekKey(at("2026-01-05T04:59:59.999Z"))).toBe("2025-12-29")
	})

	it("keeps Sunday 23:59:59.999 EDT in the week that is ending", () => {
		expect(weekKey(at("2026-08-03T03:59:59.999Z"))).toBe("2026-07-27")
	})

	// The single most likely bug in the whole scheme. Sunday evening in Toronto
	// is already Monday in UTC, so anything that skips the timezone conversion
	// files prime family gaming time into the wrong week.
	it("keeps Sunday 9pm Toronto in the Sunday week, not the UTC Monday", () => {
		expect(weekKey(at("2026-08-03T01:00:00Z"))).toBe("2026-07-27")
	})

	it("handles the spring-forward week", () => {
		// DST starts Sunday 2026-03-08; that Sunday still belongs to Mar 2.
		expect(weekKey(at("2026-03-08T16:00:00Z"))).toBe("2026-03-02")
		expect(weekKey(at("2026-03-09T05:00:00Z"))).toBe("2026-03-09")
	})

	it("handles the fall-back week", () => {
		// DST ends Sunday 2026-11-01; that Sunday still belongs to Oct 26.
		expect(weekKey(at("2026-11-01T17:00:00Z"))).toBe("2026-10-26")
		expect(weekKey(at("2026-11-02T05:00:00Z"))).toBe("2026-11-02")
	})

	it("handles a week spanning the new year", () => {
		expect(weekKey(at("2026-01-01T17:00:00Z"))).toBe("2025-12-29")
		expect(weekKey(at("2025-12-31T17:00:00Z"))).toBe("2025-12-29")
	})

	it("gives every day of one week the same key", () => {
		const keys = new Set()
		for (let d = 27; d <= 31; d++) keys.add(weekKey(at(`2026-07-${d}T16:00:00Z`)))
		keys.add(weekKey(at("2026-08-01T16:00:00Z")))
		keys.add(weekKey(at("2026-08-02T16:00:00Z")))
		expect([...keys]).toEqual(["2026-07-27"])
	})
})

describe("weekHasEnded", () => {
	it("is false during the week", () => {
		expect(weekHasEnded("2026-07-27", at("2026-08-02T16:00:00Z"))).toBe(false)
	})

	it("is true once the next week starts", () => {
		expect(weekHasEnded("2026-07-27", at("2026-08-03T05:00:00Z"))).toBe(true)
	})
})

describe("nextWeek", () => {
	it("adds seven days", () => {
		expect(nextWeek("2026-07-27")).toBe("2026-08-03")
	})

	it("crosses a month boundary", () => {
		expect(nextWeek("2026-08-31")).toBe("2026-09-07")
	})

	it("crosses a year boundary", () => {
		expect(nextWeek("2025-12-29")).toBe("2026-01-05")
	})
})

describe("isWeekKey", () => {
	it("accepts a Monday date", () => {
		expect(isWeekKey("2026-07-27")).toBe(true)
	})

	it("rejects a date that is not a Monday", () => {
		// Guards the KV key space: only real week starts become keys.
		expect(isWeekKey("2026-07-28")).toBe(false)
	})

	it("rejects junk", () => {
		for (const bad of ["", "current", "2026-W31", "2026-7-27", "../../etc", null, 7]) {
			expect(isWeekKey(bad)).toBe(false)
		}
	})
})
