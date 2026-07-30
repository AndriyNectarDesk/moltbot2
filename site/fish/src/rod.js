// Rod, line and float.
//
// The float is the whole interface. Everything the player needs to decide comes
// through it — where the bait landed, whether something is interested, what kind
// of something, and which way it is pulling. So it gets more care than its size
// suggests: it rides the real water surface, it leans rather than teleporting,
// and the line between it and the rod tip sags or goes taut with tension.

import * as THREE from "three"
import { TAU, clamp, damp, lerp } from "../../shared/util.js"

const LINE_POINTS = 10

/** Where the angler stands, at the end of the dock. */
export const ROD_BASE = new THREE.Vector3(0.55, 1.05, -3.6)

export class Rod {
	constructor(scene, lake) {
		this.scene = scene
		this.lake = lake

		this.charge = 0
		this.sink = 0 // metres the float is pulled under, driven by the bite
		this._sinkShown = 0
		this.bobber = new THREE.Vector3(0, 0, -10)
		this.cast = null // in-flight cast, if any
		this.inWater = false
		this.taut = 0

		this._buildRod()
		this._buildBobber()
		this._buildLine()
	}

	_buildRod() {
		this.rodGroup = new THREE.Group()
		const mat = new THREE.MeshStandardMaterial({ color: 0x2a2118, roughness: 0.55, metalness: 0.2 })
		// Two segments so the rod can bend under load — a straight stick reads as
		// a broom handle, and the bend is the clearest read on strain there is.
		this.rodLower = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.018, 1.1, 6), mat)
		this.rodLower.position.set(0, 0.55, 0)
		this.rodUpper = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.008, 1.1, 6), mat)
		this.rodUpper.position.set(0, 0.55, 0)
		this.upperPivot = new THREE.Group()
		this.upperPivot.position.set(0, 1.1, 0)
		this.upperPivot.add(this.rodUpper)
		this.rodLower.add(this.upperPivot)

		const grip = new THREE.Mesh(
			new THREE.CylinderGeometry(0.042, 0.038, 0.34, 8),
			new THREE.MeshStandardMaterial({ color: 0x1d2b22, roughness: 1 }),
		)
		grip.position.set(0, 0.17, 0)
		this.rodGroup.add(grip)

		const reel = new THREE.Mesh(
			new THREE.CylinderGeometry(0.11, 0.11, 0.07, 12),
			new THREE.MeshStandardMaterial({ color: 0x8a8f7d, roughness: 0.4, metalness: 0.6 }),
		)
		reel.rotation.z = Math.PI / 2
		reel.position.set(-0.1, 0.42, 0)
		this.reel = reel
		this.rodGroup.add(reel)

		this.rodGroup.add(this.rodLower)
		this.rodGroup.position.copy(ROD_BASE)
		// Held out over the water at roughly the angle you'd actually hold a rod —
		// well forward of vertical, so the tip leads the line out to the float.
		this.rodGroup.rotation.set(-1.05, 0.14, 0.2)
		this.scene.add(this.rodGroup)

		this._tip = new THREE.Vector3()
	}

	_buildBobber() {
		this.bobberGroup = new THREE.Group()
		const top = new THREE.Mesh(
			new THREE.SphereGeometry(0.11, 10, 8, 0, TAU, 0, Math.PI / 2),
			new THREE.MeshStandardMaterial({ color: 0xd9542f, roughness: 0.45 }),
		)
		const bottom = new THREE.Mesh(
			new THREE.SphereGeometry(0.11, 10, 8, 0, TAU, Math.PI / 2, Math.PI / 2),
			new THREE.MeshStandardMaterial({ color: 0xf2ece0, roughness: 0.5 }),
		)
		const stick = new THREE.Mesh(
			new THREE.CylinderGeometry(0.014, 0.014, 0.3, 5),
			new THREE.MeshStandardMaterial({ color: 0xe8e2d4, roughness: 0.6 }),
		)
		stick.position.y = 0.19
		this.bobberGroup.add(top, bottom, stick)
		this.bobberGroup.visible = false
		this.scene.add(this.bobberGroup)
	}

	_buildLine() {
		const geo = new THREE.BufferGeometry()
		geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(LINE_POINTS * 3), 3))
		this.line = new THREE.Line(
			geo,
			new THREE.LineBasicMaterial({ color: 0xdfe6e2, transparent: true, opacity: 0.55 }),
		)
		this.line.visible = false
		this.scene.add(this.line)
	}

	/** World position of the rod tip, recomputed each frame because the rod bends. */
	tip() {
		this.rodUpper.updateWorldMatrix(true, false)
		return this._tip.set(0, 0.75, 0).applyMatrix4(this.rodUpper.matrixWorld)
	}

	// ------------------------------------------------------------ casting

	/** How far a cast at the current charge would reach, for the aiming guide. */
	static reachFor(charge, min, max) {
		return lerp(min, max, clamp(charge, 0, 1))
	}

	beginCharge() {
		this.charge = 0
	}

	chargeUp(dt) {
		// A full wind-up in a bit over a second: long enough to be a decision,
		// short enough that a short cast is a real choice rather than a penalty.
		this.charge = clamp(this.charge + dt / 1.15, 0, 1)
	}

	/** Launch the float towards a point on the water. */
	release(target) {
		const from = this.tip().clone()
		this.cast = {
			t: 0,
			dur: clamp(0.42 + from.distanceTo(target) * 0.026, 0.5, 1.15),
			from,
			to: target.clone(),
			arc: clamp(1.1 + this.charge * 2.2, 1.1, 3.4),
		}
		this.inWater = false
		this.bobberGroup.visible = true
		this.line.visible = true
		this.charge = 0
	}

	/** Wind everything back in — between casts and at the end of a run. */
	reelIn() {
		this.cast = null
		this.inWater = false
		this.sink = 0
		this._sinkShown = 0
		this.taut = 0
		// Clear the wind-up too, or a run that ends mid-charge leaves the rod
		// permanently bent on the title screen.
		this.charge = 0
		this.bobberGroup.visible = false
		this.line.visible = false
	}

	// ------------------------------------------------------------ per frame

	update(dt, { tension = 0, pullDir = null, reeling = false } = {}) {
		// Rod bend: a little from the wind-up, a lot from a fish.
		const load = Math.max(this.charge * 0.45, tension)
		this.upperPivot.rotation.x = damp(this.upperPivot.rotation.x, -load * 0.85, 0.002, dt)
		this.rodLower.rotation.x = damp(this.rodLower.rotation.x, -load * 0.3, 0.004, dt)
		if (reeling) this.reel.rotation.x += dt * 14

		if (this.cast) {
			const c = this.cast
			c.t += dt
			const k = clamp(c.t / c.dur, 0, 1)
			this.bobber.lerpVectors(c.from, c.to, k)
			// Parabola on top of the straight line, so the float actually flies.
			this.bobber.y += Math.sin(k * Math.PI) * c.arc
			if (k >= 1) {
				this.cast = null
				this.inWater = true
				this.bobber.copy(c.to)
			}
		}

		// Follow the fish while it's on.
		if (this.inWater && pullDir) {
			this.bobber.x = damp(this.bobber.x, pullDir.x, 0.0001, dt)
			this.bobber.z = damp(this.bobber.z, pullDir.z, 0.0001, dt)
		}

		// The visible dip lags the requested one, which is what turns a number
		// into a tell you can read.
		// Fast enough that a 105 ms flick actually reaches the screen. At the old
		// 0.138 s time constant the two quickest tells showed less than half their
		// amplitude, which put them below the movement of the wave underneath.
		this._sinkShown = damp(this._sinkShown, this.sink, 2e-8, dt)

		if (this.inWater) {
			const surface = this.lake.heightAt(this.bobber.x, this.bobber.z)
			this.bobber.y = surface - this._sinkShown
			// Lean into the pull rather than staying upright.
			const lean = clamp(this._sinkShown * 1.6 + tension * 0.5, 0, 1.1)
			this.bobberGroup.rotation.z = Math.sin(this.lake.time * 1.7) * 0.06 + lean * 0.5
		}

		this.bobberGroup.position.copy(this.bobber)
		this.taut = damp(this.taut, tension, 0.002, dt)
		this._updateLine()
	}

	_updateLine() {
		if (!this.line.visible) return
		const tip = this.tip()
		const pos = this.line.geometry.attributes.position
		const arr = pos.array
		// Sag drops away as the line comes tight — the clearest visual for strain
		// after the rod bend itself.
		const sag = lerp(0.55, 0.03, clamp(this.taut, 0, 1)) * (this.cast ? 0.2 : 1)
		const span = tip.distanceTo(this.bobber)
		for (let i = 0; i < LINE_POINTS; i++) {
			const k = i / (LINE_POINTS - 1)
			arr[i * 3] = lerp(tip.x, this.bobber.x, k)
			arr[i * 3 + 1] = lerp(tip.y, this.bobber.y, k) - Math.sin(k * Math.PI) * sag * span * 0.09
			arr[i * 3 + 2] = lerp(tip.z, this.bobber.z, k)
		}
		pos.needsUpdate = true
		this.line.geometry.computeBoundingSphere()
	}
}
