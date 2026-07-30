// SHIFT mode: the timed delivery run. The only part of this game that scores.
//
// Free roam is untimed, unscored and unbounded on purpose — it's the part Sofia
// actually asked for, and dropping a clock and a leaderboard onto it would ruin
// exactly the thing that makes it good. So the competitive game is a separate
// five-minute mode you opt into, and everything in this file is about that mode.
//
// The shape: collect at A, deliver to B before the parcel's own timer runs out,
// and the next job appears immediately. Chaining without dropping one builds a
// streak multiplier, so the run rewards a clean rhythm rather than one heroic
// delivery. Crashing costs you the clean-driving bonus but never the parcel,
// because losing a job to a wall you clipped would be miserable.
//
// No three.js here, so the scoring can be simulated the same way the fishing
// fight was.

import { clamp } from "../../shared/util.js"

export const SHIFT_SECONDS = 300

/** Streak multiplier: +0.25 per clean delivery, capped. */
const STREAK_STEP = 0.25
const STREAK_MAX = 3

/** Seconds allowed per metre of route, plus a fixed grace. */
const TIME_PER_METRE = 0.115
const TIME_GRACE = 14
/**
 * No single parcel may be worth more time than this.
 *
 * The allowance is derived partly from how far the car is from the pickup, so
 * without a cap a job offered from the far corner of the map could carry an
 * allowance longer than the whole shift — a parcel that can never be late is not
 * a delivery, it's a formality.
 */
const TIME_CAP = 90

/** Cash for a delivery, before bonuses. */
const BASE_FEE = 60
const FEE_PER_METRE = 1.5

export class Shift {
	/**
	 * @param pickSpot (avoid) => {x, z, label}  supplies destinations
	 */
	constructor(pickSpot) {
		this.pickSpot = pickSpot
		this.reset()
	}

	reset() {
		this.timeLeft = SHIFT_SECONDS
		this.score = 0
		this.delivered = 0
		this.dropped = 0
		this.streak = 0
		this.bestStreak = 0
		this.crashes = 0
		this.bestRunSeconds = 0
		this.job = null
		this.over = false
		this._lastEvent = null
	}

	get multiplier() {
		return Math.min(STREAK_MAX, 1 + this.streak * STREAK_STEP)
	}

	/** Whatever just happened, for the HUD to react to. Read-and-clear. */
	takeEvent() {
		const e = this._lastEvent
		this._lastEvent = null
		return e
	}

	/** Straight-line distance is a fine proxy here — the grid means routes are close to L1. */
	static routeLength(a, b) {
		return Math.hypot(a.x - b.x, a.z - b.z)
	}

	/**
	 * Offer a new job from the car's current position.
	 *
	 * The pickup is somewhere near you and the drop is somewhere else, so a job is
	 * always "go there, then go over there" rather than a single hop.
	 */
	newJob(from) {
		const pickup = this.pickSpot(from, 30)
		const drop = this.pickSpot(pickup, 90)
		const legOne = Shift.routeLength(from, pickup)
		const legTwo = Shift.routeLength(pickup, drop)
		// Two legs, so the allowance covers getting to the parcel as well.
		const allowed = Math.min(TIME_CAP, TIME_GRACE + (legOne + legTwo) * TIME_PER_METRE)
		this.job = {
			pickup,
			drop,
			allowed,
			left: allowed,
			distance: legTwo,
			carrying: false,
			startedAt: this.timeLeft,
			clean: true,
		}
		return this.job
	}

	/** Called when the car crashes hard enough to matter. */
	crash() {
		this.crashes++
		if (this.job) this.job.clean = false
	}

	/**
	 * Advance the clock.
	 *
	 * @param carAt {x, z} the car's position
	 * @returns the current job, or null when the shift is over
	 */
	update(dt, carAt) {
		if (this.over) return null
		this.timeLeft -= dt
		if (this.timeLeft <= 0) {
			this.timeLeft = 0
			this.over = true
			// A parcel in the boot at the whistle is not a delivery.
			if (this.job && this.job.carrying) this._drop("time")
			this.job = null
			return null
		}

		if (!this.job) {
			this.newJob(carAt)
			this._lastEvent = { kind: "job", job: this.job }
			return this.job
		}

		const job = this.job
		job.left -= dt
		if (job.left <= 0) {
			this._drop("late")
			return this.job
		}

		const target = job.carrying ? job.drop : job.pickup
		const near = Math.hypot(carAt.x - target.x, carAt.z - target.z) < 6.5
		if (!near) return job

		if (!job.carrying) {
			job.carrying = true
			this._lastEvent = { kind: "pickup", job }
		} else {
			this._complete(job)
		}
		return this.job
	}

	_complete(job) {
		const timeBonusFrac = clamp(job.left / job.allowed, 0, 1)
		const fee = BASE_FEE + job.distance * FEE_PER_METRE
		// Three separate rewards: the job itself, how much of the clock you saved,
		// and whether you got there without hitting anything.
		const timeBonus = fee * 0.6 * timeBonusFrac
		const cleanBonus = job.clean ? fee * 0.25 : 0
		const gained = Math.round((fee + timeBonus + cleanBonus) * this.multiplier)

		this.score += gained
		this.delivered++
		this.streak++
		this.bestStreak = Math.max(this.bestStreak, this.streak)
		// Fastest, not slowest. `bestRun` is a brag, so it has to be the minimum —
		// and 0 means "nothing delivered yet" rather than "instant".
		const took = Math.round(job.startedAt - this.timeLeft)
		this.bestRunSeconds =
			this.bestRunSeconds === 0 ? took : Math.min(this.bestRunSeconds, took)

		this._lastEvent = {
			kind: "delivered",
			gained,
			clean: job.clean,
			multiplier: this.multiplier,
			seconds: took,
		}
		this.job = null
	}

	_drop(reason) {
		this.dropped++
		this.streak = 0
		this._lastEvent = { kind: "dropped", reason }
		this.job = null
	}

	/** What the leaderboard gets. */
	stats(starsCollected) {
		return {
			deliveries: this.delivered,
			stars: starsCollected,
			// The quickest single delivery, in seconds — the number worth bragging
			// about, and the one that shows next to the score on the board.
			bestRun: this.bestRunSeconds,
		}
	}
}
