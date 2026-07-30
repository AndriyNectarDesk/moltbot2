// The broadphase and the collision resolve.
//
// The grid exists purely as an optimisation, which makes it exactly the kind of
// code that can be silently wrong: a query that misses a box doesn't crash, it
// just lets the car through a wall occasionally. So every query is checked
// against a brute-force scan over the same boxes — if the two ever disagree, the
// grid is wrong, and that is the only assertion that really matters here.

import { describe, expect, it } from "vitest"
import { Grid, box, resolveCircle } from "./collide.js"

/** The thing the grid is supposed to be a fast version of. */
function bruteForce(boxes, minX, minZ, maxX, maxZ) {
	return boxes.filter((b) => b.maxX >= minX && b.minX <= maxX && b.maxZ >= minZ && b.minZ <= maxZ)
}

/**
 * Buildings laid out the way the real city lays them out: one box per block, on a
 * grid, never overlapping each other.
 *
 * This is the fixture the separation guarantee is stated against. `cityish` below
 * scatters boxes at random and they pile into solid clumps several deep, which no
 * single-shot resolver can push a circle out of and which the actual game never
 * produces — using it to test separation would be testing something the code
 * doesn't claim.
 */
function gridCity(blocks = 8, block = 40, size = 26) {
	const g = new Grid(block)
	let id = 0
	for (let i = 0; i < blocks; i++) {
		for (let j = 0; j < blocks; j++) {
			g.insert(box((i - blocks / 2) * block, (j - blocks / 2) * block, size, size, { id: id++ }))
		}
	}
	return g
}

/** A deliberately nasty random spread, for robustness rather than separation. */
function cityish(n = 600, spread = 600) {
	const g = new Grid(24)
	// Deterministic, so a failure is reproducible.
	let seed = 12345
	const rnd = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff
		return seed / 0x7fffffff
	}
	for (let i = 0; i < n; i++) {
		g.insert(
			box(
				(rnd() - 0.5) * spread,
				(rnd() - 0.5) * spread,
				6 + rnd() * 16,
				6 + rnd() * 16,
				{ id: i },
			),
		)
	}
	return { g, rnd }
}

describe("the grid agrees with a brute-force scan", () => {
	// A spatial hash is deliberately conservative: it returns everything in the
	// overlapping CELLS, which is a superset of what actually overlaps the query
	// rectangle. Extra candidates are harmless — the exact test happens in
	// resolveCircle. A MISSING candidate is the bug that matters, because it
	// doesn't crash, it just lets the car through a wall now and then.
	it("never misses a box that brute force finds", () => {
		const { g, rnd } = cityish()
		for (let i = 0; i < 400; i++) {
			const x = (rnd() - 0.5) * 700
			const z = (rnd() - 0.5) * 700
			const r = 1 + rnd() * 30
			const got = new Set(g.queryCircle(x, z, r).map((b) => b.id))
			const want = bruteForce(g.boxes, x - r, z - r, x + r, z + r).map((b) => b.id)
			for (const id of want) {
				expect(got.has(id), `query (${x.toFixed(1)},${z.toFixed(1)} r${r.toFixed(1)}) missed box ${id}`).toBe(
					true,
				)
			}
		}
	})

	it("never returns the same box twice, even spanning many cells", () => {
		const g = new Grid(10)
		// A box far wider than one cell, so it lands in a lot of them.
		g.insert(box(0, 0, 95, 95, { id: 1 }))
		const got = g.queryCircle(0, 0, 60)
		expect(got).toHaveLength(1)
	})

	it("finds a box much larger than the cell size", () => {
		const g = new Grid(8)
		g.insert(box(0, 0, 200, 200, { id: 1 }))
		// Query a corner far from the box centre.
		expect(g.queryCircle(90, 90, 2).map((b) => b.id)).toEqual([1])
	})

	it("works across the origin, where cell indices go negative", () => {
		const g = new Grid(16)
		g.insert(box(-40, -40, 8, 8, { id: 1 }))
		g.insert(box(40, 40, 8, 8, { id: 2 }))
		expect(g.queryCircle(-40, -40, 3).map((b) => b.id)).toEqual([1])
		expect(g.queryCircle(40, 40, 3).map((b) => b.id)).toEqual([2])
		expect(g.queryCircle(0, 0, 3)).toEqual([])
	})

	it("returns nothing in empty space", () => {
		const { g } = cityish(50, 200)
		expect(g.queryCircle(5000, 5000, 10)).toEqual([])
	})
})

describe("the grid is actually an optimisation", () => {
	it("looks at a small fraction of a city's colliders", () => {
		const { g, rnd } = cityish(600, 600)
		let total = 0
		const N = 300
		for (let i = 0; i < N; i++) {
			total += g.queryCircle((rnd() - 0.5) * 600, (rnd() - 0.5) * 600, 3).length
		}
		const avg = total / N
		// The whole point: a car-sized query should consider a handful of boxes,
		// not all 600. Anything above a few dozen means the cell size is wrong.
		expect(avg).toBeLessThan(12)
	})

	it("allocates nothing per query", () => {
		const { g } = cityish(200, 300)
		const a = g.queryCircle(0, 0, 20)
		const b = g.queryCircle(10, 10, 20)
		// Same backing array reused, which is why callers must not hold onto it.
		expect(a).toBe(b)
	})
})

describe("pushing a circle out of walls", () => {
	const g = new Grid(20)
	// A 10x10 building centred on the origin.
	g.insert(box(0, 0, 10, 10, { id: "b" }))

	it("leaves a circle in open space alone", () => {
		const r = resolveCircle(g, 40, 40, 2)
		expect(r.hit).toBe(false)
		expect(r.x).toBe(40)
		expect(r.z).toBe(40)
	})

	it("pushes out through the nearest face", () => {
		// Just inside the +X face.
		const r = resolveCircle(g, 4, 0, 2)
		expect(r.hit).toBe(true)
		expect(r.x).toBeCloseTo(7, 5) // maxX 5 + radius 2
		expect(r.nx).toBeCloseTo(1, 5)
		expect(r.nz).toBeCloseTo(0, 5)
	})

	it("pushes out of a face it is only overlapping", () => {
		// Centre outside the box, circle overlapping the +Z face.
		const r = resolveCircle(g, 0, 6, 2)
		expect(r.hit).toBe(true)
		expect(r.z).toBeCloseTo(7, 5)
		expect(r.nz).toBeCloseTo(1, 5)
	})

	it("gives a diagonal normal at a corner", () => {
		const r = resolveCircle(g, 6, 6, 2)
		expect(r.hit).toBe(true)
		expect(r.nx).toBeGreaterThan(0.5)
		expect(r.nz).toBeGreaterThan(0.5)
		// And it ends up outside.
		expect(Math.hypot(r.x - 5, r.z - 5)).toBeGreaterThanOrEqual(2 - 1e-6)
	})

	it("resolves a circle wedged between two buildings", () => {
		const alley = new Grid(20)
		alley.insert(box(-6, 0, 8, 40))
		alley.insert(box(6, 0, 8, 40))
		// The gap is 4 wide; a radius-3 circle cannot fit, but it must not end up
		// inside either wall or produce NaN.
		const r = resolveCircle(alley, 0, 0, 3)
		expect(r.hit).toBe(true)
		expect(Number.isFinite(r.x)).toBe(true)
		expect(Number.isFinite(r.z)).toBe(true)
	})

	// This used to assert `Math.hypot(...) > -1`, which is unconditionally true —
	// the most important invariant in the file was being "checked" by proving that
	// zero is greater than minus one, five hundred times.
	it("never leaves the circle inside a building, on a city-shaped layout", () => {
		const city = gridCity()
		const RADIUS = 2.3 // the car's
		let checked = 0
		let seed = 99
		const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff)
		// Violations are collected and asserted once at the end rather than
		// expect()-ing inside the inner loop. Two thousand samples against sixty-four
		// boxes is ~128,000 assertions, which took over five seconds and tripped
		// vitest's default timeout the moment the machine was busy — a test that
		// fails depending on how loaded the CI runner is might as well not exist.
		const bad = []
		for (let i = 0; i < 2000; i++) {
			const x = (rnd() - 0.5) * 320
			const z = (rnd() - 0.5) * 320
			const r = resolveCircle(city, x, z, RADIUS)
			if (!Number.isFinite(r.x) || !Number.isFinite(r.z)) {
				bad.push(`non-finite result from ${x.toFixed(1)},${z.toFixed(1)}`)
				continue
			}
			if (!r.hit) continue
			checked++
			for (const b of city.boxes) {
				if (r.x > b.minX && r.x < b.maxX && r.z > b.minZ && r.z < b.maxZ) {
					bad.push(`centre inside box ${b.id} at ${r.x.toFixed(2)},${r.z.toFixed(2)}`)
					break
				}
				const cx = Math.max(b.minX, Math.min(r.x, b.maxX))
				const cz = Math.max(b.minZ, Math.min(r.z, b.maxZ))
				if (Math.hypot(r.x - cx, r.z - cz) < RADIUS - 1e-6) {
					bad.push(`overlapping box ${b.id} at ${r.x.toFixed(2)},${r.z.toFixed(2)}`)
					break
				}
			}
		}
		expect(bad.slice(0, 5)).toEqual([])
		// And the sweep has to have actually hit something to mean anything.
		expect(checked).toBeGreaterThan(100)
	})

	it("stays finite even on a pathological pile of overlapping boxes", () => {
		// No separation promise here — a circle buried several boxes deep can't be
		// pushed clear in a bounded number of passes, and the city never builds
		// anything like this. What must hold is that it never returns nonsense.
		const { g: city, rnd } = cityish(300, 400)
		for (let i = 0; i < 500; i++) {
			const r = resolveCircle(city, (rnd() - 0.5) * 400, (rnd() - 0.5) * 400, 2.2)
			expect(Number.isFinite(r.x) && Number.isFinite(r.z)).toBe(true)
			if (r.hit) expect(Math.hypot(r.nx, r.nz)).toBeGreaterThan(0.5)
		}
	})

	it("still reports a usable normal when squeezed from both sides", () => {
		const alley = new Grid(20)
		alley.insert(box(-6, 0, 8, 40))
		alley.insert(box(6, 0, 8, 40))
		// Dead centre of a gap too narrow for the circle: the two pushes cancel.
		const r = resolveCircle(alley, 0, 0, 3)
		expect(r.hit).toBe(true)
		// A zero normal here meant bounce() did nothing and the car sailed through
		// a gap narrower than itself, with no impact and no crash penalty.
		expect(Math.hypot(r.nx, r.nz)).toBeGreaterThan(0.5)
	})

	it("reports a unit normal", () => {
		const r = resolveCircle(g, 4.5, 4.5, 2)
		expect(Math.hypot(r.nx, r.nz)).toBeCloseTo(1, 5)
	})
})
