// The car.
//
// This is the most important file in the game. Everything else here — the city,
// the stars, the deliveries — is scaffolding around the question "is driving this
// thing fun?", and if the answer is no then nothing else rescues it. So it gets
// built and tuned before there is a city to drive it in, and it deliberately
// imports no three.js so the handling can be simulated and measured rather than
// guessed at.
//
// Arcade, not a simulation. But arcade with the one piece of real behaviour that
// makes driving expressive: the car has a HEADING and a VELOCITY, and they are
// allowed to disagree. Steering rotates the heading; grip drags the velocity back
// towards it. When you ask for more turn than the tyres can give, the difference
// is a slide — so drifting isn't a special mode, it's just what happens when you
// exceed grip. The handbrake is a grip multiplier and nothing more.
//
// Three consequences worth keeping:
//   - Steering authority falls with speed, so the car feels heavy fast and nimble
//     in a car park, without ever locking the player out of a turn.
//   - You can't accelerate out of a slide instantly; you have to unwind it.
//   - Reverse steers the way reverse actually steers.

import { clamp, lerp } from "../../shared/util.js"

/**
 * Handling presets. `stars` is what it costs to unlock — the first car is free.
 *
 * These are three genuinely different cars rather than three colours: the van
 * understeers and hauls, the drifter has deliberately poor lateral grip so it
 * steps out on purpose, and the starter sits in between.
 */
export const CARS = {
	scout: {
		label: "SCOUT",
		blurb: "Nippy little hatchback. Forgiving.",
		stars: 0,
		body: 0x36c8d8,
		trim: 0xf2f6f7,
		power: 15.5,
		maxSpeed: 27,
		reverseSpeed: 9,
		brake: 26,
		turn: 2.5,
		turnRefSpeed: 8.5,
		grip: 17,
		slip: 3.0,
		handbrakeGrip: 0.16,
		drag: 0.42,
		roll: 1.5,
		mass: 1,
	},
	van: {
		label: "HAULER",
		blurb: "Slow to turn, hard to stop, holds the road.",
		stars: 14,
		body: 0xe8863a,
		trim: 0xf7efe2,
		power: 13.5,
		maxSpeed: 24,
		reverseSpeed: 8,
		brake: 20,
		turn: 1.85,
		turnRefSpeed: 10.5,
		// High grip and a high slip threshold: it just will not drift.
		grip: 26,
		slip: 5.0,
		handbrakeGrip: 0.45,
		drag: 0.5,
		roll: 1.9,
		mass: 1.35,
	},
	drifter: {
		label: "COMET",
		blurb: "Fast, loose, and it will bite you.",
		stars: 34,
		body: 0xff3d8b,
		trim: 0x2b1440,
		power: 19,
		maxSpeed: 33,
		reverseSpeed: 10,
		brake: 28,
		turn: 3.1,
		turnRefSpeed: 7.5,
		// Low grip and a low slip threshold: it steps out on purpose.
		grip: 11,
		slip: 2.2,
		handbrakeGrip: 0.14,
		drag: 0.38,
		roll: 1.3,
		mass: 0.92,
	},
}

export const CAR_IDS = Object.keys(CARS)

/** How far sideways the tyres have to be sliding before it reads as a drift. */
export const DRIFT_AT = 2.4

export class Car {
	constructor(id = "scout", x = 0, z = 0, heading = 0) {
		this.setCar(id)
		this.x = x
		this.z = z
		this.heading = heading
		// World-space velocity. Kept in world space on purpose: the whole point is
		// that it can point somewhere other than where the car does.
		this.vx = 0
		this.vz = 0
		this.yawRate = 0
		// Read by the renderer for body roll and the wheels.
		this.slipAmount = 0
		this.lean = 0
		this.wheelSpin = 0
		this.steerShown = 0
		this.airborne = false
		this.y = 0
		this.vy = 0
	}

	setCar(id) {
		this.id = CARS[id] ? id : "scout"
		this.spec = CARS[this.id]
	}

	/** Forward unit vector. heading 0 faces -Z, matching three.js convention. */
	get fwdX() {
		return -Math.sin(this.heading)
	}

	get fwdZ() {
		return -Math.cos(this.heading)
	}

	/** Signed speed along the car's own axis: negative means reversing. */
	get forwardSpeed() {
		return this.vx * this.fwdX + this.vz * this.fwdZ
	}

	/** Sideways speed. This is the drift. */
	get lateralSpeed() {
		// right = fwd rotated -90° about Y
		return this.vx * -this.fwdZ + this.vz * this.fwdX
	}

	get speed() {
		return Math.hypot(this.vx, this.vz)
	}

	get drifting() {
		return Math.abs(this.lateralSpeed) > DRIFT_AT
	}

	/** 0..1 for the speedo. */
	get speedFrac() {
		return clamp(this.speed / this.spec.maxSpeed, 0, 1)
	}

	get kph() {
		// Not real units — just a number that feels like a speedo.
		return Math.round(this.speed * 7.2)
	}

	/**
	 * One step.
	 *
	 * @param throttle -1..1, negative is brake/reverse
	 * @param steer    -1..1
	 * @param handbrake boolean
	 */
	update(dt, { throttle = 0, steer = 0, handbrake = false } = {}) {
		const s = this.spec

		// ---- steering, FIRST
		// Order matters more than anything else in this function. The heading turns
		// while the velocity stays put in world space; only afterwards is that
		// velocity resolved into the car's new frame. That is what creates lateral
		// slip in the first place — decomposing before the turn and recomposing
		// after it would just rotate the velocity along with the car, and the car
		// could never slide at all no matter what the grip numbers said.
		const entrySpeed = this.forwardSpeed
		// Authority ramps in with speed so a stationary car can't spin on the spot,
		// and eases off at high speed so it feels heavy rather than twitchy — but
		// never to zero, or fast corners would be impossible instead of hard.
		const speedRamp = clamp(Math.abs(entrySpeed) / s.turnRefSpeed, 0, 1)
		const highSpeedEase = lerp(1, 0.55, clamp(Math.abs(entrySpeed) / s.maxSpeed, 0, 1))
		// Reversing steers the other way, as it does in a real car park.
		const dir = entrySpeed < -0.2 ? -1 : 1
		// Note the leading minus. `forward` is (-sin h, -cos h), so INCREASING the
		// heading rotates the car toward its own left — which means a positive
		// steer input has to produce a negative yaw rate for "right" to mean right.
		// Without it the whole game steers backwards, and nothing else catches it
		// because the wheels, the body roll and the mesh are all coherently
		// left-positive too. See the absolute-direction test in car.test.js.
		this.yawRate = -steer * s.turn * speedRamp * highSpeedEase * dir
		this.heading += this.yawRate * dt
		this.steerShown = lerp(this.steerShown, steer, 1 - Math.pow(0.001, dt))

		// ---- resolve the (unchanged) velocity into the new frame
		let vLong = this.forwardSpeed
		let vLat = this.lateralSpeed

		// ---- engine and brakes
		if (throttle > 0) {
			// The headroom term is what sets top speed, so no drag is applied under
			// power — the car eases up to its maximum instead of fighting a wall.
			const headroom = clamp(1 - vLong / s.maxSpeed, 0, 1)
			vLong += (throttle * s.power * headroom * dt) / s.mass
		} else if (throttle < 0) {
			if (vLong > 0.4) {
				// Braking, not reversing.
				vLong = Math.max(0, vLong + throttle * s.brake * dt)
			} else {
				const headroom = clamp(1 + vLong / s.reverseSpeed, 0, 1)
				vLong += (throttle * s.power * 0.6 * headroom * dt) / s.mass
			}
		} else {
			// Coasting: rolling resistance plus a linear air term. Only off-throttle,
			// so it decides how the car slows down and not how fast it goes.
			const decel = (s.roll + s.drag * Math.abs(vLong)) * dt
			vLong -= Math.sign(vLong) * Math.min(Math.abs(vLong), decel)
		}

		// ---- grip
		// The heart of it. Turning generates lateral velocity at roughly
		// speed × yawRate, and grip bleeds it away again. The decay is exponential
		// rather than a fixed metres-per-second correction: a flat cap can't keep up
		// with a demand that scales with speed, so at any real pace the slide simply
		// ran away — the first version of this reached 28 m/s sideways and never
		// recovered.
		//
		// Past `slip` the tyres are saturated and grip drops, so breaking traction
		// makes the next moment worse. That's the bit that has to be caught rather
		// than switched off. Handbrake scales grip down wholesale, which is the
		// entire drift mechanic.
		const saturated = Math.abs(vLat) > s.slip ? 0.55 : 1
		const gripNow = s.grip * (handbrake ? s.handbrakeGrip : 1) * saturated
		vLat *= Math.exp(-gripNow * dt)

		// A slide has a maximum angle. Without this the decompose-and-recompose
		// adds energy every frame and the car ends up travelling sideways faster
		// than it is going forwards, which is not a drift, it's a bug.
		const maxLat = Math.abs(vLong) * 1.15 + 1.5
		vLat = clamp(vLat, -maxLat, maxLat)

		// Sliding sideways scrubs speed off, which is what stops a permanent drift
		// from also being the fastest way around a corner.
		vLong -= Math.sign(vLong) * Math.min(Math.abs(vLong), Math.abs(vLat) * 0.5 * dt)

		// ---- reassemble
		this.vx = this.fwdX * vLong + -this.fwdZ * vLat
		this.vz = this.fwdZ * vLong + this.fwdX * vLat

		this.x += this.vx * dt
		this.z += this.vz * dt

		this.slipAmount = Math.abs(vLat)
		// Body roll leans out of the corner and into the slide.
		const targetLean = clamp(-this.yawRate * 0.16 - vLat * 0.012, -0.16, 0.16)
		this.lean = lerp(this.lean, targetLean, 1 - Math.pow(0.002, dt))
		this.wheelSpin += vLong * dt * 2.2
	}

	/** Called by the collision code when the car hits something. */
	bounce(nx, nz, restitution = 0.28) {
		const along = this.vx * nx + this.vz * nz
		if (along >= 0) return 0
		this.vx -= (1 + restitution) * along * nx
		this.vz -= (1 + restitution) * along * nz
		// Scrub some speed on any contact, so walls are a cost rather than a rail
		// to slide along.
		this.vx *= 0.86
		this.vz *= 0.86
		return -along
	}

	stop() {
		this.vx = 0
		this.vz = 0
		this.yawRate = 0
		this.slipAmount = 0
	}
}
