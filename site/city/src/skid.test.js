// The tyre-screech mapping: slip in, loudness out.
//
// The mapping is a pure export precisely so it can be tested without an
// AudioContext — same reason the car and the fishing fight import no three.js.
// The property that matters most is the LAST test: ordinary cornering in the
// drifter must be silent. A screech that plays through normal driving is worse
// than no screech, and the car most likely to false-positive is the one Sofia
// will actually drive.

import { describe, expect, it } from "vitest"
import { Car, DRIFT_AT } from "./car.js"
import { skidLevel } from "./audio.js"

const STEP = 1 / 60

describe("skidLevel", () => {
	it("is silent below the onset", () => {
		expect(skidLevel(0, false)).toBe(0)
		expect(skidLevel(DRIFT_AT * 0.8 - 0.01, false)).toBe(0)
	})

	// The onset is deliberately BELOW the smoke/HUD threshold: a quiet
	// pre-squeal that swells into the slide, not a competing signal — at
	// DRIFT_AT itself the level is only ~8% of maximum.
	it("is barely audible at the visual drift threshold", () => {
		const atThreshold = skidLevel(DRIFT_AT, false)
		expect(atThreshold).toBeGreaterThan(0)
		expect(atThreshold).toBeLessThan(0.15)
	})

	it("swells with the slide and caps at one", () => {
		expect(skidLevel(3, false)).toBeLessThan(skidLevel(5, false))
		expect(skidLevel(5, false)).toBeLessThan(skidLevel(7, false))
		expect(skidLevel(30, false)).toBe(1)
	})

	it("is silent in the air — no tyres, no screech", () => {
		expect(skidLevel(10, true)).toBe(0)
	})

	it("is silent for a stationary handbrake hold", () => {
		// The physics gives this for free (no speed, no yaw authority, no lateral
		// velocity) — this pins the mapping's half of the contract.
		const car = new Car("drifter")
		for (let i = 0; i < 120; i++) car.update(STEP, { throttle: 0, steer: 1, handbrake: true })
		expect(skidLevel(car.slipAmount, false)).toBe(0)
	})

	// Grounded in the real physics: the drifter cornering at moderate speed and
	// half steer must not screech. If a handling retune ever pushes routine
	// cornering slip past the onset, this fails before Sofia spends an evening
	// listening to it. (Entering the same corner from FULL cruise is a
	// different scenario — there half-steer genuinely breaks the drifter's
	// traction, the smoke and DRIFT light fire, and the screech belongs.)
	it("stays silent through ordinary cornering in the drifter", () => {
		const car = new Car("drifter")
		while (car.speed < 15) car.update(STEP, { throttle: 1, steer: 0 })
		let maxLevel = 0
		let visualsAgreedSilent = true
		for (let i = 0; i < 600; i++) {
			car.update(STEP, { throttle: 0.32, steer: 0.5 })
			if (i > 60) {
				maxLevel = Math.max(maxLevel, skidLevel(car.slipAmount, car.airborne))
				if (car.drifting) visualsAgreedSilent = false
			}
		}
		expect(car.speed).toBeGreaterThan(10) // the corner was taken at real speed
		expect(maxLevel).toBeLessThan(0.05)
		expect(visualsAgreedSilent).toBe(true) // no smoke either — the game agrees
	})

	// The property that generalises the one above: the sound may whisper a
	// little before the visuals (the deliberate pre-squeal) but it must never
	// get LOUD while the smoke and the DRIFT light are saying nothing is
	// happening. Swept across entry speeds and steering angles.
	it("is never loud unless the game is also calling it a drift", () => {
		for (let steer = 0.2; steer <= 1.0; steer += 0.2) {
			for (const entry of [10, 20, 33]) {
				const car = new Car("drifter")
				while (car.speed < entry && car.speed < 32.9) car.update(STEP, { throttle: 1, steer: 0 })
				for (let i = 0; i < 360; i++) {
					car.update(STEP, { throttle: 0.4, steer })
					const level = skidLevel(car.slipAmount, car.airborne)
					if (level > 0.15) {
						expect(car.drifting, `steer ${steer} entry ${entry}`).toBe(true)
					}
				}
			}
		}
	})

	it("screeches when the drifter is actually thrown sideways", () => {
		const car = new Car("drifter")
		for (let i = 0; i < 840; i++) car.update(STEP, { throttle: 1, steer: 0 })
		let maxLevel = 0
		for (let i = 0; i < 300; i++) {
			car.update(STEP, { throttle: 1, steer: 1, handbrake: i < 30 })
			maxLevel = Math.max(maxLevel, skidLevel(car.slipAmount, car.airborne))
		}
		expect(maxLevel).toBeGreaterThan(0.3)
	})
})
