// Rod, line and float.
//
// The float is the whole interface. Everything the player needs to decide comes
// through it — where the bait landed, whether something is interested, what kind
// of something, and which way it is pulling. So it gets more care than its size
// suggests: it rides the real water surface, it leans rather than teleporting,
// and the line between it and the rod tip sags or goes taut with tension.

import * as THREE from "three"
import { TAU, clamp, damp, lerp } from "../../shared/util.js"

const LINE_POINTS = 15

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
			new THREE.SphereGeometry(0.14, 10, 8, 0, TAU, 0, Math.PI / 2),
			new THREE.MeshStandardMaterial({ color: 0xff5a30, roughness: 0.45 }),
		)
		const bottom = new THREE.Mesh(
			new THREE.SphereGeometry(0.14, 10, 8, 0, TAU, Math.PI / 2, Math.PI / 2),
			new THREE.MeshStandardMaterial({ color: 0xf2ece0, roughness: 0.5 }),
		)
		const stick = new THREE.Mesh(
			new THREE.CylinderGeometry(0.018, 0.018, 0.3, 5),
			new THREE.MeshStandardMaterial({ color: 0xe8e2d4, roughness: 0.6 }),
		)
		stick.position.y = 0.19
		// The hi-vis tip, and the one part that is deliberately UNLIT: real
		// floats carry a bright bead for exactly this reason, and an unlit
		// material cannot go dark against dark water on the tiers with no bloom.
		const bead = new THREE.Mesh(
			new THREE.SphereGeometry(0.05, 8, 6),
			new THREE.MeshBasicMaterial({ color: 0xffd23f }),
		)
		bead.position.y = 0.35
		this.bobberGroup.add(top, bottom, stick, bead)
		this.bobberGroup.visible = false
		this.scene.add(this.bobberGroup)

		// A faint fixed ring at the waterline. It anchors the float on dark
		// water, and because it stays AT the surface while the float dips, the
		// dip reads against a reference instead of against open water. Its own
		// texture, deliberately NOT lake.js's ringTexture: that bright cool
		// double stroke is the RISING FISH signal, the highest-value read in the
		// game, and a miniature copy under the float would be a false spot.
		const c = document.createElement("canvas")
		c.width = c.height = 64
		const x = c.getContext("2d")
		x.strokeStyle = "rgba(255,226,178,0.5)"
		x.lineWidth = 3
		x.beginPath()
		x.arc(32, 32, 26, 0, TAU)
		x.stroke()
		const tex = new THREE.CanvasTexture(c)
		tex.colorSpace = THREE.SRGBColorSpace
		this.floatRing = new THREE.Mesh(
			new THREE.PlaneGeometry(0.7, 0.7),
			new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.3, depthWrite: false }),
		)
		this.floatRing.rotation.x = -Math.PI / 2
		this.floatRing.visible = false
		// A sibling of the group, not a child: a child would sink with the dip
		// and tilt with the lean, destroying its whole purpose as the fixed
		// reference the dip is read against.
		this.scene.add(this.floatRing)
	}

	_buildLine() {
		// A ribbon, not a THREE.Line: linewidth is dead on WebGL, so a Line is a
		// one-pixel hairline at every distance, and at the capped pixel ratios
		// the low tiers run it aliases into a dotted arc — which is exactly how
		// it looked in the first real phone screenshot. Two vertices per catenary
		// sample, offset perpendicular to the view direction so the strip always
		// faces the camera; one draw call.
		const geo = new THREE.BufferGeometry()
		geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(LINE_POINTS * 2 * 3), 3))
		const index = []
		for (let i = 0; i < LINE_POINTS - 1; i++) {
			const a = i * 2
			index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
		}
		geo.setIndex(index)
		this.line = new THREE.Mesh(
			geo,
			new THREE.MeshBasicMaterial({
				color: 0xeef4f0,
				transparent: true,
				opacity: 0.85,
				side: THREE.DoubleSide,
				// Explicit and load-bearing: with depthWrite off, the 0.97-opacity
				// water overdraws the line to near-invisibility — the exact bug
				// this ribbon exists to fix, reintroduced invisibly.
				depthWrite: true,
			}),
		)
		// The float arcs metres above the tip-to-float chord mid-cast; stale
		// bounds would cull the ribbon in flight, so it opts out entirely.
		this.line.frustumCulled = false
		this.line.visible = false
		this.scene.add(this.line)
		this._side = new THREE.Vector3()
		this._tangent = new THREE.Vector3()
		this._toCam = new THREE.Vector3()
		this._sample = new THREE.Vector3()
		// Set by setView; harmless defaults so the rod renders before the first
		// resize event lands.
		this._camera = null
		this._viewHeight = 800
	}

	/** The camera and render height, for the ribbon's screen-space width floor. */
	setView(camera, pixelHeight) {
		this._camera = camera
		// A hidden iframe reports a 0-height viewport (same trap _resize guards
		// against in main.js). Flooring at 1 turned the pixel floor into a
		// ~1.4-unit-per-metre multiplier and inflated the far line to tens of
		// metres wide; 240 is the smallest height any real screen shows.
		this._viewHeight = Math.max(240, pixelHeight || 0)
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
		this.bobberGroup.scale.setScalar(1)
		this.floatRing.visible = false
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
			// Distance compensation: a float that reads at 10m is two pixels at
			// 30m, so it grows with the cast — and the VISUAL dip grows with it,
			// so the proportional submersion of a tell is the same at every
			// distance. The physics sink is untouched; only the rendered offset
			// scales. Constant during wait/tell (the float lands and stays), so
			// the bite read is never confounded by the scale changing under it.
			const s = clamp(Math.hypot(this.bobber.x - ROD_BASE.x, this.bobber.z - ROD_BASE.z) / 14, 1, 1.6)
			this.bobberGroup.scale.setScalar(s)
			this.bobber.y = surface - this._sinkShown * s
			// Lean into the pull rather than staying upright.
			const lean = clamp(this._sinkShown * 1.6 + tension * 0.5, 0, 1.1)
			this.bobberGroup.rotation.z = Math.sin(this.lake.time * 1.7) * 0.06 + lean * 0.5

			this.floatRing.visible = true
			// 0.04 above the surface, matching the glitter: the rendered water is a
			// coarse grid on the low tiers and 0.02 sat inside its interpolation
			// error, so crests could clip arcs out of the ring exactly where the
			// ring matters most.
			this.floatRing.position.set(this.bobber.x, surface + 0.04, this.bobber.z)
			this.floatRing.scale.setScalar(s)
		} else {
			this.floatRing.visible = false
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

		// Screen-space width floor: at 34m a constant-width ribbon subtends less
		// than a pixel on a low-tier phone and aliases into the same dotted arc
		// as the hairline it replaced. Each sample is at least ~1.3 rendered
		// pixels wide, whatever the distance.
		const cam = this._camera
		const k =
			cam ? (1.3 * 2 * Math.tan((cam.fov * Math.PI) / 360)) / this._viewHeight : 0
		const camPos = cam ? cam.position : null

		let px = 0
		let py = 0
		let pz = 0
		for (let i = 0; i < LINE_POINTS; i++) {
			const t = i / (LINE_POINTS - 1)
			const sx = lerp(tip.x, this.bobber.x, t)
			const sy = lerp(tip.y, this.bobber.y, t) - Math.sin(t * Math.PI) * sag * span * 0.09
			const sz = lerp(tip.z, this.bobber.z, t)

			// Tangent along the curve, from the previous sample (forward for i=0).
			if (i === 0) {
				const nt = 1 / (LINE_POINTS - 1)
				this._tangent.set(
					lerp(tip.x, this.bobber.x, nt) - sx,
					lerp(tip.y, this.bobber.y, nt) - Math.sin(nt * Math.PI) * sag * span * 0.09 - sy,
					lerp(tip.z, this.bobber.z, nt) - sz,
				)
			} else {
				this._tangent.set(sx - px, sy - py, sz - pz)
			}

			// Half-width: tapers toward the float, floored in screen space.
			const dist = camPos ? this._sample.set(sx, sy, sz).distanceTo(camPos) : 10
			// Capped absolutely as well: no viewport state, however broken, may
			// turn the line into a ribbon wider than the float.
			const half = Math.min(Math.max(0.013 * lerp(1, 0.6, t), dist * k), 0.28) / 2

			// Side vector perpendicular to both the curve and the view direction,
			// so the strip faces the camera. The camera looks DOWN the casting
			// lane and so does the line, so near-parallel is the common case, not
			// the freak one: when the cross degenerates, keep the previous side.
			if (camPos) {
				this._toCam.set(camPos.x - sx, camPos.y - sy, camPos.z - sz)
				// Crossed into a SCRATCH vector, not _side: crossing in place would
				// overwrite the previous side before the length test, so the
				// keep-the-last-good-side fallback would actually keep the near-zero
				// garbage — rungs collapsing to the centreline on exactly the
				// camera-on-line geometry the guard exists for. The first version
				// shipped that way and its comment described the opposite of its
				// behaviour; _sample is free here, its dist is already taken.
				const cross = this._sample.set(0, 0, 0).crossVectors(this._tangent, this._toCam)
				if (cross.lengthSq() > 1e-8) this._side.copy(cross).normalize()
				else if (i === 0) this._side.set(1, 0, 0)
				// else: _side genuinely still holds the last valid sample's side
			} else {
				this._side.set(1, 0, 0)
			}

			arr[i * 6] = sx + this._side.x * half
			arr[i * 6 + 1] = sy + this._side.y * half
			arr[i * 6 + 2] = sz + this._side.z * half
			arr[i * 6 + 3] = sx - this._side.x * half
			arr[i * 6 + 4] = sy - this._side.y * half
			arr[i * 6 + 5] = sz - this._side.z * half

			px = sx
			py = sy
			pz = sz
		}
		pos.needsUpdate = true
	}
}
