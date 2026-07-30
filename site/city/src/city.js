// The city: blocks, roads, ramps, stars and the day/night cycle.
//
// Laid out on a regular block grid, which is doing two jobs. It makes the place
// legible to drive — you can always find a road — and it makes the collision
// hash near-perfectly distributed, because the cell size is the block size.
//
// House rules as everywhere else: no art assets. Buildings are boxes with
// canvas-drawn facades, the roads are a canvas texture, and the neon is
// emissive material plus bloom.
//
// One collision box per building, not one per mesh. A building is visually two
// or three boxes stacked; the car only ever needs to know about its footprint,
// and quadrupling the collider count for detail nobody can drive into would be
// a bad trade.

import * as THREE from "three"
import { TAU, clamp, lerp, rand, randInt } from "../../shared/util.js"
import { Grid, box } from "./collide.js"

export const BLOCK = 58
export const ROAD = 16
export const BLOCKS = 7
/** Half-width of the drivable world, including the perimeter wall. */
export const CITY_HALF = (BLOCKS * BLOCK) / 2

const NEON = [0xff3d8b, 0x36c8d8, 0xffc857, 0x8a5cff, 0x4ce0a0]

/**
 * How dark the "night" end of the cycle is allowed to get.
 *
 * Both ends deliberately sit in the lit half. This is a driving game before it is
 * a mood piece: if you cannot see the junction you are about to arrive at, none
 * of the rest of it matters.
 */
const NIGHT_MIN = 0.1
const NIGHT_MAX = 0.62

/**
 * The city is generated from a FIXED seed, so it is the same city every time.
 *
 * This matters more than it looks. Without it every reload rebuilt the whole map
 * — buildings moved, and the stars you had already collected reappeared in
 * streets you had never driven down, because only their indices were saved and
 * not their positions. An open world you are asked to learn and to comb for
 * collectables has to be the same place tomorrow.
 *
 * Change this number and you get a different city; keep it and everyone's saved
 * progress keeps meaning what it meant.
 */
const CITY_SEED = 0x5ec7c1a7

/** Small deterministic PRNG (LCG). Not good randomness, perfectly good layout. */
function makeRng(seed) {
	let s = seed >>> 0
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0
		return s / 4294967296
	}
}

function makeCanvas(w, h = w) {
	const c = document.createElement("canvas")
	c.width = w
	c.height = h
	return { c, x: c.getContext("2d") }
}

/** A facade of lit and unlit windows. Repeats up the building. */
function facadeTexture() {
	const S = 256
	const { c, x } = makeCanvas(S)
	x.fillStyle = "#0f1320"
	x.fillRect(0, 0, S, S)
	const cols = 8
	const rows = 8
	const pad = 6
	const w = (S - pad * (cols + 1)) / cols
	const h = (S - pad * (rows + 1)) / rows
	for (let i = 0; i < cols; i++) {
		for (let j = 0; j < rows; j++) {
			const lit = Math.random() < 0.55
			if (lit) {
				const warm = Math.random() < 0.7
				x.fillStyle = warm
					? `rgba(255,${randInt(190, 225)},${randInt(120, 165)},${rand(0.5, 0.95).toFixed(2)})`
					: `rgba(${randInt(120, 180)},${randInt(220, 250)},255,${rand(0.4, 0.85).toFixed(2)})`
			} else {
				x.fillStyle = `rgba(${randInt(52, 78)},${randInt(58, 88)},${randInt(84, 122)},1)`
			}
			x.fillRect(pad + i * (w + pad), pad + j * (h + pad), w, h)
		}
	}
	const t = new THREE.CanvasTexture(c)
	t.colorSpace = THREE.SRGBColorSpace
	t.wrapS = t.wrapT = THREE.RepeatWrapping
	return t
}

/** Wet asphalt with lane markings. */
function roadTexture() {
	const S = 512
	const { c, x } = makeCanvas(S)
	// Deliberately a mid grey rather than the near-black asphalt this started as.
	// The road is most of the screen in a driving game and it has to read as a
	// surface you can place the car on.
	x.fillStyle = "#3a4050"
	x.fillRect(0, 0, S, S)
	for (let i = 0; i < 500; i++) {
		x.fillStyle = `rgba(${randInt(58, 92)},${randInt(62, 98)},${randInt(74, 116)},0.5)`
		x.fillRect(rand(0, S), rand(0, S), rand(2, 26), rand(2, 26))
	}
	// centre line — bright, because it is the main cue for where the lane is
	x.strokeStyle = "rgba(255,232,160,0.95)"
	x.lineWidth = 6
	x.setLineDash([26, 22])
	x.beginPath()
	x.moveTo(S / 2, 0)
	x.lineTo(S / 2, S)
	x.stroke()
	const t = new THREE.CanvasTexture(c)
	t.colorSpace = THREE.SRGBColorSpace
	t.wrapS = t.wrapT = THREE.RepeatWrapping
	return t
}

function glowTexture(colour) {
	const S = 128
	const { c, x } = makeCanvas(S)
	const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2)
	g.addColorStop(0, colour)
	g.addColorStop(0.4, colour.replace("1)", "0.5)"))
	g.addColorStop(1, "rgba(0,0,0,0)")
	x.fillStyle = g
	x.fillRect(0, 0, S, S)
	const t = new THREE.CanvasTexture(c)
	t.colorSpace = THREE.SRGBColorSpace
	return t
}

/** Centre of block (i, j) in world space. */
export function blockCentre(i, j) {
	const span = BLOCK
	return {
		x: (i - (BLOCKS - 1) / 2) * span,
		z: (j - (BLOCKS - 1) / 2) * span,
	}
}

export class City {
	constructor(scene) {
		this.scene = scene
		this.grid = new Grid(BLOCK)
		this.time = 0
		/** 0 = midday, 1 = deep night. Starts at dusk, which is when neon looks best. */
		this.night = 0.62
		this.stars = []
		this.ramps = []
		/** Street corners, used as delivery pickups and drops. */
		this.spots = []

		// Everything that decides WHERE something is comes from here. The canvas
		// textures still use Math.random, because a differently-speckled window
		// pattern is not something anyone can navigate by.
		const rnd = makeRng(CITY_SEED)
		this._rnd = rnd
		this._rand = (a = 1, b) => (b === undefined ? rnd() * a : a + rnd() * (b - a))
		this._randInt = (a, b) => Math.floor(this._rand(a, b + 1))

		this._facade = facadeTexture()
		this._road = roadTexture()

		this._buildGround()
		this._buildBlocks()
		this._buildPerimeter()
		this._buildRamps()
		this._buildStars()
		this._buildLights()
	}

	// ------------------------------------------------------------ build

	_buildGround() {
		const size = BLOCKS * BLOCK + ROAD * 2
		const road = this._road.clone()
		road.needsUpdate = true
		road.repeat.set(BLOCKS * 2, BLOCKS * 2)
		const ground = new THREE.Mesh(
			new THREE.PlaneGeometry(size, size),
			new THREE.MeshStandardMaterial({ map: road, roughness: 0.55, metalness: 0.3 }),
		)
		ground.rotation.x = -Math.PI / 2
		ground.receiveShadow = true
		this.scene.add(ground)
	}

	_buildBlocks() {
		this.buildings = new THREE.Group()
		this.neonGroup = new THREE.Group()
		const inner = BLOCK - ROAD // buildable footprint per block

		for (let i = 0; i < BLOCKS; i++) {
			for (let j = 0; j < BLOCKS; j++) {
				const c = blockCentre(i, j)
				// Leave the very middle open as a plaza to spawn in and mess about.
				const middle = i === (BLOCKS - 1) / 2 && j === (BLOCKS - 1) / 2
				if (middle) {
					this.spots.push({ x: c.x, z: c.z, label: "CENTRAL PLAZA" })
					continue
				}

				// One or two buildings per block, each with a single collider.
				const split = this._rnd() < 0.45
				const parts = split ? 2 : 1
				for (let p = 0; p < parts; p++) {
					const w = split ? inner * this._rand(0.38, 0.46) : inner * this._rand(0.62, 0.86)
					const d = inner * this._rand(0.62, 0.86)
					const offX = split ? (p === 0 ? -inner * 0.26 : inner * 0.26) : this._rand(-3, 3)
					const offZ = this._rand(-3, 3)
					const h = this._rand(10, 46) * (split ? 0.8 : 1)
					this._building(c.x + offX, c.z + offZ, w, d, h)
				}

				// Corners of every block are useful, findable destinations.
				this.spots.push({
					x: c.x + (BLOCK / 2 - ROAD * 0.42) * (this._rnd() < 0.5 ? 1 : -1),
					z: c.z + (BLOCK / 2 - ROAD * 0.42) * (this._rnd() < 0.5 ? 1 : -1),
					label: `BLOCK ${String.fromCharCode(65 + i)}${j + 1}`,
				})
			}
		}
		this.scene.add(this.buildings, this.neonGroup)
	}

	_building(cx, cz, w, d, h) {
		const tex = this._facade.clone()
		tex.needsUpdate = true
		tex.repeat.set(Math.max(1, Math.round(w / 7)), Math.max(1, Math.round(h / 7)))
		const mat = new THREE.MeshStandardMaterial({
			map: tex,
			color: new THREE.Color().setHSL(this._rand(0.58, 0.72), this._rand(0.15, 0.3), this._rand(0.16, 0.26)),
			roughness: 0.72,
			metalness: 0.18,
		})
		const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
		m.position.set(cx, h / 2, cz)
		m.castShadow = true
		m.receiveShadow = true
		this.buildings.add(m)

		// A setback upper section on the taller ones, for a skyline rather than a
		// row of identical slabs. Visual only — no extra collider.
		if (h > 26 && this._rnd() < 0.7) {
			const top = new THREE.Mesh(
				new THREE.BoxGeometry(w * 0.6, h * this._rand(0.2, 0.42), d * 0.6),
				mat,
			)
			top.position.set(cx, h + top.geometry.parameters.height / 2, cz)
			top.castShadow = true
			this.buildings.add(top)
		}

		// Neon band. This is what makes it read as the same world as the shooter.
		const colour = NEON[this._randInt(0, NEON.length - 1)]
		const band = new THREE.Mesh(
			new THREE.BoxGeometry(w * 1.01, 0.5, d * 1.01),
			new THREE.MeshBasicMaterial({ color: colour }),
		)
		band.position.set(cx, this._rand(4, Math.max(5, h - 3)), cz)
		this.neonGroup.add(band)

		// ONE collider for the whole thing.
		this.grid.insert(box(cx, cz, w, d, { kind: "building" }))
	}

	_buildPerimeter() {
		const half = CITY_HALF + ROAD * 0.5
		const t = 6
		const mat = new THREE.MeshStandardMaterial({ color: 0x1a2030, roughness: 0.9 })
		for (const [cx, cz, sx, sz] of [
			[0, -half, half * 2 + t, t],
			[0, half, half * 2 + t, t],
			[-half, 0, t, half * 2 + t],
			[half, 0, t, half * 2 + t],
		]) {
			const m = new THREE.Mesh(new THREE.BoxGeometry(sx, 5, sz), mat)
			m.position.set(cx, 2.5, cz)
			this.scene.add(m)
			this.grid.insert(box(cx, cz, sx, sz, { kind: "wall" }))
		}
	}

	/**
	 * Ramps.
	 *
	 * Deliberately launch ramps rather than roads onto rooftops. Supporting a car
	 * parked on a roof means solving elevated collision; a ramp only needs a
	 * height function and gravity, and getting air is the more fun half anyway.
	 */
	_buildRamps() {
		const mat = new THREE.MeshStandardMaterial({
			color: 0x2a3348,
			roughness: 0.7,
			metalness: 0.3,
			flatShading: true,
		})
		const lip = new THREE.MeshBasicMaterial({ color: 0xffc857 })
		// ON THE ROADS, at BLOCK/2 offsets — not at block centres, which is where
		// the buildings are. The first version of this put all four ramps inside
		// buildings, where they were both invisible and unreachable.
		//
		// Each one points down the road it sits on, so there is a clear run-up and
		// a clear landing, and the air stars strung off the end land over tarmac.
		const half = BLOCK / 2
		const specs = [
			{ x: half, z: 0, rot: 0, len: 20, h: 5 },
			{ x: -half, z: 0, rot: Math.PI, len: 20, h: 5 },
			{ x: 0, z: half, rot: Math.PI / 2, len: 22, h: 6 },
			{ x: 0, z: -half, rot: -Math.PI / 2, len: 22, h: 6 },
		]
		for (const s of specs) {
			const g = new THREE.Group()
			const width = 11
			// A wedge: a box sheared by moving its top face forward.
			const geo = new THREE.BoxGeometry(width, s.h, s.len)
			const pos = geo.attributes.position
			for (let i = 0; i < pos.count; i++) {
				// Top verts slide to the high end, bottom verts stay put.
				if (pos.getY(i) > 0) pos.setZ(i, -s.len / 2)
			}
			geo.computeVertexNormals()
			const wedge = new THREE.Mesh(geo, mat)
			wedge.position.y = s.h / 2
			wedge.castShadow = true
			g.add(wedge)
			const edge = new THREE.Mesh(new THREE.BoxGeometry(width, 0.3, 0.6), lip)
			edge.position.set(0, s.h, -s.len / 2)
			g.add(edge)
			g.position.set(s.x, 0, s.z)
			g.rotation.y = s.rot
			this.scene.add(g)

			// cos/sin of the ramp's own rotation, for taking a world point into its
			// local frame; dirX/dirZ are the direction it throws you, which is the
			// group's local -Z rotated into world space.
			this.ramps.push({
				x: s.x,
				z: s.z,
				rot: s.rot,
				len: s.len,
				width,
				h: s.h,
				cos: Math.cos(s.rot),
				sin: Math.sin(s.rot),
				dirX: -Math.sin(s.rot),
				dirZ: -Math.cos(s.rot),
			})
		}
	}

	_buildStars() {
		this.starGroup = new THREE.Group()
		const tex = glowTexture("rgba(255,225,130,1)")
		const geo = new THREE.PlaneGeometry(2.6, 2.6)
		const core = new THREE.SphereGeometry(0.42, 8, 6)
		const coreMat = new THREE.MeshBasicMaterial({ color: 0xfff0b8 })

		const place = (x, z, y) => {
			const g = new THREE.Group()
			const halo = new THREE.Mesh(
				geo,
				new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
			)
			g.add(halo, new THREE.Mesh(core, coreMat))
			g.position.set(x, y, z)
			this.starGroup.add(g)
			this.stars.push({ x, z, y, mesh: g, taken: false, air: y > 3 })
		}

		// Along the roads between blocks: findable just by driving around.
		for (let i = 0; i < BLOCKS; i++) {
			for (let j = 0; j < BLOCKS; j++) {
				if ((i + j) % 2) continue
				const c = blockCentre(i, j)
				place(c.x + BLOCK / 2, c.z + this._rand(-BLOCK * 0.3, BLOCK * 0.3), 1.5)
			}
		}
		// Tucked into the alleys between split buildings.
		for (let k = 0; k < 14; k++) {
			const i = this._randInt(0, BLOCKS - 1)
			const j = this._randInt(0, BLOCKS - 1)
			const c = blockCentre(i, j)
			place(c.x + this._rand(-4, 4), c.z + (BLOCK / 2 - ROAD * 0.5) * (this._rnd() < 0.5 ? 1 : -1), 1.5)
		}
		// In the air off the end of each ramp — these need a proper run-up.
		for (const r of this.ramps) {
			for (let k = 1; k <= 3; k++) {
				const dist = r.len / 2 + 7 * k
				place(r.x + r.dirX * dist, r.z + r.dirZ * dist, r.h + 1.6 + k * 0.9)
			}
		}
		this.scene.add(this.starGroup)
	}

	_buildLights() {
		// A generous ambient floor. Shadowed sides of buildings and the far end of
		// a street still have to be legible, and one directional light plus a hemi
		// leaves them pitch black without this.
		this.scene.add(new THREE.AmbientLight(0x7d90bb, 1.15))
		this.hemi = new THREE.HemisphereLight(0xbcd4f2, 0x4a4060, 1.05)
		this.scene.add(this.hemi)
		this.sun = new THREE.DirectionalLight(0xffd2a8, 1.8)
		this.sun.position.set(70, 90, 40)
		this.sun.castShadow = true
		const d = CITY_HALF * 0.8
		this.sun.shadow.camera.left = -d
		this.sun.shadow.camera.right = d
		this.sun.shadow.camera.top = d
		this.sun.shadow.camera.bottom = -d
		this.sun.shadow.camera.far = 400
		this.scene.add(this.sun)

		// Street lamps at the intersections. Emissive heads only — real point
		// lights at every corner would be far too many for the frame budget.
		this.lampGroup = new THREE.Group()
		const post = new THREE.MeshStandardMaterial({ color: 0x1b2231, roughness: 0.9 })
		const head = new THREE.MeshBasicMaterial({ color: 0xffdca8 })
		for (let i = 0; i <= BLOCKS; i++) {
			for (let j = 0; j <= BLOCKS; j++) {
				const x = (i - BLOCKS / 2) * BLOCK
				const z = (j - BLOCKS / 2) * BLOCK
				const g = new THREE.Group()
				const p = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 7, 6), post)
				p.position.y = 3.5
				const hd = new THREE.Mesh(new THREE.SphereGeometry(0.42, 8, 6), head)
				hd.position.y = 7.1
				g.add(p, hd)
				g.position.set(x, 0, z)
				this.lampGroup.add(g)
			}
		}
		this.scene.add(this.lampGroup)

		this.scene.fog = new THREE.Fog(0x39415c, BLOCK * 3.4, BLOCK * 9)
	}

	// ------------------------------------------------------------ queries

	/**
	 * Ground height at a point — flat everywhere except on a ramp.
	 *
	 * Ramps are the only vertical geometry the car can be supported by, which is
	 * what keeps this a function rather than a physics problem.
	 */
	groundAt(x, z) {
		for (const r of this.ramps) {
			// Into the ramp's local frame.
			const dx = x - r.x
			const dz = z - r.z
			const lx = dx * r.cos - dz * r.sin
			const lz = dx * r.sin + dz * r.cos
			if (Math.abs(lx) > r.width / 2 || Math.abs(lz) > r.len / 2) continue
			// lz runs -len/2 (high, the lip) to +len/2 (low, the approach).
			const t = clamp((r.len / 2 - lz) / r.len, 0, 1)
			return r.h * t
		}
		return 0
	}

	/** Nearest street spot to a point, for placing deliveries sensibly. */
	nearestSpot(x, z) {
		let best = this.spots[0]
		let bd = Infinity
		for (const s of this.spots) {
			const d = (s.x - x) ** 2 + (s.z - z) ** 2
			if (d < bd) {
				bd = d
				best = s
			}
		}
		return best
	}

	/** Collect any star the car is touching. Returns how many were taken. */
	collectStars(x, y, z, radius = 3.4) {
		let got = 0
		for (const s of this.stars) {
			if (s.taken) continue
			const dy = Math.abs(s.y - y)
			if (dy > 3.2) continue
			if ((s.x - x) ** 2 + (s.z - z) ** 2 > radius * radius) continue
			s.taken = true
			s.mesh.visible = false
			got++
		}
		return got
	}

	/** Mark a set of star indices as already collected, from saved progress. */
	restoreStars(takenIndices) {
		const taken = new Set(takenIndices)
		this.stars.forEach((s, i) => {
			s.taken = taken.has(i)
			s.mesh.visible = !s.taken
		})
	}

	get starsTaken() {
		return this.stars.reduce((n, s) => n + (s.taken ? 1 : 0), 0)
	}

	takenIndices() {
		const out = []
		this.stars.forEach((s, i) => s.taken && out.push(i))
		return out
	}

	// ------------------------------------------------------------ quality

	setShadows(on, size = 1024) {
		this.sun.castShadow = on
		if (on) this.sun.shadow.mapSize.set(size, size)
	}

	setDecor(lamps, neon) {
		this._lampsAllowed = lamps
		this.lampGroup.visible = lamps
		this.neonGroup.visible = neon
		// Stars are never touched here — they're gameplay, not decoration.
	}

	// ------------------------------------------------------------ per frame

	update(dt) {
		this.time += dt
		// A slow drift from late afternoon to early evening and back — a mood, not
		// a light switch.
		//
		// The first version ran the full 0..1 and started at 0.87, i.e. the middle
		// of the night with the sun at 17%: the roads were invisible and the game
		// was unplayable from the first frame. A driving game has to let you see
		// the road, so the cycle now lives entirely in the lit half and every light
		// has a floor well above black. You still get gold-hour and blue-hour, the
		// neon still reads, and it is never dark enough to lose a junction in.
		const cycle = 0.5 - 0.5 * Math.cos((this.time / 300) * TAU + Math.PI * 0.55)
		this.night = lerp(NIGHT_MIN, NIGHT_MAX, cycle)

		const n = this.night
		this.sun.intensity = lerp(2.1, 0.95, n)
		this.sun.color.setHSL(lerp(0.09, 0.58, n), lerp(0.5, 0.42, n), lerp(0.66, 0.58, n))
		this.hemi.intensity = lerp(1.15, 0.85, n)
		this.hemi.color.setHSL(lerp(0.55, 0.62, n), 0.38, lerp(0.68, 0.46, n))
		this.scene.fog.color.setHSL(lerp(0.57, 0.65, n), lerp(0.24, 0.4, n), lerp(0.58, 0.3, n))
		// The lamps and neon only really earn their keep after dark.
		if (this._lampsAllowed !== false) this.lampGroup.visible = n > 0.28
		const spin = this.time * 1.6
		for (const s of this.stars) {
			if (s.taken) continue
			s.mesh.rotation.y = spin
			s.mesh.position.y = s.y + Math.sin(this.time * 2.4 + s.x * 0.1) * 0.16
		}
	}

	/** Sky colour for the renderer's clear colour. */
	skyColour(target) {
		return target.setHSL(
			lerp(0.57, 0.65, this.night),
			lerp(0.42, 0.55, this.night),
			// Floored well above black: the sky is the backdrop the skyline reads
			// against, and a black sky behind dark buildings is just a black screen.
			lerp(0.62, 0.26, this.night),
		)
	}
}

