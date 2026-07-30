// SHIFT mode scoring.
//
// This is the only part of the city that feeds the weekly prize, so it gets the
// same treatment as the fishing fight: simulate players of different quality and
// assert that better play scores better, rather than assuming it does.

import { beforeEach, describe, expect, it } from "vitest"
import { SHIFT_SECONDS, Shift } from "./shift.js"

const STEP = 1 / 60

/** A ring of destinations, so distances are predictable. */
function spotter(radius = 60) {
	let n = 0
	return (avoid) => {
		n++
		const a = n * 1.7
		return { x: Math.cos(a) * radius, z: Math.sin(a) * radius, label: `S${n}` }
	}
}

/**
 * Run a whole shift with a driver of a given speed.
 *
 * The driver beelines to whatever the job is asking for at `speed` metres per
 * second, which is the useful abstraction: a better driver is a faster one.
 */
function runShift(speed, { crashEvery = 0, dither = 0 } = {}) {
	const shift = new Shift(spotter())
	const car = { x: 0, z: 0 }
	let t = 0
	let sinceCrash = 0
	while (!shift.over) {
		const job = shift.update(STEP, car)
		t += STEP
		if (!job) continue
		const target = job.carrying ? job.drop : job.pickup
		let dx = target.x - car.x
		let dz = target.z - car.z
		const d = Math.hypot(dx, dz)
		if (d > 0.01) {
			// `dither` sends the driver on a slightly wrong heading — a worse line.
			const wobble = dither ? Math.sin(t * 3) * dither : 0
			const ang = Math.atan2(dz, dx) + wobble
            const step = Math.min(speed * STEP, d)
			car.x += Math.cos(ang) * step
			car.z += Math.sin(ang) * step
		}
		if (crashEvery) {
			sinceCrash += STEP
			if (sinceCrash >= crashEvery) {
				sinceCrash = 0
				shift.crash()
			}
		}
	}
	return shift
}

describe("the clock", () => {
	it("runs for five minutes", () => {
		expect(SHIFT_SECONDS).toBe(300)
		const shift = new Shift(spotter())
		expect(shift.timeLeft).toBe(SHIFT_SECONDS)
	})

	it("ends, and ends only once", () => {
		const shift = new Shift(spotter())
		const car = { x: 0, z: 0 }
		for (let i = 0; i < 60 * 310; i++) shift.update(STEP, car)
		expect(shift.over).toBe(true)
		expect(shift.timeLeft).toBe(0)
		// Updating past the end must not resurrect a job or change the score.
		const score = shift.score
        expect(shift.update(STEP, car)).toBe(null)
		expect(shift.score).toBe(score)
	})

	it("does not pay for a parcel still in the boot at the whistle", () => {
		const shift = new Shift(spotter())
		const car = { x: 0, z: 0 }
		shift.update(STEP, car)
		// Stand on the pickup to collect, then never deliver.
		Object.assign(car, shift.job.pickup)
		shift.update(STEP, car)
		expect(shift.job.carrying).toBe(true)
		shift.timeLeft = 0.001
		shift.update(STEP, car)
		expect(shift.over).toBe(true)
		expect(shift.delivered).toBe(0)
		expect(shift.dropped).toBe(1)
	})
})

describe("jobs", () => {
	let shift
	beforeEach(() => {
		shift = new Shift(spotter())
	})

	it("offers a job immediately", () => {
		const job = shift.update(STEP, { x: 0, z: 0 })
		expect(job).not.toBeNull()
		expect(job.carrying).toBe(false)
		expect(job.pickup).toBeDefined()
		expect(job.drop).toBeDefined()
	})

	it("gives a longer allowance for a longer route", () => {
		const near = new Shift(spotter(20)).newJob({ x: 0, z: 0 })
		const far = new Shift(spotter(200)).newJob({ x: 0, z: 0 })
		expect(far.allowed).toBeGreaterThan(near.allowed)
	})

	it("needs the pickup before the drop counts", () => {
		const job = shift.update(STEP, { x: 0, z: 0 })
		// Standing on the drop without the parcel does nothing.
		shift.update(STEP, { ...job.drop })
		expect(shift.delivered).toBe(0)
		expect(shift.job).toBe(job)
	})

	it("pays out on pickup then drop", () => {
		const job = shift.update(STEP, { x: 0, z: 0 })
		shift.update(STEP, { ...job.pickup })
		expect(shift.job.carrying).toBe(true)
		shift.update(STEP, { ...job.drop })
		expect(shift.delivered).toBe(1)
		expect(shift.score).toBeGreaterThan(0)
	})

	it("drops the parcel when its timer runs out, and offers another", () => {
		const job = shift.update(STEP, { x: 0, z: 0 })
		job.left = 0.001
		shift.update(STEP, { x: 999, z: 999 })
		expect(shift.dropped).toBe(1)
		expect(shift.delivered).toBe(0)
		// The shift keeps going — a missed parcel is a setback, not the end.
		const next = shift.update(STEP, { x: 0, z: 0 })
		expect(next).not.toBeNull()
	})
})

describe("the streak", () => {
	it("builds with clean deliveries and caps", () => {
		const shift = new Shift(spotter())
		expect(shift.multiplier).toBe(1)
		for (let i = 0; i < 20; i++) {
			const job = shift.update(STEP, { x: 0, z: 0 })
			shift.update(STEP, { ...job.pickup })
			shift.update(STEP, { ...job.drop })
		}
		expect(shift.multiplier).toBe(3)
		expect(shift.bestStreak).toBeGreaterThanOrEqual(20)
	})

	it("resets when a parcel is dropped", () => {
		const shift = new Shift(spotter())
		for (let i = 0; i < 3; i++) {
			const job = shift.update(STEP, { x: 0, z: 0 })
			shift.update(STEP, { ...job.pickup })
			shift.update(STEP, { ...job.drop })
		}
		expect(shift.multiplier).toBeGreaterThan(1)
		const job = shift.update(STEP, { x: 0, z: 0 })
		job.left = 0.001
		shift.update(STEP, { x: 999, z: 999 })
		expect(shift.multiplier).toBe(1)
		// but the best is remembered
		expect(shift.bestStreak).toBe(3)
	})

	it("keeps paying more as the streak grows", () => {
		const shift = new Shift(spotter())
		const pay = []
		for (let i = 0; i < 6; i++) {
			const before = shift.score
			const job = shift.update(STEP, { x: 0, z: 0 })
			shift.update(STEP, { ...job.pickup })
			shift.update(STEP, { ...job.drop })
			pay.push(shift.score - before)
		}
		expect(pay[5]).toBeGreaterThan(pay[0])
	})
})

describe("crashing", () => {
	it("costs the clean bonus but never the parcel", () => {
		const clean = new Shift(spotter())
		const messy = new Shift(spotter())
		for (const [s, crash] of [
			[clean, false],
			[messy, true],
		]) {
			const job = s.update(STEP, { x: 0, z: 0 })
			if (crash) s.crash()
			s.update(STEP, { ...job.pickup })
			s.update(STEP, { ...job.drop })
			// The delivery still lands either way — losing a job to a clipped wall
			// would just be miserable.
			expect(s.delivered).toBe(1)
		}
		expect(messy.score).toBeLessThan(clean.score)
		expect(messy.crashes).toBe(1)
	})
})

describe("better driving scores better", () => {
	it("pays a faster driver more", () => {
		const slow = runShift(12)
		const quick = runShift(22)
		const fast = runShift(30)
		expect(quick.score).toBeGreaterThan(slow.score)
		expect(fast.score).toBeGreaterThan(quick.score)
	})

	it("pays a driver who takes a straighter line more", () => {
		const wobbly = runShift(22, { dither: 0.8 })
		const straight = runShift(22)
		expect(straight.score).toBeGreaterThan(wobbly.score)
	})

	it("pays a driver who does not crash more", () => {
		const careless = runShift(22, { crashEvery: 4 })
		const careful = runShift(22)
		expect(careful.score).toBeGreaterThan(careless.score)
	})

	it("puts a competent shift in a sensible range", () => {
		const shift = runShift(22)
		// Not so small that the numbers feel pointless, not so big that the score
		// stops meaning anything. Also sanity: the deliveries actually happened.
		expect(shift.delivered).toBeGreaterThan(4)
		expect(shift.score).toBeGreaterThan(500)
		expect(shift.score).toBeLessThan(200_000)
	})

	it("cannot score without delivering anything", () => {
		const shift = new Shift(spotter())
		// Parked in the middle of the ring of destinations, so it never reaches one.
		const car = { x: 0, z: 0 }
		while (!shift.over) shift.update(STEP, car)
		expect(shift.delivered).toBe(0)
		expect(shift.score).toBe(0)
		expect(shift.dropped).toBeGreaterThan(0)
	})
})

describe("what the leaderboard gets", () => {
	it("reports deliveries, stars and the quickest single run", () => {
		const shift = runShift(24)
		const stats = shift.stats(11)
		expect(stats.deliveries).toBe(shift.delivered)
		expect(stats.stars).toBe(11)
		expect(stats.bestRun).toBeGreaterThan(0)
		expect(Number.isInteger(stats.bestRun)).toBe(true)
	})

	it("reports the FASTEST delivery, not the slowest", () => {
		const shift = new Shift(spotter())
		// Two deliveries with very different durations.
		let job = shift.update(STEP, { x: 0, z: 0 })
		shift.update(STEP, { ...job.pickup })
		shift.timeLeft -= 30 // this one took ages
		shift.update(STEP, { ...job.drop })
		const slow = shift.bestRunSeconds
		job = shift.update(STEP, { x: 0, z: 0 })
		shift.update(STEP, { ...job.pickup })
		shift.update(STEP, { ...job.drop }) // this one was instant
		expect(shift.bestRunSeconds).toBeLessThan(slow)
	})

	it("reports zeroes for a shift with nothing delivered", () => {
		const shift = new Shift(spotter())
		const stats = shift.stats(0)
		expect(stats).toEqual({ deliveries: 0, stars: 0, bestRun: 0 })
	})
})
