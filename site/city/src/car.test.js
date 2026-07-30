// Car handling.
//
// The plan said to spike the car before building a city around it, and to stop
// and re-tune if the handling wasn't fun. "Fun" isn't assertable, but the things
// that make driving expressive are: a top speed it approaches rather than
// snaps to, turns that tighten as you slow down, a slide you have to unwind
// instead of a mode you toggle, and three cars that actually feel different.
//
// Same approach as the fishing fight — measure it, don't guess at it.

import { describe, expect, it } from "vitest"
import { CARS, CAR_IDS, Car, DRIFT_AT } from "./car.js"

const STEP = 1 / 60

/** Drive for `seconds` with fixed inputs and report the final state. */
function drive(car, seconds, input) {
	const n = Math.round(seconds / STEP)
	for (let i = 0; i < n; i++) car.update(STEP, input)
	return car
}

/** Hold full throttle until the speed stops climbing. */
function upToSpeed(car, seconds = 14) {
	return drive(car, seconds, { throttle: 1 })
}

/**
 * Turning radius at a given speed, in metres: radius = speed / yaw rate.
 *
 * The speed is set directly rather than driven up to, because an earlier version
 * of this helper applied its own throttle and so dragged both the fast and the
 * slow car towards the same speed — which made the comparison it existed for
 * meaningless while still passing.
 */
function radiusAt(car, speed, steer = 1) {
	car.vx = car.fwdX * speed
	car.vz = car.fwdZ * speed
	let sum = 0
	let n = 0
	for (let i = 0; i < 24; i++) {
		car.update(STEP, { steer, throttle: 0.3 })
		if (Math.abs(car.yawRate) > 1e-4) {
			sum += car.speed / Math.abs(car.yawRate)
			n++
		}
	}
	return n ? sum / n : Infinity
}

describe("it goes and it stops", () => {
	it("approaches a top speed without exceeding it", () => {
		for (const id of CAR_IDS) {
			const car = upToSpeed(new Car(id))
			const max = CARS[id].maxSpeed
			// Close to the quoted top speed, and never past it.
			expect(car.speed, `${id} top speed`).toBeGreaterThan(max * 0.75)
			expect(car.speed, `${id} must not exceed its maximum`).toBeLessThanOrEqual(max + 0.01)
		}
	})

	it("takes time to get there, rather than snapping to top speed", () => {
		const car = new Car("scout")
		drive(car, 0.5, { throttle: 1 })
		const early = car.speed
		upToSpeed(car)
		// A power band, not a switch.
		expect(early).toBeLessThan(car.speed * 0.55)
	})

	it("brakes to a standstill", () => {
		const car = upToSpeed(new Car("scout"))
		expect(car.speed).toBeGreaterThan(10)
		// Measured as time-to-stop rather than a fixed window, because holding the
		// brake past a standstill is how you reverse — a window even slightly too
		// long measures reversing and reports it as a failure to brake.
		let t = 0
		while (car.forwardSpeed > 0.5 && t < 5) {
			car.update(STEP, { throttle: -1 })
			t += STEP
		}
		expect(t, "seconds to stop from top speed").toBeLessThan(1.6)
	})

	it("rolls to a stop on its own", () => {
		const car = upToSpeed(new Car("scout"))
		drive(car, 30, {})
		expect(car.speed).toBeLessThan(0.2)
	})

	it("reverses, but slower than it drives", () => {
		const car = new Car("scout")
		drive(car, 6, { throttle: -1 })
		expect(car.forwardSpeed).toBeLessThan(-2)
		expect(Math.abs(car.forwardSpeed)).toBeLessThan(CARS.scout.maxSpeed * 0.6)
	})

	it("never produces NaN, however it is thrashed", () => {
		const car = new Car("drifter")
		for (let i = 0; i < 4000; i++) {
			car.update(STEP, {
				throttle: Math.sin(i * 0.31),
				steer: Math.cos(i * 0.17),
				handbrake: i % 37 === 0,
			})
		}
		for (const v of [car.x, car.z, car.vx, car.vz, car.heading, car.speed, car.slipAmount]) {
			expect(Number.isFinite(v)).toBe(true)
		}
	})
})

// The whole original suite measured turning with Math.abs() and only ever
// compared signs against each other, so a completely inverted control scheme
// passed every test. These pin the absolute direction to the world.
describe("right means right", () => {
	it("goes right when steered right", () => {
		const car = upToSpeed(new Car("scout"))
		// heading 0 faces -Z, so the car's right hand is +X.
		drive(car, 2, { throttle: 1, steer: 1 })
		expect(car.x, "steer:+1 must move the car towards +X").toBeGreaterThan(2)
	})

	it("goes left when steered left", () => {
		const car = upToSpeed(new Car("scout"))
		drive(car, 2, { throttle: 1, steer: -1 })
		expect(car.x).toBeLessThan(-2)
	})

	it("swings the nose the other way in reverse", () => {
		const car = new Car("scout")
		drive(car, 3, { throttle: -1 })
		const noseBefore = car.heading
		drive(car, 2, { throttle: -1, steer: 1 })
		// Backing up with the wheel right: the nose swings LEFT (heading increases,
		// because increasing heading rotates the car towards its own left) while the
		// REAR tracks right, so the car body ends up towards +X. That is what a real
		// car does, and it's why the two directions have to be checked separately.
		expect(car.heading).toBeGreaterThan(noseBefore)
		expect(car.x).toBeGreaterThan(0)
	})

	it("rolls the body into the corner, not out of it", () => {
		const car = upToSpeed(new Car("scout"))
		drive(car, 1.2, { throttle: 1, steer: 1 })
		// Turning right, the body leans left — positive rotation about Z tips the
		// roof towards -X, which is what the renderer applies.
		expect(car.lean).toBeGreaterThan(0)
	})
})

describe("steering has weight", () => {
	it("cannot spin on the spot", () => {
		const car = new Car("scout")
		const heading = car.heading
		drive(car, 2, { steer: 1 })
		// Stationary means no steering authority — a parked car doesn't pirouette.
		expect(Math.abs(car.heading - heading)).toBeLessThan(0.01)
	})

	it("turns tighter slowly than quickly", () => {
		const slowRadius = radiusAt(new Car("scout"), 7)
		const fastRadius = radiusAt(new Car("scout"), 25)

		// Heavy at speed, nimble in a car park — but never locked out of the turn.
		expect(fastRadius).toBeGreaterThan(slowRadius * 1.3)
		expect(fastRadius).toBeLessThan(120)
	})

	it("steers the other way in reverse", () => {
		const fwd = new Car("scout")
		drive(fwd, 2, { throttle: 1 })
		const fwdBefore = fwd.heading
		drive(fwd, 0.5, { throttle: 1, steer: 1 })
		const fwdTurn = fwd.heading - fwdBefore

		const rev = new Car("scout")
		drive(rev, 3, { throttle: -1 })
		const revBefore = rev.heading
		drive(rev, 0.5, { throttle: -1, steer: 1 })
		const revTurn = rev.heading - revBefore

		expect(Math.sign(fwdTurn)).not.toBe(Math.sign(revTurn))
	})
})

describe("the slide", () => {
	it("drifts on the handbrake", () => {
		const car = upToSpeed(new Car("scout"))
		drive(car, 0.9, { throttle: 0.5, steer: 1, handbrake: true })
		expect(car.slipAmount, "handbrake should break traction").toBeGreaterThan(DRIFT_AT)
		expect(car.drifting).toBe(true)
	})

	it("holds the road without it", () => {
		const car = upToSpeed(new Car("scout"))
		drive(car, 0.9, { throttle: 0.5, steer: 0.7 })
		expect(car.drifting, "an ordinary turn should not be a drift").toBe(false)
	})

	// Full lock at full speed SHOULD start to let go — that's understeer, and a car
	// that stayed glued at the limit would have no limit to find.
	it("starts to slide at full lock at full speed", () => {
		const car = upToSpeed(new Car("scout"))
		drive(car, 0.9, { throttle: 1, steer: 1 })
		expect(car.slipAmount).toBeGreaterThan(1.4)
	})

	it("has to be unwound rather than switched off", () => {
		const car = upToSpeed(new Car("drifter"))
		drive(car, 1, { throttle: 0.5, steer: 1, handbrake: true })
		const sliding = car.slipAmount
		expect(sliding).toBeGreaterThan(DRIFT_AT)
		// One frame of letting go doesn't recover it...
		car.update(STEP, { throttle: 0.5 })
		expect(car.slipAmount).toBeGreaterThan(sliding * 0.7)
		// ...but a moment of straightening does.
		drive(car, 1.4, { throttle: 0.5 })
		expect(car.slipAmount).toBeLessThan(DRIFT_AT)
	})

	it("costs speed, so drifting everywhere is not the fast line", () => {
		const clean = upToSpeed(new Car("scout"))
		const drifty = upToSpeed(new Car("scout"))
		const before = clean.speed
		drive(clean, 1.2, { throttle: 1, steer: 0.5 })
		drive(drifty, 1.2, { throttle: 1, steer: 0.5, handbrake: true })
		expect(drifty.speed).toBeLessThan(clean.speed)
		expect(drifty.speed).toBeLessThan(before)
	})
})

describe("the three cars are actually different", () => {
	it("gives them meaningfully different top speeds", () => {
		const speeds = CAR_IDS.map((id) => upToSpeed(new Car(id)).speed)
		const spread = Math.max(...speeds) / Math.min(...speeds)
		expect(spread).toBeGreaterThan(1.15)
	})

	it("will not let the hauler drift", () => {
		const van = upToSpeed(new Car("van"))
		drive(van, 1.2, { throttle: 0.6, steer: 1, handbrake: true })
		// Its whole character: high grip, high slip threshold, hauls but won't play.
		expect(van.drifting).toBe(false)
	})

	it("lets the comet step out on the throttle alone", () => {
		const comet = upToSpeed(new Car("drifter"))
		drive(comet, 1.1, { throttle: 1, steer: 1 })
		expect(comet.slipAmount).toBeGreaterThan(1)
	})

	it("makes the hauler turn the widest", () => {
		// Same speed for all three, so this compares the cars and not their pace.
		const radii = {}
		for (const id of CAR_IDS) radii[id] = radiusAt(new Car(id), 18)
		expect(radii.van).toBeGreaterThan(radii.scout)
		expect(radii.drifter).toBeLessThan(radii.scout)
	})

	it("unlocks in a sensible order and starts with one free", () => {
		const costs = CAR_IDS.map((id) => CARS[id].stars)
		expect(Math.min(...costs)).toBe(0)
		expect(new Set(costs).size).toBe(costs.length)
	})
})

describe("hitting things", () => {
	it("bounces back off a wall it drives into", () => {
		const car = upToSpeed(new Car("scout"))
		car.vx = 0
		car.vz = -20 // heading -Z at speed
		const impact = car.bounce(0, 1) // wall facing +Z
		expect(impact).toBeGreaterThan(10)
		expect(car.vz).toBeGreaterThan(0)
	})

	it("scrubs speed on contact", () => {
		const car = new Car("scout")
		car.vx = 0
		car.vz = -20
		const before = car.speed
		car.bounce(0, 1)
		expect(car.speed).toBeLessThan(before)
	})

	it("ignores a wall it is already leaving", () => {
		const car = new Car("scout")
		car.vx = 0
		car.vz = 10
		const before = { vx: car.vx, vz: car.vz }
		expect(car.bounce(0, 1)).toBe(0)
		expect(car.vz).toBe(before.vz)
	})
})
