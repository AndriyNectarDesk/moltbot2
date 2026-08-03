// The lake: water, dock, reeds, and the readable spots that fish gather in.
//
// Same house rules as the rest of the arcade — no image files, no models. The
// sky and the water tint are canvas gradients drawn once at load, everything
// solid is built from primitives, and the water surface is a plane whose
// vertices are displaced by summed sines every frame. Water is the one thing
// that genuinely looks better done procedurally than it would from a texture.

import * as THREE from "three"
import { TAU, clamp, rand, randInt } from "../../shared/util.js"

export const WATER_SIZE = 150
// Water tiles beyond this are wasted verts — the dock only looks one way.
const WATER_SEGS = 48

// Casting is limited to this ring in front of the dock.
export const CAST_MIN = 6
export const CAST_MAX = 34

/**
 * Where the sun is, shared by the light, the glow billboard and the glitter
 * path so all three agree by construction. v1 sat at azimuth ~37 degrees off
 * the casting lane, which put the visible sun outside the camera frustum on a
 * 16:10 screen — a dawn whose light source is never on screen. ~20 degrees
 * keeps it in frame across the aspects the games actually run at.
 */
export const SUN_DIR = [-14, 11, -38]

function makeCanvas(w, h = w) {
	const c = document.createElement("canvas")
	c.width = w
	c.height = h
	return { c, x: c.getContext("2d") }
}

/** Dawn sky: deep blue overhead easing down to pale gold at the waterline. */
function skyTexture() {
	const { c, x } = makeCanvas(16, 256)
	const g = x.createLinearGradient(0, 0, 0, 256)
	g.addColorStop(0.0, "#132a3e")
	g.addColorStop(0.32, "#2b5570")
	g.addColorStop(0.58, "#6d8fa0")
	g.addColorStop(0.78, "#c8b28a")
	g.addColorStop(0.9, "#f0d3a0")
	g.addColorStop(1.0, "#f7e3bd")
	x.fillStyle = g
	x.fillRect(0, 0, 16, 256)
	const t = new THREE.CanvasTexture(c)
	t.colorSpace = THREE.SRGBColorSpace
	return t
}

/** Water tint plus a soft dapple, so the surface isn't a flat colour. */
function waterTexture() {
	const S = 512
	const { c, x } = makeCanvas(S)
	const g = x.createLinearGradient(0, 0, 0, S)
	// More contrast than v1, gained ONLY by lightening the light end — the water
	// is most of the frame and the potato tier has no bloom, so darkening it is
	// the literal CITY LIGHTS failure mode.
	g.addColorStop(0, "#12333f")
	g.addColorStop(0.5, "#1a4854")
	g.addColorStop(1, "#266069")
	x.fillStyle = g
	x.fillRect(0, 0, S, S)
	// Broad blotches read as depth variation once the surface is moving.
	for (let i = 0; i < 90; i++) {
		const r = rand(30, 130)
		x.fillStyle = `rgba(${randInt(30, 70)},${randInt(80, 130)},${randInt(100, 150)},0.05)`
		x.beginPath()
		x.arc(rand(0, S), rand(0, S), r, 0, TAU)
		x.fill()
	}
	// A few warm blotches, so the dawn light reads IN the water and not only
	// above it.
	for (let i = 0; i < 22; i++) {
		x.fillStyle = `rgba(${randInt(190, 230)},${randInt(150, 185)},${randInt(95, 130)},0.035)`
		x.beginPath()
		x.arc(rand(0, S), rand(0, S), rand(40, 110), 0, TAU)
		x.fill()
	}
	const t = new THREE.CanvasTexture(c)
	t.colorSpace = THREE.SRGBColorSpace
	t.wrapS = t.wrapT = THREE.RepeatWrapping
	t.repeat.set(3, 3)
	return t
}

/** A soft radial blob, used for ripple rings and the shimmer school. */
function blobTexture(inner, outer) {
	const S = 128
	const { c, x } = makeCanvas(S)
	const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2)
	g.addColorStop(0, inner)
	g.addColorStop(0.55, outer)
	g.addColorStop(1, "rgba(255,255,255,0)")
	x.fillStyle = g
	x.fillRect(0, 0, S, S)
	const t = new THREE.CanvasTexture(c)
	t.colorSpace = THREE.SRGBColorSpace
	return t
}

/** A hollow ring, for the expanding rings a rising fish leaves. */
function ringTexture() {
	const S = 128
	const { c, x } = makeCanvas(S)
	x.strokeStyle = "rgba(220,240,245,0.9)"
	x.lineWidth = 7
	x.beginPath()
	x.arc(S / 2, S / 2, S / 2 - 10, 0, TAU)
	x.stroke()
	x.strokeStyle = "rgba(220,240,245,0.35)"
	x.lineWidth = 3
	x.beginPath()
	x.arc(S / 2, S / 2, S / 2 - 26, 0, TAU)
	x.stroke()
	const t = new THREE.CanvasTexture(c)
	t.colorSpace = THREE.SRGBColorSpace
	return t
}

// ---------------------------------------------------------------- spots

/**
 * Where the fish are.
 *
 * This is the whole reason casting is a skill rather than a direction. Every
 * spot has a `quality` from 0 to 1 that shortens the wait for a bite and pushes
 * the species roll towards the rare end. Open water still catches fish — it just
 * catches small ones, slowly — so a player who never learns to read the surface
 * still gets a score, and one who does gets a much better one.
 *
 * Two kinds are permanent and two are not, which is the interesting part: the
 * lilies and the dock shadow reward knowing the lake, while the rings and the
 * shimmer school reward watching it right now.
 */
export const SPOT_KINDS = {
	open: { quality: 0, label: "OPEN WATER" },
	shadow: { quality: 0.34, label: "DOCK SHADOW" },
	lily: { quality: 0.55, label: "LILY PADS" },
	ring: { quality: 0.85, label: "RISING FISH" },
	school: { quality: 1, label: "SHIMMER SCHOOL" },
}

export class Lake {
	constructor(scene) {
		this.scene = scene
		this.time = 0

		// permanent spots, filled in by _buildLilies / _buildDock
		this.lilies = []
		this.shadow = null
		// transient spots
		this.rings = []
		this.school = null
		this._nextRing = 1.5
		this._nextSchool = 6

		this._ringTex = ringTexture()
		this._glintTex = blobTexture("rgba(215,240,235,0.85)", "rgba(150,205,200,0.25)")
		this._waterStep = 1
		this._waterOffset = 0

		this._buildSky()
		this._buildSunGlow()
		this._buildWater()
		this._buildGlitter()
		this._buildShore()
		this._buildDock()
		this._buildLilies()
		this._buildReeds()
		this._buildRingPool()
		this._buildSchool()
		this._buildLights()
	}

	// ------------------------------------------------------------ scene build

	_buildSky() {
		const geo = new THREE.SphereGeometry(400, 24, 16)
		const mat = new THREE.MeshBasicMaterial({
			map: skyTexture(),
			side: THREE.BackSide,
			depthWrite: false,
			fog: false,
		})
		this.sky = new THREE.Mesh(geo, mat)
		this.scene.add(this.sky)
	}

	/**
	 * The sun itself, as a soft billboard along the real light direction.
	 *
	 * NOT painted into the sky texture: that texture is a 1D vertical gradient,
	 * and going 2D means aligning an azimuth through sphere UVs and a wrap seam
	 * — exactly the kind of thing that ships wrong invisibly here. A billboard
	 * placed along `sun.position` is aligned by construction, and a test can
	 * project it through the camera and prove it is actually in frame.
	 */
	_buildSunGlow() {
		const dir = new THREE.Vector3(...SUN_DIR).normalize()
		this.sunGlow = new THREE.Mesh(
			new THREE.PlaneGeometry(150, 150),
			new THREE.MeshBasicMaterial({
				map: blobTexture("rgba(255,224,166,0.95)", "rgba(255,190,120,0.30)"),
				transparent: true,
				depthWrite: false,
				fog: false,
				opacity: 0.9,
			}),
		)
		this.sunGlow.position.copy(dir.multiplyScalar(380))
		this.sunGlow.lookAt(0, 2, 0)
		this.scene.add(this.sunGlow)
	}

	/**
	 * The glitter path: the streak of dawn light on the water, pointing at the
	 * sun. Pooled quads riding the same surface the bobber rides.
	 *
	 * Two rules protect the game under it. It lives entirely BEYOND casting
	 * range — the path runs 37..52 out and its jitter is PERPENDICULAR to the
	 * sun line only, which can never bring a glint closer to shore than its
	 * base distance (the first version jittered along both axes, and about one
	 * lake in a hundred spawned a glint on castable water). And it is warm
	 * gold, capped below the shimmer school's 0.7 opacity, so it cannot be
	 * mistaken for the school — the cool cyan thing that is the best water in
	 * the game.
	 *
	 * The 37..52 band is also WHY it reads at all: the far-shore bank is an
	 * opaque box spanning z −49..−75, and a longer path marching to the horizon
	 * has most of its glints depth-tested away behind the bank — ten quads
	 * shipped, two visible. Every distance here keeps the glint in front of it.
	 */
	_buildGlitter() {
		this._glitterTex = blobTexture("rgba(255,216,150,0.8)", "rgba(235,175,110,0.2)")
		this.glitter = new THREE.Group()
		this._glints = []
		const along = Math.hypot(SUN_DIR[0], SUN_DIR[2])
		const dir = { x: SUN_DIR[0] / along, z: SUN_DIR[2] / along }
		const perp = { x: -dir.z, z: dir.x }
		for (let i = 0; i < 10; i++) {
			const d = 37 + i * 1.6
			const side = rand(-2.5, 2.5)
			const m = new THREE.Mesh(
				new THREE.PlaneGeometry(rand(1.4, 3.0), rand(0.4, 0.8)),
				new THREE.MeshBasicMaterial({
					map: this._glitterTex,
					transparent: true,
					depthWrite: false,
					opacity: 0,
				}),
			)
			m.rotation.x = -Math.PI / 2
			m.position.set(dir.x * d + perp.x * side, 0.04, dir.z * d + perp.z * side)
			this.glitter.add(m)
			this._glints.push({ mesh: m, speed: rand(0.6, 1.4), phase: rand(0, TAU) })
		}
		this.scene.add(this.glitter)
	}

	_buildWater() {
		const geo = new THREE.PlaneGeometry(WATER_SIZE, WATER_SIZE, WATER_SEGS, WATER_SEGS)
		geo.rotateX(-Math.PI / 2)
		this.waterGeo = geo
		// Keep the flat positions so displacement is always applied to the
		// original surface rather than compounding on itself.
		this._flat = Float32Array.from(geo.attributes.position.array)

		this.water = new THREE.Mesh(
			geo,
			new THREE.MeshStandardMaterial({
				map: waterTexture(),
				roughness: 0.18,
				metalness: 0.42,
				transparent: true,
				opacity: 0.97,
			}),
		)
		this.water.receiveShadow = true
		this.scene.add(this.water)
	}

	_buildShore() {
		// A far bank with trees, so the horizon isn't an empty seam.
		const bank = new THREE.Mesh(
			new THREE.BoxGeometry(WATER_SIZE, 3, 26),
			new THREE.MeshStandardMaterial({ color: 0x2c3a2a, roughness: 1 }),
		)
		bank.position.set(0, -0.6, -62)
		this.scene.add(bank)

		this.trees = new THREE.Group()
		for (let i = 0; i < 46; i++) {
			const h = rand(4, 11)
			const tree = new THREE.Mesh(
				new THREE.ConeGeometry(rand(1.1, 2.4), h, 6),
				new THREE.MeshStandardMaterial({
					color: new THREE.Color().setHSL(0.29, 0.3, rand(0.1, 0.2)),
					roughness: 1,
					flatShading: true,
				}),
			)
			tree.position.set(rand(-70, 70), 0.4 + h / 2, rand(-74, -54))
			this.trees.add(tree)
		}
		this.scene.add(this.trees)

		// Low mist over the far water — cheap, and it does most of the work of
		// making the lake feel like early morning.
		this.mist = new THREE.Mesh(
			new THREE.PlaneGeometry(WATER_SIZE, 16),
			new THREE.MeshBasicMaterial({
				map: blobTexture("rgba(226,232,226,0.5)", "rgba(226,232,226,0.16)"),
				transparent: true,
				depthWrite: false,
			}),
		)
		this.mist.position.set(0, 2.4, -46)
		this.scene.add(this.mist)

		// A second, lower band drifting on its own phase. Two layers moving at
		// different speeds is what makes mist read as a volume instead of a
		// postcard; it shares the mist quality flag.
		this.mist2 = new THREE.Mesh(
			new THREE.PlaneGeometry(WATER_SIZE, 10),
			new THREE.MeshBasicMaterial({
				map: blobTexture("rgba(232,228,214,0.42)", "rgba(232,228,214,0.12)"),
				transparent: true,
				depthWrite: false,
			}),
		)
		this.mist2.position.set(6, 1.5, -55)
		this.scene.add(this.mist2)
	}

	_buildDock() {
		const wood = new THREE.MeshStandardMaterial({ color: 0x5b4632, roughness: 0.95, flatShading: true })
		const dark = new THREE.MeshStandardMaterial({ color: 0x3d2f21, roughness: 1 })
		this.dock = new THREE.Group()

		// planks running out over the water
		for (let i = 0; i < 9; i++) {
			const plank = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.16, 0.62), wood)
			plank.position.set(0, 0.62, 1.2 - i * 0.72)
			plank.castShadow = true
			this.dock.add(plank)
		}
		// posts
		for (const [px, pz] of [
			[-1.4, 1.0],
			[1.4, 1.0],
			[-1.4, -4.4],
			[1.4, -4.4],
		]) {
			const post = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.19, 2.4, 7), dark)
			post.position.set(px, -0.3, pz)
			post.castShadow = true
			this.dock.add(post)
		}
		// a bucket, purely so the dock looks lived-on
		const bucket = new THREE.Mesh(
			new THREE.CylinderGeometry(0.28, 0.22, 0.4, 10, 1, true),
			new THREE.MeshStandardMaterial({ color: 0x6d7b6a, roughness: 0.8, side: THREE.DoubleSide }),
		)
		bucket.position.set(1.0, 0.9, 0.4)
		this.dock.add(bucket)

		this.scene.add(this.dock)

		// The water right off the end of the dock is shaded and holds fish.
		this.shadow = { kind: "shadow", x: 0, z: -7.5, r: 3.4 }
	}

	_buildLilies() {
		const padMat = new THREE.MeshStandardMaterial({
			color: 0x3f6b48,
			roughness: 0.85,
			flatShading: true,
		})
		const flowerMat = new THREE.MeshStandardMaterial({ color: 0xf0e2c6, roughness: 0.7 })
		this.lilyGroup = new THREE.Group()

		// Three patches, placed inside casting range but off to the sides so they
		// compete with the dock shadow rather than overlapping it.
		const centres = [
			[-13, -16],
			[15, -13],
			[-6, -27],
		]
		for (const [cx, cz] of centres) {
			this.lilies.push({ kind: "lily", x: cx, z: cz, r: 4.6 })
			const n = randInt(7, 11)
			for (let i = 0; i < n; i++) {
				const a = rand(0, TAU)
				const d = rand(0, 4.2)
				const pad = new THREE.Mesh(new THREE.CircleGeometry(rand(0.45, 0.85), 7), padMat)
				pad.rotation.x = -Math.PI / 2
				pad.position.set(cx + Math.cos(a) * d, 0.04, cz + Math.sin(a) * d)
				this.lilyGroup.add(pad)
				if (Math.random() < 0.3) {
					const flower = new THREE.Mesh(new THREE.SphereGeometry(0.16, 6, 5), flowerMat)
					flower.position.set(pad.position.x, 0.12, pad.position.z)
					this.lilyGroup.add(flower)
				}
			}
		}
		this.scene.add(this.lilyGroup)
	}

	_buildReeds() {
		this.reeds = new THREE.Group()
		const mat = new THREE.MeshStandardMaterial({ color: 0x5c6b3c, roughness: 1, flatShading: true })
		for (let i = 0; i < 150; i++) {
			// Shore-hugging: near the banks, away from the casting lane.
            const edge = Math.random() < 0.5 ? -1 : 1
			const x = edge * rand(24, 62)
			const z = rand(-52, 16)
			const h = rand(0.8, 2.2)
			const reed = new THREE.Mesh(new THREE.ConeGeometry(0.05, h, 4), mat)
			reed.position.set(x, h / 2 - 0.1, z)
			reed.rotation.z = rand(-0.22, 0.22)
			this.reeds.add(reed)
		}
		this.scene.add(this.reeds)
	}

	_buildRingPool() {
		// Pre-built so a ring never allocates mid-frame.
		this.ringMeshes = []
		for (let i = 0; i < 8; i++) {
			const m = new THREE.Mesh(
				new THREE.PlaneGeometry(1, 1),
				new THREE.MeshBasicMaterial({
					map: this._ringTex,
					transparent: true,
					depthWrite: false,
					opacity: 0,
				}),
			)
			m.rotation.x = -Math.PI / 2
			m.visible = false
			this.scene.add(m)
			this.ringMeshes.push(m)
		}
	}

	_buildSchool() {
		this.schoolMesh = new THREE.Group()
		for (let i = 0; i < 9; i++) {
			const glint = new THREE.Mesh(
				new THREE.PlaneGeometry(rand(0.5, 1.1), rand(0.3, 0.7)),
				new THREE.MeshBasicMaterial({
					map: this._glintTex,
					transparent: true,
					depthWrite: false,
					opacity: 0.7,
				}),
			)
			glint.rotation.x = -Math.PI / 2
			glint.position.set(rand(-2.4, 2.4), 0.05, rand(-2.4, 2.4))
			this.schoolMesh.add(glint)
		}
		this.schoolMesh.visible = false
		this.scene.add(this.schoolMesh)
	}

	_buildLights() {
		this.scene.add(new THREE.HemisphereLight(0xa9c6d8, 0x24413c, 0.85))
		// Low sun coming across the water, so the wave crests catch light.
		this.sun = new THREE.DirectionalLight(0xffd9a0, 1.5)
		this.sun.position.set(...SUN_DIR)
		this.sun.castShadow = true
		this.sun.shadow.camera.left = -22
		this.sun.shadow.camera.right = 22
		this.sun.shadow.camera.top = 22
		this.sun.shadow.camera.bottom = -22
		this.sun.shadow.camera.far = 90
		this.scene.add(this.sun)
		// Warmer than v1 and slightly LIGHTER (luminance may only go up here —
		// see the CITY LIGHTS note in ARCADE.md), pulled toward the sky's horizon
		// band so the far water dissolves into dawn instead of into grey.
		this.scene.fog = new THREE.Fog(0xd3c8ab, 40, 130)
	}

	// ------------------------------------------------------------ quality

	setShadows(on, size = 1024) {
		this.sun.castShadow = on
		if (on) this.sun.shadow.mapSize.set(size, size)
		this.water.receiveShadow = on
	}

	setDecor(reeds, lilyFlowers, mist, glitter = true) {
		this.reeds.visible = reeds
		this.trees.visible = reeds
		this.lilyGroup.visible = lilyFlowers
		this.mist.visible = mist
		this.mist2.visible = mist
		this.glitter.visible = glitter
	}

	/**
	 * Update one in every `step` water rows per frame.
	 *
	 * Displacing ~2,400 vertices and recomputing their normals every frame is by
	 * far this game's biggest per-frame cost, and on a weak machine it is the
	 * thing that drops the frame rate. Interleaving the rows keeps the whole
	 * surface moving — each row just updates a third as often at step 3 — which
	 * is far less noticeable on gentle water than a lower resolution would be.
	 */
	setWaterStep(step) {
		this._waterStep = Math.max(1, Math.round(step))
		this._waterOffset = 0
	}

	// ------------------------------------------------------------ surface

	/**
	 * Surface height at a point. Three sines at different scales and speeds; the
	 * bobber and the rings both sit on this so everything bobs together.
	 */
	heightAt(x, z, t = this.time) {
		return (
			Math.sin(x * 0.15 + t * 0.9) * 0.09 +
			Math.sin(z * 0.21 - t * 0.7) * 0.07 +
			Math.sin((x + z) * 0.09 + t * 1.35) * 0.05
		)
	}

	_displaceWater() {
		const pos = this.waterGeo.attributes.position
		const arr = pos.array
		const flat = this._flat
		const rowLen = (WATER_SEGS + 1) * 3
		const step = this._waterStep
		// Whole surface at step 1; otherwise a slice of rows, rotating each frame.
		for (let row = this._waterOffset; row <= WATER_SEGS; row += step) {
			const start = row * rowLen
			for (let i = start; i < start + rowLen; i += 3) {
				arr[i + 1] = this.heightAt(flat[i], flat[i + 2])
			}
		}
		this._waterOffset = (this._waterOffset + 1) % step
		pos.needsUpdate = true
		this.waterGeo.computeVertexNormals()
	}

	// ------------------------------------------------------------ spots

	/** Drop a ring at a point — also used when a fish is lost, as a parting swirl. */
	spawnRing(x, z, { transient = false } = {}) {
		const mesh = this.ringMeshes.find((m) => !m.visible)
		if (!mesh) return null
		mesh.visible = true
		mesh.position.set(x, 0.06, z)
		mesh.scale.setScalar(0.6)
		mesh.material.opacity = 0.9
		const ring = {
			kind: "ring",
			x,
			z,
			r: 2.6,
			mesh,
			t: 0,
			// A rising fish is worth watching for a couple of seconds — long
			// enough to aim at deliberately, short enough that it's a decision.
			life: transient ? 1.1 : rand(2.4, 3.4),
			scoring: !transient,
		}
		this.rings.push(ring)
		return ring
	}

	_updateRings(dt) {
		this._nextRing -= dt
		if (this._nextRing <= 0) {
			this._nextRing = rand(1.6, 4.2)
			// Somewhere in the castable ring, biased away from the very edge.
			const a = rand(-1.15, 1.15)
			const d = rand(CAST_MIN + 2, CAST_MAX - 3)
			this.spawnRing(Math.sin(a) * d, -Math.cos(a) * d)
		}

		for (let i = this.rings.length - 1; i >= 0; i--) {
			const r = this.rings[i]
			r.t += dt
			const k = r.t / r.life
			if (k >= 1) {
				r.mesh.visible = false
				r.mesh.material.opacity = 0
				this.rings.splice(i, 1)
				continue
			}
			const s = 1.2 + k * 5.5
			r.mesh.scale.setScalar(s)
			r.mesh.material.opacity = 0.9 * (1 - k) * (1 - k)
			r.mesh.position.y = 0.06 + this.heightAt(r.x, r.z)
		}
	}

	_updateSchool(dt) {
		if (!this.school) {
			this._nextSchool -= dt
			if (this._nextSchool <= 0) {
				// Comes in from one side and drifts across the casting lane.
				const dir = Math.random() < 0.5 ? 1 : -1
				this.school = {
					kind: "school",
					x: dir * 30,
					z: rand(-30, -12),
					r: 3.6,
					vx: -dir * rand(1.6, 2.8),
					life: 18,
					t: 0,
				}
				this.schoolMesh.visible = true
			}
			return
		}

		const s = this.school
		s.t += dt
		s.x += s.vx * dt
		s.z += Math.sin(s.t * 0.6) * 0.6 * dt
		this.schoolMesh.position.set(s.x, 0.05 + this.heightAt(s.x, s.z), s.z)
		// Glints twinkle, which is what makes it catch the eye at a distance.
		for (let i = 0; i < this.schoolMesh.children.length; i++) {
			const g = this.schoolMesh.children[i]
			g.material.opacity = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(s.t * 5 + i * 1.7))
		}
		if (s.t > s.life || Math.abs(s.x) > 34) {
			this.school = null
			this.schoolMesh.visible = false
			this._nextSchool = rand(7, 13)
		}
	}

	/**
	 * The best spot covering a point, and how good it is.
	 *
	 * Highest quality wins rather than stacking, so a ring landing on the lilies
	 * is worth the ring and not both — otherwise the optimal play would be to
	 * wait for overlaps rather than to read the water.
	 */
	spotAt(x, z) {
		let best = { kind: "open", quality: 0, dist: 0 }
		const consider = (spot) => {
			const d = Math.hypot(x - spot.x, z - spot.z)
			if (d > spot.r) return
			if (spot.scoring === false) return
			// Dead centre is worth full value, the rim a little less.
			const falloff = 1 - 0.35 * (d / spot.r)
			const q = SPOT_KINDS[spot.kind].quality * falloff
			if (q > best.quality) best = { kind: spot.kind, quality: q, dist: d }
		}
		if (this.shadow) consider(this.shadow)
		for (const l of this.lilies) consider(l)
		for (const r of this.rings) consider(r)
		if (this.school) consider(this.school)
		return best
	}

	update(dt) {
		this.time += dt
		this._displaceWater()
		this._updateRings(dt)
		this._updateSchool(dt)
		// Slow drift keeps the horizon from looking pinned.
		this.mist.material.opacity = 0.55 + Math.sin(this.time * 0.25) * 0.1
		this.mist2.material.opacity = 0.38 + Math.sin(this.time * 0.17 + 2.1) * 0.09
		this.mist2.position.x = 6 + Math.sin(this.time * 0.05) * 4
		if (this.glitter.visible) {
			for (const g of this._glints) {
				// Capped at 0.55, comfortably under the school's 0.7 — the glitter
				// must never outshine the thing the player is hunting for.
				g.mesh.material.opacity = 0.18 + Math.abs(Math.sin(this.time * g.speed + g.phase)) * 0.37
				g.mesh.position.y = 0.04 + this.heightAt(g.mesh.position.x, g.mesh.position.z)
			}
		}
	}

	/** Between runs: clear the transient spots so a new morning starts clean. */
	reset() {
		for (const r of this.rings) {
			r.mesh.visible = false
			r.mesh.material.opacity = 0
		}
		this.rings.length = 0
		this.school = null
		this.schoolMesh.visible = false
		this._nextRing = 1.2
		this._nextSchool = 5
	}
}
