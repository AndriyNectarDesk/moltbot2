// GPU-friendly effects: one big additive point cloud for sparks/smoke, plus a
// small pool of expanding rings, shockwaves and beams.

import * as THREE from "three"
import { clamp, rand, TAU } from "./util.js"

const MAX_PARTICLES = 2000

export class FX {
	constructor(scene) {
		this.scene = scene
		this.time = 0
		this.scale = 1 // particle-count multiplier, set by the quality tier
		this._v = new THREE.Vector3()
		this._buildParticles()
		this._buildRings()
		this._buildBeams()
	}

	// ------------------------------------------------------------ particles
	_buildParticles() {
		const n = MAX_PARTICLES
		this.p = {
			pos: new Float32Array(n * 3),
			vel: new Float32Array(n * 3),
			col: new Float32Array(n * 3),
			size: new Float32Array(n),
			life: new Float32Array(n),
			maxLife: new Float32Array(n),
			grav: new Float32Array(n),
			drag: new Float32Array(n),
			cursor: 0,
			n,
		}

		const geo = new THREE.BufferGeometry()
		geo.setAttribute("position", new THREE.BufferAttribute(this.p.pos, 3))
		geo.setAttribute("color", new THREE.BufferAttribute(this.p.col, 3))
		geo.setAttribute("aSize", new THREE.BufferAttribute(this.p.size, 1))
		geo.setAttribute("aLife", new THREE.BufferAttribute(this.p.life, 1))
		geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)

		const mat = new THREE.ShaderMaterial({
			transparent: true,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
			uniforms: { uPixel: { value: window.devicePixelRatio || 1 } },
			vertexShader: /* glsl */ `
				attribute float aSize;
				attribute float aLife;
				varying vec3 vColor;
				varying float vLife;
				uniform float uPixel;
				void main() {
					vColor = color;
					vLife = aLife;
					vec4 mv = modelViewMatrix * vec4(position, 1.0);
					gl_PointSize = aSize * uPixel * 260.0 / max(-mv.z, 0.1) * (0.35 + 0.65 * aLife);
					gl_Position = projectionMatrix * mv;
				}
			`,
			fragmentShader: /* glsl */ `
				varying vec3 vColor;
				varying float vLife;
				void main() {
					if (vLife <= 0.0) discard;
					vec2 d = gl_PointCoord - 0.5;
					float r = dot(d, d);
					if (r > 0.25) discard;
					float a = smoothstep(0.25, 0.0, r);
					gl_FragColor = vec4(vColor * (0.6 + vLife), a * vLife);
				}
			`,
			vertexColors: true,
		})

		this.points = new THREE.Points(geo, mat)
		this.points.frustumCulled = false
		this.scene.add(this.points)
		this.geo = geo
	}

	/** Quality tiers thin out particle counts rather than dropping effects. */
	setScale(s) {
		this.scale = s
	}

	/** Scaled emitter count — always emits at least one so nothing vanishes. */
	n(count) {
		return Math.max(1, Math.round(count * this.scale))
	}

	spawn(x, y, z, vx, vy, vz, color, size, life, grav = 0, drag = 1.6) {
		const p = this.p
		const i = p.cursor
		p.cursor = (p.cursor + 1) % p.n
		const i3 = i * 3
		p.pos[i3] = x
		p.pos[i3 + 1] = y
		p.pos[i3 + 2] = z
		p.vel[i3] = vx
		p.vel[i3 + 1] = vy
		p.vel[i3 + 2] = vz
		const c = color instanceof THREE.Color ? color : new THREE.Color(color)
		p.col[i3] = c.r
		p.col[i3 + 1] = c.g
		p.col[i3 + 2] = c.b
		p.size[i] = size
		p.life[i] = 1
		p.maxLife[i] = life
		p.grav[i] = grav
		p.drag[i] = drag
	}

	// ------------------------------------------------------------ rings
	_buildRings() {
		this.rings = []
		const geo = new THREE.RingGeometry(0.72, 1, 40)
		for (let i = 0; i < 26; i++) {
			const m = new THREE.Mesh(
				geo,
				new THREE.MeshBasicMaterial({
					color: 0xffffff,
					transparent: true,
					opacity: 0,
					side: THREE.DoubleSide,
					blending: THREE.AdditiveBlending,
					depthWrite: false,
				}),
			)
			m.visible = false
			this.scene.add(m)
			this.rings.push({ mesh: m, t: 0, dur: 1, from: 1, to: 4, alive: false, flat: true })
		}

		this.spheres = []
		const sgeo = new THREE.SphereGeometry(1, 18, 14)
		// Soft light-burst: brightest through the middle, feathering out at the
		// silhouette, so a flash reads as light rather than a solid white ball.
		const glowVert = /* glsl */ `
			varying vec3 vN;
			varying vec3 vV;
			void main() {
				vec4 mv = modelViewMatrix * vec4(position, 1.0);
				vN = normalMatrix * normal;
				vV = -mv.xyz;
				gl_Position = projectionMatrix * mv;
			}
		`
		const glowFrag = /* glsl */ `
			varying vec3 vN;
			varying vec3 vV;
			uniform vec3 uColor;
			uniform float uOpacity;
			void main() {
				float d = abs(dot(normalize(vN), normalize(vV)));
				float f = pow(d, 2.4);
				gl_FragColor = vec4(uColor * f, f * uOpacity);
			}
		`
		for (let i = 0; i < 18; i++) {
			const mat = new THREE.ShaderMaterial({
				transparent: true,
				depthWrite: false,
				blending: THREE.AdditiveBlending,
				vertexShader: glowVert,
				fragmentShader: glowFrag,
				uniforms: { uColor: { value: new THREE.Color(0xffffff) }, uOpacity: { value: 0 } },
			})
			Object.defineProperty(mat, "opacity", {
				get: () => mat.uniforms.uOpacity.value,
				set: (v) => (mat.uniforms.uOpacity.value = v),
			})
			mat.color = mat.uniforms.uColor.value
			const m = new THREE.Mesh(sgeo, mat)
			m.visible = false
			this.scene.add(m)
			this.spheres.push({ mesh: m, t: 0, dur: 1, from: 0.4, to: 4, alive: false })
		}
	}

	_ring(pos, color, from, to, dur, flat = true, tilt = null) {
		const r = this.rings.find((x) => !x.alive)
		if (!r) return
		r.alive = true
		r.t = 0
		r.dur = dur
		r.from = from
		r.to = to
		r.mesh.visible = true
		r.mesh.position.copy(pos)
		r.mesh.material.color.setHex(color)
		if (tilt) {
			r.mesh.lookAt(tilt)
		} else if (flat) {
			r.mesh.rotation.set(-Math.PI / 2, 0, 0)
		}
	}

	_flash(pos, color, from, to, dur) {
		const s = this.spheres.find((x) => !x.alive)
		if (!s) return
		s.alive = true
		s.t = 0
		s.dur = dur
		s.from = from
		s.to = to
		s.mesh.visible = true
		s.mesh.position.copy(pos)
		s.mesh.material.color.setHex(color)
	}

	// ------------------------------------------------------------ beams
	_buildBeams() {
		this.beams = []
		const geo = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true)
		geo.translate(0, 0.5, 0)
		geo.rotateX(Math.PI / 2)
		for (let i = 0; i < 6; i++) {
			const m = new THREE.Mesh(
				geo,
				new THREE.MeshBasicMaterial({
					color: 0xbff4ff,
					transparent: true,
					opacity: 0,
					blending: THREE.AdditiveBlending,
					depthWrite: false,
					side: THREE.DoubleSide,
				}),
			)
			m.visible = false
			this.scene.add(m)
			this.beams.push({ mesh: m, t: 0, dur: 0.5, radius: 1, alive: false })
		}
	}

	beam(from, to, radius, color, dur = 0.45) {
		const b = this.beams.find((x) => !x.alive)
		if (!b) return
		b.alive = true
		b.t = 0
		b.dur = dur
		b.radius = radius
		b.mesh.visible = true
		b.mesh.position.copy(from)
		b.mesh.lookAt(to)
		b.mesh.scale.set(radius, radius, from.distanceTo(to))
		b.mesh.material.color.setHex(color)
	}

	// ------------------------------------------------------------ recipes
	muzzle(pos, dir, color = 0xbff4ff) {
		for (let i = 0, c = this.n(6); i < c; i++) {
			this.spawn(
				pos.x,
				pos.y,
				pos.z,
				dir.x * rand(4, 12) + rand(-3, 3),
				dir.y * rand(4, 12) + rand(-3, 3),
				dir.z * rand(4, 12) + rand(-3, 3),
				color,
				rand(0.05, 0.12),
				rand(0.08, 0.18),
				0,
				5,
			)
		}
		this._flash(pos, color, 0.05, 0.5, 0.09)
	}

	impact(pos, normal, color = 0xffc46a, scale = 1) {
		for (let i = 0, c = this.n(14 * scale); i < c; i++) {
			this.spawn(
				pos.x,
				pos.y,
				pos.z,
				rand(-6, 6) * scale + normal.x * 4,
				rand(-1, 8) * scale + normal.y * 4,
				rand(-6, 6) * scale + normal.z * 4,
				Math.random() < 0.4 ? 0xffffff : color,
				rand(0.05, 0.14) * scale,
				rand(0.18, 0.45),
				10,
				2.4,
			)
		}
		this._flash(pos, color, 0.1, 0.9 * scale, 0.14)
	}

	explosion(pos, color = 0xff7a1a, scale = 1) {
		for (let i = 0, c = this.n(46 * scale); i < c; i++) {
			const a = rand(0, TAU)
			const b = Math.acos(rand(-1, 1))
			const s = rand(3, 17) * scale
			this.spawn(
				pos.x,
				pos.y,
				pos.z,
				Math.sin(b) * Math.cos(a) * s,
				Math.cos(b) * s + 2,
				Math.sin(b) * Math.sin(a) * s,
				Math.random() < 0.35 ? 0xfff0b0 : color,
				rand(0.1, 0.34) * scale,
				rand(0.35, 0.95),
				9,
				1.6,
			)
		}
		// lingering smoke
		for (let i = 0, c = this.n(14 * scale); i < c; i++) {
			this.spawn(
				pos.x + rand(-0.6, 0.6),
				pos.y + rand(-0.4, 0.8),
				pos.z + rand(-0.6, 0.6),
				rand(-1.4, 1.4),
				rand(0.4, 2.2),
				rand(-1.4, 1.4),
				0x552244,
				rand(0.4, 0.9) * scale,
				rand(0.9, 1.7),
				-1,
				0.9,
			)
		}
		this._flash(pos, 0xfff0c0, 0.3, 2.4 * scale, 0.2)
		this._ring(pos, color, 0.5, 6 * scale, 0.55)
	}

	ringBurst(pos, color = 0x9fe9ff, scale = 1) {
		this._ring(pos, color, 0.4, 3.2 * scale, 0.45)
		for (let i = 0, c = this.n(10); i < c; i++) {
			const a = rand(0, TAU)
			this.spawn(
				pos.x,
				pos.y + 0.1,
				pos.z,
				Math.cos(a) * rand(2, 7),
				rand(0.5, 3),
				Math.sin(a) * rand(2, 7),
				color,
				rand(0.06, 0.14),
				rand(0.2, 0.45),
				6,
				2,
			)
		}
	}

	thruster(pos, legs) {
		if (this.scale < 0.5 && Math.random() > this.scale * 2) return
		for (const leg of legs) {
			leg.jet.getWorldPosition(this._v)
			this.spawn(
				this._v.x + rand(-0.06, 0.06),
				this._v.y - 0.2,
				this._v.z + rand(-0.06, 0.06),
				rand(-1.2, 1.2),
				rand(-9, -4),
				rand(-1.2, 1.2),
				Math.random() < 0.5 ? 0x9fe9ff : 0xffd9a0,
				rand(0.08, 0.2),
				rand(0.15, 0.35),
				-2,
				2.5,
			)
		}
	}

	dashTrail(pos, dir) {
		for (let i = 0, c = this.n(26); i < c; i++) {
			this.spawn(
				pos.x + rand(-0.4, 0.4),
				pos.y + rand(0.2, 1.8),
				pos.z + rand(-0.4, 0.4),
				-dir.x * rand(2, 9) + rand(-2, 2),
				rand(-1, 2),
				-dir.z * rand(2, 9) + rand(-2, 2),
				Math.random() < 0.5 ? 0xffa23c : 0x9fe9ff,
				rand(0.08, 0.22),
				rand(0.25, 0.55),
				0,
				2,
			)
		}
	}

	chargeSparks(pos, amount) {
		const count = 1 + Math.floor(amount * 3)
		for (let i = 0; i < count; i++) {
			const a = rand(0, TAU)
			const r = 1.4 * (1 - amount * 0.55) + rand(0, 0.5)
			this.spawn(
				pos.x + Math.cos(a) * r,
				pos.y + rand(-0.7, 0.7),
				pos.z + Math.sin(a) * r,
				-Math.cos(a) * 4,
				rand(-1, 1),
				-Math.sin(a) * 4,
				0x66e6ff,
				rand(0.05, 0.13),
				rand(0.15, 0.3),
				0,
				1.2,
			)
		}
	}

	nova(pos) {
		this._ring(pos, 0xffd08a, 0.5, 46, 1.15)
		this._ring(pos, 0x31e6ff, 0.5, 34, 0.95)
		this._flash(pos, 0xfff4d0, 0.5, 12, 0.5)
		for (let i = 0, c = this.n(240); i < c; i++) {
			const a = rand(0, TAU)
			const b = Math.acos(rand(-0.2, 1))
			const s = rand(14, 44)
			this.spawn(
				pos.x,
				pos.y + 1,
				pos.z,
				Math.sin(b) * Math.cos(a) * s,
				Math.cos(b) * s * 0.6,
				Math.sin(b) * Math.sin(a) * s,
				Math.random() < 0.5 ? 0xffd08a : 0xffffff,
				rand(0.12, 0.4),
				rand(0.5, 1.2),
				4,
				1.1,
			)
		}
	}

	pickupTrail(pos, color) {
		if (Math.random() > 0.35) return
		this.spawn(
			pos.x + rand(-0.2, 0.2),
			pos.y + rand(-0.2, 0.2),
			pos.z + rand(-0.2, 0.2),
			rand(-0.4, 0.4),
			rand(0.4, 1.4),
			rand(-0.4, 0.4),
			color,
			rand(0.06, 0.14),
			rand(0.3, 0.6),
			-0.6,
			1.4,
		)
	}

	// ------------------------------------------------------------ update
	update(dt) {
		this.time += dt
		const p = this.p
		for (let i = 0; i < p.n; i++) {
			if (p.life[i] <= 0) continue
			const i3 = i * 3
			p.life[i] -= dt / p.maxLife[i]
			if (p.life[i] <= 0) {
				p.life[i] = 0
				p.size[i] = 0
				continue
			}
			const d = 1 - p.drag[i] * dt
			p.vel[i3] *= d
			p.vel[i3 + 1] = p.vel[i3 + 1] * d - p.grav[i] * dt
			p.vel[i3 + 2] *= d
			p.pos[i3] += p.vel[i3] * dt
			p.pos[i3 + 1] += p.vel[i3 + 1] * dt
			p.pos[i3 + 2] += p.vel[i3 + 2] * dt
		}
		this.geo.attributes.position.needsUpdate = true
		this.geo.attributes.color.needsUpdate = true
		this.geo.attributes.aSize.needsUpdate = true
		this.geo.attributes.aLife.needsUpdate = true

		for (const r of this.rings) {
			if (!r.alive) continue
			r.t += dt
			const k = clamp(r.t / r.dur, 0, 1)
			const s = r.from + (r.to - r.from) * (1 - Math.pow(1 - k, 3))
			r.mesh.scale.setScalar(s)
			r.mesh.material.opacity = (1 - k) * 0.9
			if (k >= 1) {
				r.alive = false
				r.mesh.visible = false
			}
		}

		for (const s of this.spheres) {
			if (!s.alive) continue
			s.t += dt
			const k = clamp(s.t / s.dur, 0, 1)
			s.mesh.scale.setScalar(s.from + (s.to - s.from) * (1 - Math.pow(1 - k, 2)))
			s.mesh.material.opacity = (1 - k) * 0.85
			if (k >= 1) {
				s.alive = false
				s.mesh.visible = false
			}
		}

		for (const b of this.beams) {
			if (!b.alive) continue
			b.t += dt
			const k = clamp(b.t / b.dur, 0, 1)
			b.mesh.material.opacity = (1 - k) * 0.95
			b.mesh.scale.x = b.radius * (1 - k * 0.75)
			b.mesh.scale.y = b.radius * (1 - k * 0.75)
			if (k >= 1) {
				b.alive = false
				b.mesh.visible = false
			}
		}
	}

	clear() {
		const p = this.p
		p.life.fill(0)
		p.size.fill(0)
		for (const r of this.rings) {
			r.alive = false
			r.mesh.visible = false
		}
		for (const s of this.spheres) {
			s.alive = false
			s.mesh.visible = false
		}
		for (const b of this.beams) {
			b.alive = false
			b.mesh.visible = false
		}
	}
}
