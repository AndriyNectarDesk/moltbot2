// Small math / helper grab-bag shared across the game modules.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
export const lerp = (a, b, t) => a + (b - a) * t
export const rand = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a))
export const randInt = (a, b) => Math.floor(rand(a, b + 1))
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
export const TAU = Math.PI * 2

/** Frame-rate independent exponential smoothing towards `target`. */
export const damp = (current, target, smoothing, dt) =>
	lerp(current, target, 1 - Math.pow(smoothing, dt))

/** Shortest signed angular delta from a to b, in radians. */
export function angleDelta(a, b) {
	let d = (b - a) % TAU
	if (d > Math.PI) d -= TAU
	if (d < -Math.PI) d += TAU
	return d
}

export const smoothstep = (t) => t * t * (3 - 2 * t)
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3)

/** Axis-aligned box helper used for the arena geometry + hero collision. */
export class Box {
	constructor(cx, cy, cz, sx, sy, sz) {
		this.min = { x: cx - sx / 2, y: cy - sy / 2, z: cz - sz / 2 }
		this.max = { x: cx + sx / 2, y: cy + sy / 2, z: cz + sz / 2 }
	}

	containsXZ(x, z, pad = 0) {
		return (
			x >= this.min.x - pad && x <= this.max.x + pad && z >= this.min.z - pad && z <= this.max.z + pad
		)
	}
}

/** Simple recycling pool so we never allocate during the frame loop. */
export class Pool {
	constructor(factory, size) {
		this.items = []
		for (let i = 0; i < size; i++) {
			const item = factory(i)
			item.alive = false
			this.items.push(item)
		}
	}

	acquire() {
		for (let i = 0; i < this.items.length; i++) {
			if (!this.items[i].alive) {
				this.items[i].alive = true
				return this.items[i]
			}
		}
		return null
	}

	forEachAlive(fn) {
		for (let i = 0; i < this.items.length; i++) {
			if (this.items[i].alive) fn(this.items[i], i)
		}
	}

	releaseAll() {
		for (const it of this.items) it.alive = false
	}
}
