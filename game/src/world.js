// The arena: a floating neon sky-pad above an endless cloud city.

import * as THREE from "three"
import { clamp, rand, randInt, TAU } from "./util.js"

const ORANGE = 0xff7a1a
const CYAN = 0x31e6ff
const MAGENTA = 0xff2d95
const VIOLET = 0x8a3cff

// ---------------------------------------------------------------- textures
function makeCanvas(size = 512) {
	const c = document.createElement("canvas")
	c.width = c.height = size
	return { c, x: c.getContext("2d") }
}

/** Glowing tech-panel floor with a grid, hazard chevrons and a hero emblem. */
function padTexture() {
	const S = 1024
	const { c, x } = makeCanvas(S)

	x.fillStyle = "#120c22"
	x.fillRect(0, 0, S, S)

	// panel blocks
	for (let i = 0; i < 260; i++) {
		const w = rand(40, 190)
		const h = rand(40, 190)
		x.fillStyle = `rgba(${randInt(24, 52)},${randInt(18, 40)},${randInt(48, 90)},0.75)`
		x.fillRect(Math.floor(rand(0, S - w)), Math.floor(rand(0, S - h)), w, h)
	}

	// grid
	x.strokeStyle = "rgba(49,230,255,0.30)"
	x.lineWidth = 2
	for (let i = 0; i <= 16; i++) {
		const p = (i / 16) * S
		x.beginPath()
		x.moveTo(p, 0)
		x.lineTo(p, S)
		x.moveTo(0, p)
		x.lineTo(S, p)
		x.stroke()
	}
	x.strokeStyle = "rgba(255,122,26,0.5)"
	x.lineWidth = 5
	x.strokeRect(0, 0, S, S)

	// glowing rings around the middle
	x.save()
	x.translate(S / 2, S / 2)
	for (let r = 120; r < 480; r += 90) {
		x.beginPath()
		x.arc(0, 0, r, 0, TAU)
		x.strokeStyle = r % 180 === 30 ? "rgba(255,122,26,0.5)" : "rgba(49,230,255,0.28)"
		x.lineWidth = 3
		x.stroke()
	}

	// hazard chevrons on the outer band
	for (let i = 0; i < 48; i++) {
		const a = (i / 48) * TAU
		x.save()
		x.rotate(a)
		x.fillStyle = i % 2 ? "rgba(255,122,26,0.55)" : "rgba(12,8,22,0.6)"
		x.fillRect(455, -22, 44, 44)
		x.restore()
	}

	// central emblem: a bolt inside a ring
	x.beginPath()
	x.arc(0, 0, 96, 0, TAU)
	x.lineWidth = 10
	x.strokeStyle = "rgba(255,179,71,0.85)"
	x.stroke()
	x.fillStyle = "rgba(255,179,71,0.9)"
	x.beginPath()
	x.moveTo(-22, -66)
	x.lineTo(30, -12)
	x.lineTo(4, -6)
	x.lineTo(26, 66)
	x.lineTo(-30, 6)
	x.lineTo(-2, 0)
	x.closePath()
	x.fill()
	x.restore()

	const tex = new THREE.CanvasTexture(c)
	tex.colorSpace = THREE.SRGBColorSpace
	tex.anisotropy = 8
	return tex
}

/** Emissive mask so the grid + emblem actually glow into the bloom pass. */
function padEmissive() {
	const S = 512
	const { c, x } = makeCanvas(S)
	x.fillStyle = "#000"
	x.fillRect(0, 0, S, S)
	x.strokeStyle = "rgba(30,150,190,0.45)"
	x.lineWidth = 1.2
	for (let i = 0; i <= 16; i++) {
		const p = (i / 16) * S
		x.beginPath()
		x.moveTo(p, 0)
		x.lineTo(p, S)
		x.moveTo(0, p)
		x.lineTo(S, p)
		x.stroke()
	}
	x.save()
	x.translate(S / 2, S / 2)
	x.beginPath()
	x.arc(0, 0, 48, 0, TAU)
	x.lineWidth = 5
	x.strokeStyle = "rgba(220,120,30,0.8)"
	x.stroke()
	x.restore()
	const tex = new THREE.CanvasTexture(c)
	return tex
}

/** Tall building facade with lit windows. */
function facadeTexture() {
	const S = 256
	const { c, x } = makeCanvas(S)
	x.fillStyle = "#07060f"
	x.fillRect(0, 0, S, S)
	for (let ry = 6; ry < S - 6; ry += 14) {
		for (let rx = 8; rx < S - 8; rx += 16) {
			if (Math.random() < 0.42) continue
			const warm = Math.random() < 0.35
			const a = rand(0.25, 1)
			x.fillStyle = warm ? `rgba(255,168,80,${a})` : `rgba(90,200,255,${a})`
			x.fillRect(rx, ry, 9, 7)
		}
	}
	const tex = new THREE.CanvasTexture(c)
	tex.colorSpace = THREE.SRGBColorSpace
	return tex
}

function cloudTexture() {
	const S = 256
	const { c, x } = makeCanvas(S)
	const g = x.createRadialGradient(S / 2, S / 2, 10, S / 2, S / 2, S / 2)
	g.addColorStop(0, "rgba(190,150,255,0.55)")
	g.addColorStop(0.45, "rgba(120,80,200,0.22)")
	g.addColorStop(1, "rgba(80,40,140,0)")
	x.fillStyle = g
	x.fillRect(0, 0, S, S)
	return new THREE.CanvasTexture(c)
}

// ---------------------------------------------------------------- world
export class World {
	constructor(scene) {
		this.scene = scene
		this.colliders = [] // {type:'box'|'cyl', ...}
		this.hitMeshes = [] // things the aim ray can land on
		this.animated = []
		this.radius = 58 // soft arena boundary
		this.padTop = 0 // y of the main landing pad
		this.time = 0
		this.shield = null

		this._buildSky()
		this._buildCity()
		this._buildPad()
		this._buildPlatforms()
		this._buildDecor()
		this._buildLights()
		this._buildShield()
	}

	// -------------------------------------------------- sky
	_buildSky() {
		const geo = new THREE.SphereGeometry(900, 32, 24)
		const mat = new THREE.ShaderMaterial({
			side: THREE.BackSide,
			depthWrite: false,
			uniforms: { uTime: { value: 0 } },
			vertexShader: /* glsl */ `
				varying vec3 vPos;
				void main() {
					vPos = position;
					gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
				}
			`,
			fragmentShader: /* glsl */ `
				varying vec3 vPos;
				uniform float uTime;
				float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
				void main() {
					vec3 d = normalize(vPos);
					float h = d.y * 0.5 + 0.5;
					vec3 top    = vec3(0.020, 0.012, 0.070);
					vec3 mid    = vec3(0.110, 0.030, 0.210);
					vec3 horiz  = vec3(0.400, 0.090, 0.260);
					vec3 low    = vec3(0.045, 0.016, 0.090);
					vec3 col = mix(horiz, mid, smoothstep(0.46, 0.80, h));
					col = mix(col, top, smoothstep(0.70, 1.0, h));
					col = mix(low, col, smoothstep(0.26, 0.50, h));

					// a fat sun glow just above the horizon
					vec3 sunDir = normalize(vec3(0.45, 0.10, -1.0));
					float s = max(dot(d, sunDir), 0.0);
					col += vec3(1.0, 0.52, 0.20) * pow(s, 24.0) * 1.5;
					col += vec3(1.0, 0.34, 0.42) * pow(s, 4.0) * 0.22;

					// stars in the upper hemisphere
					vec2 g = floor(d.xz * 190.0 + d.y * 40.0);
					float st = hash(g);
					float twinkle = 0.6 + 0.4 * sin(uTime * 2.0 + st * 40.0);
					col += vec3(step(0.9975, st) * smoothstep(0.55, 1.0, h) * twinkle);
					gl_FragColor = vec4(col, 1.0);
				}
			`,
		})
		this.sky = new THREE.Mesh(geo, mat)
		this.sky.frustumCulled = false
		this.scene.add(this.sky)
		this.scene.fog = new THREE.FogExp2(0x1a0a2c, 0.0026)
	}

	// -------------------------------------------------- distant city
	_buildCity() {
		const tex = facadeTexture()
		const geo = new THREE.BoxGeometry(1, 1, 1)
		const mat = new THREE.MeshBasicMaterial({ map: tex, fog: true })
		const COUNT = 220
		const mesh = new THREE.InstancedMesh(geo, mat, COUNT)
		const dummy = new THREE.Object3D()
		for (let i = 0; i < COUNT; i++) {
			const a = rand(0, TAU)
			const r = rand(180, 620)
			const h = rand(40, 220) * (1 - (r - 180) / 1100)
			const w = rand(12, 34)
			dummy.position.set(Math.cos(a) * r, -78 - h / 2 + rand(0, 34), Math.sin(a) * r)
			dummy.scale.set(w, h, w)
			dummy.rotation.y = rand(0, TAU)
			dummy.updateMatrix()
			mesh.setMatrixAt(i, dummy.matrix)
		}
		mesh.instanceMatrix.needsUpdate = true
		this.scene.add(mesh)

		// drifting cloud layers
		const ctex = cloudTexture()
		const cmat = new THREE.MeshBasicMaterial({
			map: ctex,
			transparent: true,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
			opacity: 0.55,
		})
		this.clouds = []
		for (let i = 0; i < 22; i++) {
			const s = rand(90, 260)
			const p = new THREE.Mesh(new THREE.PlaneGeometry(s, s), cmat)
			p.rotation.x = -Math.PI / 2
			const a = rand(0, TAU)
			const r = rand(30, 340)
			p.position.set(Math.cos(a) * r, rand(-90, -12), Math.sin(a) * r)
			p.userData.spin = rand(-0.03, 0.03)
			p.userData.drift = rand(0.4, 1.6)
			p.userData.angle = a
			p.userData.radius = r
			this.clouds.push(p)
			this.scene.add(p)
		}
	}

	// -------------------------------------------------- main pad
	_buildPad() {
		const R = 44
		const map = padTexture()
		const emis = padEmissive()
		const mat = new THREE.MeshStandardMaterial({
			map,
			emissiveMap: emis,
			emissive: 0xffffff,
			emissiveIntensity: 0.42,
			roughness: 0.55,
			metalness: 0.35,
		})
		const sideMat = new THREE.MeshStandardMaterial({ color: 0x1a1030, roughness: 0.7, metalness: 0.6 })

		const geo = new THREE.CylinderGeometry(R, R * 0.94, 3, 8, 1)
		const pad = new THREE.Mesh(geo, [sideMat, mat, sideMat])
		pad.position.y = -1.5
		pad.receiveShadow = true
		pad.rotation.y = Math.PI / 8
		this.scene.add(pad)
		this.hitMeshes.push(pad)
		this.colliders.push({ type: "cyl", x: 0, z: 0, r: R * 0.97, top: 0, bottom: -3 })

		// glowing rim strip
		const rim = new THREE.Mesh(
			new THREE.TorusGeometry(R * 0.985, 0.35, 8, 8),
			new THREE.MeshBasicMaterial({ color: ORANGE }),
		)
		rim.rotation.x = Math.PI / 2
		rim.rotation.z = Math.PI / 8
		rim.position.y = 0.1
		this.scene.add(rim)
		this.animated.push({ obj: rim, kind: "pulse", base: 1 })

		// under-glow so the pad reads as levitating
		const glow = new THREE.Mesh(
			new THREE.CircleGeometry(R * 1.25, 32),
			new THREE.MeshBasicMaterial({
				color: VIOLET,
				transparent: true,
				opacity: 0.32,
				blending: THREE.AdditiveBlending,
				depthWrite: false,
				side: THREE.DoubleSide,
			}),
		)
		glow.rotation.x = Math.PI / 2
		glow.position.y = -6
		this.scene.add(glow)

		// thruster cones under the pad
		for (let i = 0; i < 8; i++) {
			const a = (i / 8) * TAU + Math.PI / 8
			const cone = new THREE.Mesh(
				new THREE.ConeGeometry(2.4, 10, 10, 1, true),
				new THREE.MeshBasicMaterial({
					color: CYAN,
					transparent: true,
					opacity: 0.35,
					blending: THREE.AdditiveBlending,
					depthWrite: false,
					side: THREE.DoubleSide,
				}),
			)
			cone.position.set(Math.cos(a) * R * 0.72, -8, Math.sin(a) * R * 0.72)
			cone.rotation.x = Math.PI
			this.scene.add(cone)
			this.animated.push({ obj: cone, kind: "flicker", base: 0.35, phase: i })
		}
	}

	// -------------------------------------------------- raised platforms
	_addBox(x, y, z, sx, sy, sz, mat) {
		const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat)
		m.position.set(x, y - sy / 2, z)
		m.castShadow = true
		m.receiveShadow = true
		this.scene.add(m)
		this.hitMeshes.push(m)
		this.colliders.push({
			type: "box",
			min: { x: x - sx / 2, y: y - sy, z: z - sz / 2 },
			max: { x: x + sx / 2, y, z: z + sz / 2 },
		})
		return m
	}

	_edgeLight(m, y, sx, sz, color) {
		const g = new THREE.Mesh(
			new THREE.BoxGeometry(sx + 0.3, 0.1, sz + 0.3),
			new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(0.6) }),
		)
		g.position.set(m.position.x, y + 0.05, m.position.z)
		this.scene.add(g)
		this.animated.push({ obj: g, kind: "pulse", base: 1, phase: rand(0, 6) })
	}

	_buildPlatforms() {
		const mat = new THREE.MeshStandardMaterial({
			color: 0x241640,
			roughness: 0.45,
			metalness: 0.7,
			emissive: 0x120a24,
		})
		this.platforms = []
		const specs = [
			[26, 7, 26, 13, 1.2, 13],
			[-26, 7, 26, 13, 1.2, 13],
			[26, 7, -26, 13, 1.2, 13],
			[-26, 7, -26, 13, 1.2, 13],
			[0, 14, -33, 15, 1.2, 10],
			[0, 14, 33, 15, 1.2, 10],
			[33, 17.5, 0, 10, 1.2, 15],
			[-33, 17.5, 0, 10, 1.2, 15],
			[0, 22, 0, 9, 1.2, 9],
		]
		for (const [x, y, z, sx, sy, sz] of specs) {
			const m = this._addBox(x, y, z, sx, sy, sz, mat)
			this._edgeLight(m, y, sx, sz, CYAN)
			this.platforms.push({ x, y, z })

			if (x === 0 && z === 0) {
				// the centre spire hovers on a light column — a solid pylon here
				// would sit right in the player's default sightline
				const col = new THREE.Mesh(
					new THREE.CylinderGeometry(1.6, 2.6, y, 12, 1, true),
					new THREE.MeshBasicMaterial({
						color: CYAN,
						transparent: true,
						opacity: 0.1,
						blending: THREE.AdditiveBlending,
						depthWrite: false,
						side: THREE.DoubleSide,
					}),
				)
				col.position.set(x, y / 2 - 1, z)
				this.scene.add(col)
				this.animated.push({ obj: col, kind: "flicker", base: 0.1, phase: 2 })
				continue
			}

			// support pylon down to the pad
			const pyl = new THREE.Mesh(
				new THREE.CylinderGeometry(0.26, 0.5, y, 6),
				new THREE.MeshStandardMaterial({ color: 0x1a1030, metalness: 0.8, roughness: 0.4 }),
			)
			pyl.position.set(x, y / 2 - 1, z)
			pyl.castShadow = true
			this.scene.add(pyl)
		}
	}

	// -------------------------------------------------- decoration
	_buildDecor() {
		// neon arches around the rim
		for (let i = 0; i < 6; i++) {
			const a = (i / 6) * TAU + 0.4
			const arch = new THREE.Mesh(
				new THREE.TorusGeometry(9, 0.4, 8, 28, Math.PI),
				new THREE.MeshBasicMaterial({ color: i % 2 ? MAGENTA : CYAN }),
			)
			arch.position.set(Math.cos(a) * 40, 0, Math.sin(a) * 40)
			arch.rotation.y = -a + Math.PI / 2
			this.scene.add(arch)
			this.animated.push({ obj: arch, kind: "pulse", base: 1, phase: i * 0.8 })
		}

		// slow counter-rotating halo rings above the arena
		this.rings = []
		for (let i = 0; i < 3; i++) {
			const ring = new THREE.Mesh(
				new THREE.TorusGeometry(30 + i * 7, 0.22, 6, 64),
				new THREE.MeshBasicMaterial({
					color: [CYAN, VIOLET, ORANGE][i],
					transparent: true,
					opacity: 0.55,
					blending: THREE.AdditiveBlending,
					depthWrite: false,
				}),
			)
			ring.position.y = 30 + i * 9
			ring.rotation.x = Math.PI / 2 + rand(-0.22, 0.22)
			ring.userData.spin = (i % 2 ? 1 : -1) * rand(0.05, 0.14)
			this.rings.push(ring)
			this.scene.add(ring)
		}

		// antenna spires with blinking beacons
		for (let i = 0; i < 8; i++) {
			const a = (i / 8) * TAU + Math.PI / 8
			const r = 41
			const spire = new THREE.Mesh(
				new THREE.CylinderGeometry(0.12, 0.5, 14, 5),
				new THREE.MeshStandardMaterial({ color: 0x2a1c4a, metalness: 0.9, roughness: 0.3 }),
			)
			spire.position.set(Math.cos(a) * r, 7, Math.sin(a) * r)
			this.scene.add(spire)
			const beacon = new THREE.Mesh(
				new THREE.SphereGeometry(0.4, 8, 8),
				new THREE.MeshBasicMaterial({ color: MAGENTA }),
			)
			beacon.position.set(Math.cos(a) * r, 14.4, Math.sin(a) * r)
			this.scene.add(beacon)
			this.animated.push({ obj: beacon, kind: "blink", phase: i * 0.7 })
		}

		// floating holo-billboards
		const holoMat = new THREE.MeshBasicMaterial({
			color: CYAN,
			transparent: true,
			opacity: 0.16,
			side: THREE.DoubleSide,
			blending: THREE.AdditiveBlending,
			depthWrite: false,
		})
		for (let i = 0; i < 5; i++) {
			const a = rand(0, TAU)
			const b = new THREE.Mesh(new THREE.PlaneGeometry(rand(8, 16), rand(10, 20)), holoMat)
			b.position.set(Math.cos(a) * rand(52, 74), rand(6, 30), Math.sin(a) * rand(52, 74))
			b.lookAt(0, b.position.y, 0)
			this.scene.add(b)
			this.animated.push({ obj: b, kind: "flicker", base: 0.16, phase: i * 1.7 })
		}
	}

	// -------------------------------------------------- containment shield
	_buildShield() {
		const geo = new THREE.CylinderGeometry(this.radius, this.radius, 70, 48, 1, true)
		const mat = new THREE.ShaderMaterial({
			transparent: true,
			side: THREE.DoubleSide,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
			uniforms: { uTime: { value: 0 }, uHit: { value: 0 }, uHitPos: { value: new THREE.Vector3() } },
			vertexShader: /* glsl */ `
				varying vec3 vWorld;
				varying vec2 vUv;
				void main() {
					vUv = uv;
					vec4 wp = modelMatrix * vec4(position, 1.0);
					vWorld = wp.xyz;
					gl_Position = projectionMatrix * viewMatrix * wp;
				}
			`,
			fragmentShader: /* glsl */ `
				varying vec3 vWorld;
				varying vec2 vUv;
				uniform float uTime;
				uniform float uHit;
				uniform vec3 uHitPos;
				void main() {
					float hex = step(0.985, fract(vUv.x * 60.0)) + step(0.985, fract(vUv.y * 18.0 - uTime * 0.15));
					float scan = smoothstep(0.0, 1.0, sin(vWorld.y * 0.6 - uTime * 1.8) * 0.5 + 0.5) * 0.20;
					float d = distance(vWorld, uHitPos);
					float ripple = uHit * exp(-d * 0.16) * (0.55 + 0.45 * sin(d * 1.6 - uTime * 14.0));
					float a = hex * 0.035 + scan * 0.03 + ripple * 0.85;
					a *= smoothstep(-30.0, -6.0, vWorld.y) * smoothstep(34.0, 6.0, vWorld.y);
					vec3 col = mix(vec3(0.19, 0.90, 1.0), vec3(1.0, 0.48, 0.10), clamp(ripple * 1.6, 0.0, 1.0));
					gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
				}
			`,
		})
		this.shield = new THREE.Mesh(geo, mat)
		this.shield.position.y = 12
		this.scene.add(this.shield)
	}

	pingShield(pos) {
		if (!this.shield) return
		this.shield.material.uniforms.uHit.value = 1
		this.shield.material.uniforms.uHitPos.value.copy(pos)
	}

	// -------------------------------------------------- lights
	_buildLights() {
		const hemi = new THREE.HemisphereLight(0xff9ad5, 0x2a1050, 0.55)
		this.scene.add(hemi)

		const key = new THREE.DirectionalLight(0xffd2a8, 1.7)
		key.position.set(38, 60, -46)
		key.castShadow = true
		key.shadow.mapSize.set(2048, 2048)
		const d = 58
		key.shadow.camera.left = -d
		key.shadow.camera.right = d
		key.shadow.camera.top = d
		key.shadow.camera.bottom = -d
		key.shadow.camera.near = 5
		key.shadow.camera.far = 190
		key.shadow.bias = -0.0012
		key.shadow.normalBias = 0.035
		this.scene.add(key)
		this.keyLight = key

		const fill = new THREE.DirectionalLight(0x4fd8ff, 0.6)
		fill.position.set(-46, 26, 40)
		this.scene.add(fill)

		const rim = new THREE.PointLight(MAGENTA, 180, 130, 2)
		rim.position.set(0, 6, -44)
		this.scene.add(rim)
		this.animated.push({ obj: rim, kind: "lightPulse", base: 260 })
	}

	// -------------------------------------------------- collision
	/**
	 * Resolve a sphere against the arena. Mutates `pos` and `vel`.
	 * Returns { grounded, groundY, hitWall }.
	 */
	resolve(pos, vel, radius = 0.55) {
		let grounded = false
		let groundY = -Infinity
		let hitWall = false

		for (const c of this.colliders) {
			if (c.type === "cyl") {
				const dx = pos.x - c.x
				const dz = pos.z - c.z
				const dist = Math.hypot(dx, dz)
				if (dist > c.r + radius) continue
				const feet = pos.y
				if (feet >= c.top - 0.6 && feet <= c.top + Math.max(radius, 1.6) && vel.y <= 0.001) {
					pos.y = c.top
					if (vel.y < 0) vel.y = 0
					grounded = true
					groundY = Math.max(groundY, c.top)
				}
			} else {
				const { min, max } = c
				// horizontal overlap test with a small skin
				if (pos.x < min.x - radius || pos.x > max.x + radius) continue
				if (pos.z < min.z - radius || pos.z > max.z + radius) continue

				const feet = pos.y
				const head = pos.y + 1.7
				if (feet < max.y && head > min.y) {
					// figure out the cheapest way out
					const penTop = max.y - feet
					const penBot = head - min.y
					const penX = vel.x > 0 ? pos.x + radius - min.x : max.x + radius - pos.x
					const penZ = vel.z > 0 ? pos.z + radius - min.z : max.z + radius - pos.z
					const minPen = Math.min(penTop, penBot, penX, penZ)

					if (minPen === penTop && vel.y <= 0.001) {
						pos.y = max.y
						if (vel.y < 0) vel.y = 0
						grounded = true
						groundY = Math.max(groundY, max.y)
					} else if (minPen === penBot && vel.y > 0) {
						pos.y = min.y - 1.7
						vel.y = Math.min(vel.y, 0)
					} else if (minPen === penX) {
						pos.x = vel.x > 0 ? min.x - radius : max.x + radius
						vel.x = 0
						hitWall = true
					} else {
						pos.z = vel.z > 0 ? min.z - radius : max.z + radius
						vel.z = 0
						hitWall = true
					}
				}
			}
		}

		// soft containment field
		const r = Math.hypot(pos.x, pos.z)
		if (r > this.radius - 1) {
			const nx = pos.x / r
			const nz = pos.z / r
			pos.x = nx * (this.radius - 1)
			pos.z = nz * (this.radius - 1)
			const into = vel.x * nx + vel.z * nz
			if (into > 0) {
				vel.x -= into * nx * 1.2
				vel.z -= into * nz * 1.2
			}
			this.pingShield(pos)
			hitWall = true
		}

		return { grounded, groundY, hitWall }
	}

	/**
	 * Highest walkable surface under (x,z) that is not above `below` — so a
	 * character standing on the pad isn't yanked up onto the platform above it.
	 */
	groundAt(x, z, below = Infinity) {
		let best = -Infinity
		const ceiling = below + 0.6
		for (const c of this.colliders) {
			const top = c.type === "cyl" ? c.top : c.max.y
			if (top > ceiling) continue
			if (c.type === "cyl") {
				if (Math.hypot(x - c.x, z - c.z) <= c.r) best = Math.max(best, top)
			} else if (x >= c.min.x && x <= c.max.x && z >= c.min.z && z <= c.max.z) {
				best = Math.max(best, top)
			}
		}
		return best === -Infinity ? -999 : best
	}

	randomSpawn(minR = 16, maxR = 40) {
		const a = rand(0, TAU)
		const r = rand(minR, maxR)
		const x = Math.cos(a) * r
		const z = Math.sin(a) * r
		return new THREE.Vector3(x, this.padTop + 0.1, z)
	}

	update(dt, t) {
		this.time = t
		this.sky.material.uniforms.uTime.value = t
		if (this.shield) {
			const u = this.shield.material.uniforms
			u.uTime.value = t
			u.uHit.value = Math.max(0, u.uHit.value - dt * 1.8)
		}
		for (const ring of this.rings) ring.rotation.z += ring.userData.spin * dt
		for (const c of this.clouds) {
			c.userData.angle += (c.userData.drift * dt) / 60
			c.position.x = Math.cos(c.userData.angle) * c.userData.radius
			c.position.z = Math.sin(c.userData.angle) * c.userData.radius
			c.rotation.z += c.userData.spin * dt
		}
		for (const a of this.animated) {
			const p = a.phase || 0
			if (a.kind === "pulse") {
				const s = 0.78 + 0.22 * Math.sin(t * 2.2 + p)
				a.obj.scale.setScalar(1 + 0.012 * Math.sin(t * 2.2 + p))
				if (a.obj.material.transparent) a.obj.material.opacity = s
			} else if (a.kind === "flicker") {
				a.obj.material.opacity = a.base * (0.55 + 0.45 * Math.abs(Math.sin(t * 3.1 + p) * Math.sin(t * 1.3 + p)))
			} else if (a.kind === "blink") {
				a.obj.visible = Math.sin(t * 3 + p) > 0.2
			} else if (a.kind === "lightPulse") {
				a.obj.intensity = a.base * (0.7 + 0.3 * Math.sin(t * 1.7))
			}
		}
	}

	/** Keep the world lively but cheap while the game is paused/at menu. */
	setQuality(high) {
		if (this.keyLight) this.keyLight.castShadow = high
	}
}

export { ORANGE, CYAN, MAGENTA, VIOLET }
