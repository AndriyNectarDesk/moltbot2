// Pooled projectiles: hero plasma bolts, enemy orbs, and pickup orbs.

import * as THREE from "three"
import { rand } from "../../shared/util.js"

const _v = new THREE.Vector3()
const _v2 = new THREE.Vector3()

// A bolt used to be a Group holding a solid core mesh plus a bigger additive
// glow mesh — three scene objects each, and with both pools that was over half
// of everything in the scene getting walked every frame. It is now a single
// mesh whose shader draws the hot core and the falloff in one pass.
const BOLT_VERT = /* glsl */ `
	varying vec3 vN;
	varying vec3 vV;
	void main() {
		vec4 mv = modelViewMatrix * vec4(position, 1.0);
		vN = normalMatrix * normal;
		vV = -mv.xyz;
		gl_Position = projectionMatrix * mv;
	}
`
const BOLT_FRAG = /* glsl */ `
	varying vec3 vN;
	varying vec3 vV;
	uniform vec3 uColor;
	void main() {
		float d = abs(dot(normalize(vN), normalize(vV)));
		float glow = pow(d, 2.0) * 0.55;          // soft halo
		float core = smoothstep(0.72, 1.0, d);     // white-hot centre
		vec3 col = uColor * glow + vec3(core);
		gl_FragColor = vec4(col, clamp(glow + core, 0.0, 1.0));
	}
`

class BoltPool {
	constructor(scene, count, color, radius, glowScale = 3.4) {
		this.items = []
		// one geometry + one material shared by the whole pool
		const geo = new THREE.SphereGeometry(radius * glowScale, 8, 6)
		const mat = new THREE.ShaderMaterial({
			transparent: true,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
			vertexShader: BOLT_VERT,
			fragmentShader: BOLT_FRAG,
			uniforms: { uColor: { value: new THREE.Color(color) } },
		})
		for (let i = 0; i < count; i++) {
			const m = new THREE.Mesh(geo, mat)
			m.visible = false
			m.frustumCulled = false
			scene.add(m)
			this.items.push({
				mesh: m,
				vel: new THREE.Vector3(),
				alive: false,
				life: 0,
				damage: 0,
				radius,
				homing: 0,
			})
		}
	}

	acquire() {
		for (const it of this.items) {
			if (!it.alive) return it
		}
		return null
	}

	clear() {
		for (const it of this.items) {
			it.alive = false
			it.mesh.visible = false
		}
	}
}

export class Projectiles {
	constructor(scene, world, fx) {
		this.scene = scene
		this.world = world
		this.fx = fx
		this.player = new BoltPool(scene, 64, 0x62e8ff, 0.13, 3.6)
		this.enemy = new BoltPool(scene, 96, 0xff3aa0, 0.19, 3.0)
	}

	firePlayer(origin, dir, { speed = 88, damage = 14, life = 2.2 } = {}) {
		const b = this.player.acquire()
		if (!b) return null
		b.alive = true
		b.life = life
		b.damage = damage
		b.mesh.visible = true
		b.mesh.position.copy(origin)
		b.vel.copy(dir).multiplyScalar(speed)
		b.mesh.scale.setScalar(1)
		this.fx.muzzle(origin, dir, 0xbff4ff)
		return b
	}

	fireEnemy(origin, dir, { speed = 26, damage = 9, life = 5, homing = 0, scale = 1 } = {}) {
		const b = this.enemy.acquire()
		if (!b) return null
		b.alive = true
		b.life = life
		b.damage = damage
		b.homing = homing
		b.mesh.visible = true
		b.mesh.position.copy(origin)
		b.mesh.scale.setScalar(scale)
		b.vel.copy(dir).multiplyScalar(speed)
		this.fx.muzzle(origin, dir, 0xff3aa0)
		return b
	}

	/** Advance and resolve everything. `ctx` supplies hero + enemy list + callbacks. */
	update(dt, ctx) {
		const { hero, enemies } = ctx

		// ---- hero bolts
		for (const b of this.player.items) {
			if (!b.alive) continue
			b.life -= dt
			const step = _v.copy(b.vel).multiplyScalar(dt)
			const dist = step.length()
			const dir = _v2.copy(b.vel).normalize()

			let hitSomething = false
			// enemy sweep test
			let best = null
			let bestT = Infinity
			for (const e of enemies) {
				if (!e.alive || e.dying) continue
				const toE = _v.copy(e.center).sub(b.mesh.position)
				const along = toE.dot(dir)
				if (along < -e.radius || along > dist + e.radius) continue
				const perp = Math.sqrt(Math.max(0, toE.lengthSq() - along * along))
				if (perp <= e.radius + b.radius && along < bestT) {
					bestT = along
					best = e
				}
			}
			if (best) {
				_v.copy(dir).multiplyScalar(Math.max(bestT, 0)).add(b.mesh.position)
				ctx.onHitEnemy(best, b.damage, _v, dir)
				hitSomething = true
			}

			if (!hitSomething) {
				b.mesh.position.addScaledVector(b.vel, dt)
				if (this._hitWorld(b.mesh.position)) {
					this.fx.impact(b.mesh.position, _v.set(0, 1, 0), 0x62e8ff, 0.8)
					hitSomething = true
				}
			}

			if (hitSomething || b.life <= 0) {
				b.alive = false
				b.mesh.visible = false
			}
		}

		// ---- enemy bolts
		for (const b of this.enemy.items) {
			if (!b.alive) continue
			b.life -= dt
			if (b.homing > 0 && !hero.dead) {
				const to = _v.copy(hero.pos).setY(hero.pos.y + 1).sub(b.mesh.position).normalize()
				b.vel.lerp(to.multiplyScalar(b.vel.length()), Math.min(1, b.homing * dt))
			}
			b.mesh.position.addScaledVector(b.vel, dt)
			b.mesh.rotation.y += dt * 6

			const r = 0.5 * b.mesh.scale.x + 0.55
			if (
				!hero.dead &&
				b.mesh.position.distanceToSquared(_v.set(hero.pos.x, hero.pos.y + 0.95, hero.pos.z)) < r * r
			) {
				if (hero.damage(b.damage, b.mesh.position)) ctx.onHeroHit(b.damage)
				this.fx.impact(b.mesh.position, _v2.set(0, 1, 0), 0xff3aa0, 0.9)
				b.alive = false
				b.mesh.visible = false
				continue
			}

			if (this._hitWorld(b.mesh.position) || b.life <= 0) {
				if (b.life > 0) this.fx.impact(b.mesh.position, _v.set(0, 1, 0), 0xff3aa0, 0.7)
				b.alive = false
				b.mesh.visible = false
			}
		}
	}

	/** Cheap point-vs-arena test. */
	_hitWorld(p) {
		if (p.y < -60) return true
		for (const c of this.world.colliders) {
			if (c.type === "cyl") {
				if (p.y < c.top && p.y > c.bottom && Math.hypot(p.x - c.x, p.z - c.z) < c.r) return true
			} else if (
				p.x > c.min.x && p.x < c.max.x &&
				p.y > c.min.y && p.y < c.max.y &&
				p.z > c.min.z && p.z < c.max.z
			) {
				return true
			}
		}
		return false
	}

	/** Wipe every enemy projectile (used by the Nova ultimate). */
	clearEnemyBolts() {
		for (const b of this.enemy.items) {
			if (!b.alive) continue
			this.fx.impact(b.mesh.position, _v.set(0, 1, 0), 0xffd08a, 0.6)
			b.alive = false
			b.mesh.visible = false
		}
	}

	clear() {
		this.player.clear()
		this.enemy.clear()
	}
}

// ---------------------------------------------------------------- pickups
export class Pickups {
	constructor(scene, fx, audio) {
		this.scene = scene
		this.fx = fx
		this.audio = audio
		this.items = []
		const geo = new THREE.IcosahedronGeometry(0.32, 0)
		for (let i = 0; i < 24; i++) {
			const mat = new THREE.MeshStandardMaterial({
				color: 0xffffff,
				emissive: 0xffffff,
				emissiveIntensity: 2.2,
				roughness: 0.2,
			})
			const m = new THREE.Mesh(geo, mat)
			const halo = new THREE.Mesh(
				new THREE.SphereGeometry(0.7, 10, 8),
				new THREE.MeshBasicMaterial({
					color: 0xffffff,
					transparent: true,
					opacity: 0.25,
					blending: THREE.AdditiveBlending,
					depthWrite: false,
				}),
			)
			m.add(halo)
			m.visible = false
			scene.add(m)
			this.items.push({ mesh: m, halo, alive: false, kind: "hp", t: 0, vy: 0 })
		}
	}

	spawn(pos, kind) {
		const it = this.items.find((x) => !x.alive)
		if (!it) return
		it.alive = true
		it.kind = kind
		it.t = 0
		it.vy = rand(3, 6)
		it.mesh.visible = true
		it.mesh.position.copy(pos).add(new THREE.Vector3(rand(-0.5, 0.5), 0.8, rand(-0.5, 0.5)))
		const col = kind === "hp" ? 0x6dffa8 : 0x31e6ff
		it.mesh.material.color.setHex(col)
		it.mesh.material.emissive.setHex(col)
		it.halo.material.color.setHex(col)
	}

	update(dt, hero, world, onCollect) {
		for (const it of this.items) {
			if (!it.alive) continue
			it.t += dt
			it.vy -= 22 * dt
			it.mesh.position.y += it.vy * dt
			const g = world.groundAt(it.mesh.position.x, it.mesh.position.z, it.mesh.position.y)
			if (it.mesh.position.y < g + 0.5) {
				it.mesh.position.y = g + 0.5
				it.vy = Math.abs(it.vy) * 0.45
				if (it.vy < 1.2) it.vy = 0
			}
			it.mesh.rotation.y += dt * 2.4
			it.mesh.rotation.x += dt * 1.3
			it.mesh.position.y += Math.sin(it.t * 3) * dt * 0.4
			this.fx.pickupTrail(it.mesh.position, it.kind === "hp" ? 0x6dffa8 : 0x31e6ff)

			// magnet towards the hero when close
			const d = it.mesh.position.distanceTo(_v.set(hero.pos.x, hero.pos.y + 0.9, hero.pos.z))
			if (d < 7) {
				it.mesh.position.lerp(_v, Math.min(1, dt * (2.5 + (7 - d))))
			}
			if (d < 1.3 || it.t > 22) {
				if (d < 1.3) {
					onCollect(it.kind)
					this.audio.pickup(it.kind)
					this.fx.ringBurst(it.mesh.position, it.kind === "hp" ? 0x6dffa8 : 0x31e6ff, 0.7)
				}
				it.alive = false
				it.mesh.visible = false
			}
		}
	}

	clear() {
		for (const it of this.items) {
			it.alive = false
			it.mesh.visible = false
		}
	}
}
