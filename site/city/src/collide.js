// Spatial hash + circle-vs-boxes collision.
//
// Nova's `World.resolve` tests the player against every collider in the scene
// every frame. That is completely fine for an arena with a few dozen boxes and
// fatal here: a city block grid is on the order of 600 colliders, and this game
// also has to move a car at 30 m/s, so a linear scan would be the single
// biggest cost in the frame on exactly the hardware that already forced the
// adaptive quality work.
//
// A uniform grid is the right structure rather than a BVH or an octree, for a
// specific reason: the geometry is static and already laid out on a block grid,
// so a hash keyed on that grid is near-perfectly distributed. It's about sixty
// lines against several hundred, and the query is arithmetic instead of a tree
// walk. Anything cleverer here would be worse.
//
// No three.js, so it can be tested against a brute-force reference.

/** An axis-aligned box in the XZ plane. Height is irrelevant — the car is on the ground. */
export function box(cx, cz, sx, sz, extra = {}) {
	return {
		minX: cx - sx / 2,
		maxX: cx + sx / 2,
		minZ: cz - sz / 2,
		maxZ: cz + sz / 2,
		...extra,
	}
}

export class Grid {
	constructor(cellSize = 24) {
		this.cellSize = cellSize
		this.cells = new Map()
		this.boxes = []
		// Visit stamp instead of a Set, so a query allocates nothing.
		this._stamp = 0
		this._out = []
	}

	_key(cx, cz) {
		return cx * 73856093 ^ (cz * 19349663)
	}

	insert(b) {
		this.boxes.push(b)
		const cs = this.cellSize
		const x0 = Math.floor(b.minX / cs)
		const x1 = Math.floor(b.maxX / cs)
		const z0 = Math.floor(b.minZ / cs)
		const z1 = Math.floor(b.maxZ / cs)
		for (let cx = x0; cx <= x1; cx++) {
			for (let cz = z0; cz <= z1; cz++) {
				const k = this._key(cx, cz)
				let list = this.cells.get(k)
				if (!list) {
					list = []
					this.cells.set(k, list)
				}
				list.push(b)
			}
		}
		return b
	}

	clear() {
		this.cells.clear()
		this.boxes.length = 0
	}

	/**
	 * Every box whose cell overlaps the given rectangle, each exactly once.
	 *
	 * Returns a reused array — copy it if you need to keep it.
	 */
	query(minX, minZ, maxX, maxZ) {
		const out = this._out
		out.length = 0
		const stamp = ++this._stamp
		const cs = this.cellSize
		const x0 = Math.floor(minX / cs)
		const x1 = Math.floor(maxX / cs)
		const z0 = Math.floor(minZ / cs)
		const z1 = Math.floor(maxZ / cs)
		for (let cx = x0; cx <= x1; cx++) {
			for (let cz = z0; cz <= z1; cz++) {
				const list = this.cells.get(this._key(cx, cz))
				if (!list) continue
				for (let i = 0; i < list.length; i++) {
					const b = list[i]
					if (b._stamp !== stamp) {
						b._stamp = stamp
						out.push(b)
					}
				}
			}
		}
		return out
	}

	queryCircle(x, z, r) {
		return this.query(x - r, z - r, x + r, z + r)
	}
}

/**
 * Push a circle out of any boxes it overlaps.
 *
 * Resolves along the axis of least penetration, which for axis-aligned boxes
 * gives the wall you actually drove into rather than the nearest corner. The
 * accumulated normal is what the car bounces off.
 *
 * Mutates and returns `result` so the caller can keep it as a scratch object.
 */
export function resolveCircle(grid, x, z, r, result = {}) {
	result.x = x
	result.z = z
	result.nx = 0
	result.nz = 0
	result.hit = false
	result.depth = 0

	const candidates = grid.queryCircle(x, z, r)
	for (let i = 0; i < candidates.length; i++) {
		const b = candidates[i]
		// Closest point on the box to the circle centre.
		const cx = result.x < b.minX ? b.minX : result.x > b.maxX ? b.maxX : result.x
		const cz = result.z < b.minZ ? b.minZ : result.z > b.maxZ ? b.maxZ : result.z
		const dx = result.x - cx
		const dz = result.z - cz
		const d2 = dx * dx + dz * dz

		if (d2 > r * r) continue

		if (d2 > 1e-9) {
			// Outside the box, overlapping the edge or corner.
			const d = Math.sqrt(d2)
			const push = r - d
			const nx = dx / d
			const nz = dz / d
			result.x += nx * push
			result.z += nz * push
			result.nx += nx
			result.nz += nz
			result.depth = Math.max(result.depth, push)
		} else {
			// Centre is inside the box — pick the nearest face and leave by it.
			const left = result.x - b.minX
			const right = b.maxX - result.x
			const back = result.z - b.minZ
			const front = b.maxZ - result.z
			const min = Math.min(left, right, back, front)
			if (min === left) {
				result.x = b.minX - r
				result.nx -= 1
			} else if (min === right) {
				result.x = b.maxX + r
				result.nx += 1
			} else if (min === back) {
				result.z = b.minZ - r
				result.nz -= 1
			} else {
				result.z = b.maxZ + r
				result.nz += 1
			}
			result.depth = Math.max(result.depth, min + r)
		}
		result.hit = true
	}

	if (result.hit) {
		const len = Math.hypot(result.nx, result.nz)
		if (len > 1e-9) {
			result.nx /= len
			result.nz /= len
		}
	}
	return result
}
