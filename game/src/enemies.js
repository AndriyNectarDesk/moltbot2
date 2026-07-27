// The Glitch Legion — four grunt archetypes plus MOLTBOT PRIME.
// All meshes are primitive-built and animated procedurally.

import * as THREE from "three"
import { clamp, damp, lerp, rand, TAU } from "./util.js"

const MAG = 0xff2d95
const VIO = 0x8a3cff
const CY = 0x31e6ff
const _v = new THREE.Vector3()
const _v2 = new THREE.Vector3()

const shell = (color = 0x2a1440) =>
	new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.85 })

const neon = (color, intensity = 2.4) =>
	new THREE.MeshStandardMaterial({
		color,
		emissive: color,
		emissiveIntensity: intensity,
		roughness: 0.3,
		metalness: 0.2,
	})

// ---------------------------------------------------------------- base
export class Enemy {
	constructor(game, pos) {
		this.game = game
		this.scene = game.scene
		this.pos = pos.clone()
		this.vel = new THREE.Vector3()
		this.center = new THREE.Vector3()
		this.group = new THREE.Group()
		this.group.position.copy(this.pos)
		this.scene.add(this.group)
		this.alive = true
		this.dying = false
		this.dieT = 0
		this.hitFlash = 0
		this.t = rand(0, 10)
		this.yaw = rand(0, TAU)
		this.fireT = rand(0.6, 2)
		this.radius = 1
		this.score = 100
		this.contactDamage = 0
		this.name = "DRONE"
		this._mats = []
	}

	track(mat) {
		this._mats.push({ mat, e: mat.emissive ? mat.emissive.clone() : null, i: mat.emissiveIntensity })
		return mat
	}

	hit(dmg, point) {
		if (!this.alive || this.dying) return { killed: false, dmg: 0 }
		let mult = 1
		if (this.weakPoint && point) {
			this.weakPoint.getWorldPosition(_v)
			if (point.distanceTo(_v) < this.weakRadius) mult = 2.2
		}
		const applied = dmg * mult
		this.hp -= applied
		this.hitFlash = 1
		const killed = this.hp <= 0
		if (killed) this.startDeath()
		return { killed, dmg: applied, crit: mult > 1 }
	}

	startDeath() {
		this.dying = true
		this.dieT = 0
		this.game.onEnemyKilled(this)
	}

	remove() {
		this.alive = false
		this.scene.remove(this.group)
		this.group.traverse((o) => {
			if (o.geometry) o.geometry.dispose?.()
		})
	}

	_deathAnim(dt) {
		this.dieT += dt
		const k = clamp(this.dieT / 0.28, 0, 1)
		this.group.scale.setScalar(Math.max(0.001, (1 - k) * (1 + k * 0.6)))
		this.group.rotation.y += dt * 14
		this.pos.y += dt * 2
		this.group.position.copy(this.pos)
		if (k >= 1) this.remove()
	}

	_flash(dt) {
		if (this.hitFlash > 0) {
			this.hitFlash = Math.max(0, this.hitFlash - dt * 5)
			for (const r of this._mats) {
				if (!r.e) continue
				r.mat.emissive.setRGB(
					lerp(r.e.r, 4, this.hitFlash),
					lerp(r.e.g, 4, this.hitFlash),
					lerp(r.e.b, 4, this.hitFlash),
				)
				r.mat.emissiveIntensity = lerp(r.i, 3.4, this.hitFlash)
			}
		}
	}

	/** Push apart from other enemies so packs don't stack into one point. */
	separate(dt, strength = 8) {
		for (const o of this.game.enemies) {
			if (o === this || !o.alive || o.dying) continue
			const dx = this.pos.x - o.pos.x
			const dy = this.pos.y - o.pos.y
			const dz = this.pos.z - o.pos.z
			const minD = this.radius + o.radius
			const d2 = dx * dx + dy * dy + dz * dz
			if (d2 > minD * minD || d2 < 1e-5) continue
			const d = Math.sqrt(d2)
			const push = ((minD - d) / minD) * strength * dt
			this.pos.x += (dx / d) * push
			this.pos.y += (dy / d) * push
			this.pos.z += (dz / d) * push
		}
	}

	faceHero(dt, speed = 6) {
		const dx = this.game.hero.pos.x - this.pos.x
		const dz = this.game.hero.pos.z - this.pos.z
		const want = Math.atan2(dx, dz)
		let d = (want - this.yaw) % TAU
		if (d > Math.PI) d -= TAU
		if (d < -Math.PI) d += TAU
		this.yaw += d * clamp(dt * speed, 0, 1)
		this.group.rotation.y = this.yaw
	}

	get heroPos() {
		return this.game.hero.pos
	}

	distToHero() {
		return this.pos.distanceTo(this.heroPos)
	}

	shootAtHero(opts) {
		const from = _v.copy(this.pos).setY(this.pos.y + (this.muzzleY ?? 1))
		const to = _v2.copy(this.heroPos).setY(this.heroPos.y + 1)
		// small lead so faster shots feel deliberate
		const dir = to.sub(from).normalize()
		this.game.projectiles.fireEnemy(from, dir, opts)
	}
}

// ---------------------------------------------------------------- Skitter
export class Skitter extends Enemy {
	constructor(game, pos, tier = 1) {
		super(game, pos)
		this.name = "SKITTER"
		this.maxHp = 26 + tier * 7
		this.hp = this.maxHp
		this.radius = 0.95
		this.score = 120
		this.tier = tier
		this.orbitDir = Math.random() < 0.5 ? 1 : -1
		this.orbitR = rand(10, 17)
		this.height = rand(2.5, 7)
		this.pos.y = game.world.padTop + this.height

		const body = new THREE.Mesh(new THREE.OctahedronGeometry(0.62, 0), this.track(shell(0x33184f)))
		body.castShadow = true
		this.group.add(body)
		this.body = body

		const eye = new THREE.Mesh(new THREE.SphereGeometry(0.27, 12, 10), this.track(neon(MAG, 3)))
		eye.position.z = 0.5
		this.group.add(eye)
		this.eye = eye

		const halo = new THREE.Mesh(
			new THREE.SphereGeometry(0.85, 10, 8),
			new THREE.MeshBasicMaterial({
				color: MAG,
				transparent: true,
				opacity: 0.16,
				blending: THREE.AdditiveBlending,
				depthWrite: false,
			}),
		)
		this.group.add(halo)

		this.fins = []
		for (let i = 0; i < 3; i++) {
			const fin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 1.05), this.track(shell(0x4a2470)))
			fin.position.y = 0.1
			fin.rotation.y = (i / 3) * TAU
			fin.castShadow = true
			this.group.add(fin)
			this.fins.push(fin)
		}
		const ring = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.05, 6, 24), this.track(neon(VIO, 2)))
		ring.rotation.x = Math.PI / 2
		this.group.add(ring)
		this.ring = ring
	}

	update(dt) {
		if (this.dying) return this._deathAnim(dt)
		this.t += dt
		this._flash(dt)

		const h = this.heroPos
		const toH = _v.set(h.x - this.pos.x, 0, h.z - this.pos.z)
		const d = toH.length()
		toH.normalize()
		const tangent = _v2.set(-toH.z, 0, toH.x).multiplyScalar(this.orbitDir)
		const radial = d - this.orbitR
		const desired = new THREE.Vector3()
			.addScaledVector(toH, clamp(radial * 0.6, -6, 6))
			.addScaledVector(tangent, 4.5)
		const wantY = h.y + this.height + Math.sin(this.t * 1.7) * 1.1
		desired.y = clamp((wantY - this.pos.y) * 2.2, -7, 7)

		this.vel.lerp(desired, clamp(dt * 3.2, 0, 1))
		this.pos.addScaledVector(this.vel, dt)
		this.separate(dt)

		// stay inside the arena
		const r = Math.hypot(this.pos.x, this.pos.z)
		const maxR = this.game.world.radius - 3
		if (r > maxR) {
			this.pos.x *= maxR / r
			this.pos.z *= maxR / r
		}
		const g = this.game.world.groundAt(this.pos.x, this.pos.z, this.pos.y)
		if (this.pos.y < g + 1.4) this.pos.y = g + 1.4

		this.group.position.copy(this.pos)
		this.center.copy(this.pos)
		this.faceHero(dt, 7)
		this.body.rotation.y += dt * 1.1
		this.body.rotation.x = Math.sin(this.t * 2) * 0.2
		for (let i = 0; i < 3; i++) this.fins[i].rotation.y += dt * (2 + i)
		this.ring.rotation.z += dt * 2
		this.eye.scale.setScalar(1 + Math.sin(this.t * 6) * 0.08)

		this.fireT -= dt
		if (this.fireT <= 0 && d < 42) {
			this.fireT = rand(1.5, 2.6) / (1 + this.tier * 0.06)
			this.muzzleY = 0
			this.shootAtHero({
				speed: 24 + this.tier * 1.2,
				damage: 7,
				homing: this.tier > 4 ? 0.5 : 0,
			})
		}
	}
}

// ---------------------------------------------------------------- Brute
export class Brute extends Enemy {
	constructor(game, pos, tier = 1) {
		super(game, pos)
		this.name = "BRUTE"
		this.maxHp = 95 + tier * 22
		this.hp = this.maxHp
		this.radius = 1.5
		this.score = 300
		this.tier = tier
		this.slamT = 0
		this.windup = 0
		this.step = rand(0, 6)

		const torso = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.5, 1.2), this.track(shell(0x2b1548)))
		torso.position.y = 2.3
		torso.castShadow = true
		this.group.add(torso)
		this.torso = torso

		const visor = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.26, 0.1), this.track(neon(MAG, 3)))
		visor.position.set(0, 2.65, 0.62)
		this.group.add(visor)
		this.visor = visor

		const core = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 10), this.track(neon(CY, 3.2)))
		core.position.set(0, 2.15, 0.6)
		this.group.add(core)
		this.weakPoint = core
		this.weakRadius = 0.8

		for (const s of [-1, 1]) {
			const pauldron = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.6, 1.0), this.track(shell(0x431f66)))
			pauldron.position.set(s * 1.1, 2.7, 0)
			pauldron.castShadow = true
			this.group.add(pauldron)
			const gun = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 1.1, 8), this.track(shell(0x1c1030)))
			gun.rotation.x = Math.PI / 2
			gun.position.set(s * 1.1, 2.6, 0.7)
			this.group.add(gun)
			const tip = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 8), this.track(neon(MAG, 2)))
			tip.position.set(s * 1.1, 2.6, 1.25)
			this.group.add(tip)
		}

		this.legs = []
		for (const s of [-1, 1]) {
			const hip = new THREE.Group()
			hip.position.set(s * 0.45, 1.6, 0)
			this.group.add(hip)
			const thigh = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.9, 0.4), this.track(shell(0x391c56)))
			thigh.position.y = -0.45
			thigh.castShadow = true
			hip.add(thigh)
			const knee = new THREE.Group()
			knee.position.y = -0.9
			hip.add(knee)
			const shin = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.8, 0.34), this.track(shell(0x23133b)))
			shin.position.y = -0.4
			knee.add(shin)
			const foot = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.2, 0.75), this.track(shell(0x150c25)))
			foot.position.set(0, -0.82, 0.15)
			knee.add(foot)
			this.legs.push({ hip, knee, s })
		}
	}

	update(dt) {
		if (this.dying) return this._deathAnim(dt)
		this.t += dt
		this._flash(dt)

		const d = this.distToHero()
		const toH = _v.copy(this.heroPos).setY(0).sub(_v2.copy(this.pos).setY(0))
		const dist = toH.length()
		toH.normalize()

		const charging = this.windup > 0
		const speed = charging ? 0 : 5.2 + this.tier * 0.22
		if (dist > 3.2 && !charging) {
			this.vel.x = damp(this.vel.x, toH.x * speed, 0.001, dt)
			this.vel.z = damp(this.vel.z, toH.z * speed, 0.001, dt)
		} else {
			this.vel.x *= 0.85
			this.vel.z *= 0.85
		}

		this.vel.y -= 26 * dt
		this.pos.addScaledVector(this.vel, dt)
		this.separate(dt, 10)

		const g = this.game.world.groundAt(this.pos.x, this.pos.z, this.pos.y)
		if (this.pos.y <= g) {
			this.pos.y = g
			this.vel.y = 0
			this.grounded = true
		} else if (this.pos.y > g + 0.2 && g > -100) {
			// walk off an edge → fall back to the pad
			this.grounded = false
		}
		if (this.pos.y < -30) {
			this.pos.set(rand(-20, 20), 24, rand(-20, 20))
			this.vel.set(0, 0, 0)
		}

		const rr = Math.hypot(this.pos.x, this.pos.z)
		const maxR = this.game.world.radius - 3
		if (rr > maxR) {
			this.pos.x *= maxR / rr
			this.pos.z *= maxR / rr
		}

		this.group.position.copy(this.pos)
		this.center.copy(this.pos).setY(this.pos.y + 2.2)
		this.faceHero(dt, 3.6)

		// walk cycle
		const moving = Math.hypot(this.vel.x, this.vel.z) > 0.8
		this.step += dt * (moving ? 6.5 : 1.2)
		for (const leg of this.legs) {
			const sw = Math.sin(this.step) * leg.s
			leg.hip.rotation.x = moving ? sw * 0.6 : Math.sin(this.t * 1.4) * 0.04
			leg.knee.rotation.x = moving ? Math.max(0, -sw) * 0.8 : 0.05
		}
		this.torso.position.y = 2.3 + (moving ? Math.abs(Math.sin(this.step)) * 0.09 : Math.sin(this.t) * 0.03)

		// melee slam
		if (this.windup > 0) {
			this.windup -= dt
			const k = 1 - this.windup / 0.75
			this.torso.rotation.x = -k * 0.5
			this.visor.material.emissiveIntensity = 3 + Math.sin(this.t * 40) * 2.5
			if (this.windup <= 0) {
				this.torso.rotation.x = 0.4
				this.game.fx.explosion(_v.copy(this.pos).setY(this.pos.y + 0.4), MAG, 0.9)
				this.game.fx.ringBurst(this.pos, MAG, 2.6)
				this.game.audio.explode(0.7)
				this.game.shake(0.4)
				if (this.distToHero() < 6 && Math.abs(this.heroPos.y - this.pos.y) < 3.4) {
					if (this.game.hero.damage(18, this.pos)) this.game.onHeroHit(18)
				}
			}
		} else {
			this.torso.rotation.x = damp(this.torso.rotation.x, 0, 0.001, dt)
			this.visor.material.emissiveIntensity = 3
			if (d < 5 && Math.abs(this.heroPos.y - this.pos.y) < 3.5) {
				this.slamT -= dt
				if (this.slamT <= 0) {
					this.windup = 0.75
					this.slamT = 2.4
				}
			} else {
				this.slamT = 0.6
				this.fireT -= dt
				if (this.fireT <= 0 && d < 44) {
					this.fireT = rand(1.9, 3.1)
					this.muzzleY = 2.6
					for (const off of [-0.35, 0.35]) {
						const from = _v.copy(this.pos).setY(this.pos.y + 2.6)
						const dir = _v2.copy(this.heroPos).setY(this.heroPos.y + 1).sub(from).normalize()
						dir.x += off * 0.06
						this.game.projectiles.fireEnemy(from, dir.normalize(), {
							speed: 30,
							damage: 10,
							scale: 1.2,
						})
					}
				}
			}
		}
	}
}

// ---------------------------------------------------------------- Lancer
export class Lancer extends Enemy {
	constructor(game, pos, tier = 1) {
		super(game, pos)
		this.name = "LANCER"
		this.maxHp = 45 + tier * 10
		this.hp = this.maxHp
		this.radius = 1.1
		this.score = 260
		this.tier = tier
		this.state = "move"
		this.stateT = rand(1, 2.5)
		this.height = rand(6, 13)
		this.pos.y = game.world.padTop + this.height

		const hull = new THREE.Mesh(new THREE.ConeGeometry(0.5, 2.4, 6), this.track(shell(0x1f1238)))
		hull.rotation.x = Math.PI / 2
		hull.castShadow = true
		this.group.add(hull)

		const lens = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 10), this.track(neon(0xff6a00, 2.4)))
		lens.position.z = 1.2
		this.group.add(lens)
		this.lens = lens
		this.weakPoint = lens
		this.weakRadius = 0.7

		for (const s of [-1, 1]) {
			const wing = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.08, 0.5), this.track(shell(0x3a1e5c)))
			wing.position.set(s * 0.85, 0, -0.3)
			wing.rotation.z = s * 0.28
			wing.castShadow = true
			this.group.add(wing)
			const led = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 8), this.track(neon(CY, 2)))
			led.position.set(s * 1.5, 0, -0.3)
			this.group.add(led)
		}

		// telegraph line drawn before the shot lands
		const g = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true)
		g.translate(0, 0.5, 0)
		g.rotateX(Math.PI / 2)
		this.laser = new THREE.Mesh(
			g,
			new THREE.MeshBasicMaterial({
				color: 0xff3a3a,
				transparent: true,
				opacity: 0,
				blending: THREE.AdditiveBlending,
				depthWrite: false,
			}),
		)
		this.laser.visible = false
		this.scene.add(this.laser)
	}

	remove() {
		this.scene.remove(this.laser)
		super.remove()
	}

	update(dt) {
		if (this.dying) {
			this.laser.visible = false
			return this._deathAnim(dt)
		}
		this.t += dt
		this._flash(dt)

		const h = this.heroPos
		const toH = _v.set(h.x - this.pos.x, 0, h.z - this.pos.z)
		const dist = toH.length()
		toH.normalize()

		this.stateT -= dt
		if (this.state === "move") {
			const want = 22
			const radial = clamp((dist - want) * 0.8, -8, 8)
			const strafe = _v2.set(-toH.z, 0, toH.x).multiplyScalar(Math.sin(this.t * 0.7) * 5)
			this.vel.x = damp(this.vel.x, toH.x * radial + strafe.x, 0.002, dt)
			this.vel.z = damp(this.vel.z, toH.z * radial + strafe.z, 0.002, dt)
			const wantY = Math.max(h.y + 6, this.game.world.groundAt(this.pos.x, this.pos.z, this.pos.y) + this.height)
			this.vel.y = damp(this.vel.y, (wantY - this.pos.y) * 2, 0.002, dt)
			if (this.stateT <= 0 && dist < 46) {
				this.state = "charge"
				this.stateT = 1.15
			}
		} else if (this.state === "charge") {
			this.vel.multiplyScalar(0.9)
			const k = 1 - this.stateT / 1.15
			this.lens.material.emissiveIntensity = 2 + k * 9
			this.lens.scale.setScalar(1 + k * 0.7)
			// telegraph
			this.laser.visible = true
			const from = _v.copy(this.pos)
			const to = _v2.copy(h).setY(h.y + 1)
			this.laser.position.copy(from)
			this.laser.lookAt(to)
			this.laser.scale.set(0.02 + k * 0.05, 0.02 + k * 0.05, from.distanceTo(to))
			this.laser.material.opacity = 0.25 + k * 0.5
			if (this.stateT <= 0) {
				this.state = "recover"
				this.stateT = 1.1
				this.laser.visible = false
				this.lens.scale.setScalar(1)
				this.lens.material.emissiveIntensity = 2.4
				// hitscan-ish: a fast fat bolt
				this.muzzleY = 0
				this.shootAtHero({ speed: 62, damage: 16, scale: 1.5, life: 2 })
				this.game.fx.beam(this.pos, _v2.copy(h).setY(h.y + 1), 0.1, 0xff5a3a, 0.28)
				this.game.audio.beamFire(0.8)
			}
		} else {
			this.vel.multiplyScalar(0.94)
			if (this.stateT <= 0) {
				this.state = "move"
				this.stateT = rand(1.4, 2.6) / (1 + this.tier * 0.05)
			}
		}

		this.pos.addScaledVector(this.vel, dt)
		this.separate(dt, 6)
		const rr = Math.hypot(this.pos.x, this.pos.z)
		const maxR = this.game.world.radius - 3
		if (rr > maxR) {
			this.pos.x *= maxR / rr
			this.pos.z *= maxR / rr
		}
		this.group.position.copy(this.pos)
		this.center.copy(this.pos)

		// point the nose at the hero (pitch included)
		this.group.lookAt(_v.copy(h).setY(h.y + 1))
		this.group.rotateY(0)
	}
}

// ---------------------------------------------------------------- Zipper
export class Zipper extends Enemy {
	constructor(game, pos, tier = 1) {
		super(game, pos)
		this.name = "ZIPPER"
		this.maxHp = 14 + tier * 3
		this.hp = this.maxHp
		this.radius = 0.6
		this.score = 90
		this.armT = rand(0.2, 0.7)

		const b = new THREE.Mesh(new THREE.TetrahedronGeometry(0.55, 0), this.track(neon(0xff5ab0, 1.6)))
		b.castShadow = true
		this.group.add(b)
		this.b = b
		const spike = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.7, 5), this.track(neon(0xfff0a0, 2)))
		spike.rotation.x = Math.PI / 2
		spike.position.z = 0.55
		this.group.add(spike)
		this.pos.y = game.world.padTop + rand(1.5, 5)
	}

	update(dt) {
		if (this.dying) return this._deathAnim(dt)
		this.t += dt
		this._flash(dt)
		this.armT -= dt

		const target = _v.copy(this.heroPos).setY(this.heroPos.y + 0.9)
		const to = target.sub(this.pos)
		const d = to.length()
		to.normalize()
		const speed = this.armT > 0 ? 6 : 19
		this.vel.lerp(to.multiplyScalar(speed), clamp(dt * 2.6, 0, 1))
		this.pos.addScaledVector(this.vel, dt)
		this.separate(dt, 5)
		this.group.position.copy(this.pos)
		this.center.copy(this.pos)
		this.group.lookAt(_v.copy(this.heroPos).setY(this.heroPos.y + 0.9))
		this.b.rotation.z += dt * 9
		this.b.scale.setScalar(1 + Math.sin(this.t * 18) * 0.1)

		if (d < 1.5 && this.armT <= 0) {
			this.game.fx.explosion(this.pos, 0xff5ab0, 0.8)
			this.game.audio.explode(0.6)
			if (this.game.hero.damage(12, this.pos)) this.game.onHeroHit(12)
			this.game.shake(0.3)
			this.hp = 0
			this.startDeath()
		}
		if (this.pos.y < -30) this.startDeath()
	}
}

// ---------------------------------------------------------------- Boss
export class MoltbotPrime extends Enemy {
	constructor(game, pos, tier = 1) {
		super(game, pos)
		this.name = "MOLTBOT PRIME"
		this.isBoss = true
		this.maxHp = 1500 + tier * 700
		this.hp = this.maxHp
		this.radius = 3.4
		this.score = 6000
		this.tier = tier
		this.phase = 1
		this.state = "idle"
		this.stateT = 2
		this.spiral = 0
		this.pos.y = game.world.padTop + 7

		const dark = 0x1b1030
		const body = new THREE.Mesh(new THREE.BoxGeometry(4.2, 3.6, 3), this.track(shell(dark)))
		body.castShadow = true
		this.group.add(body)
		this.torso = body

		const chestPlate = new THREE.Mesh(new THREE.BoxGeometry(3, 1.6, 0.4), this.track(shell(0x40206b)))
		chestPlate.position.set(0, 0.6, 1.5)
		this.group.add(chestPlate)

		// exposed core — the weak point
		const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.85, 1), this.track(neon(CY, 1.9)))
		core.position.set(0, -0.4, 1.6)
		this.group.add(core)
		this.weakPoint = core
		this.weakRadius = 1.5
		this.core = core

		const coreHalo = new THREE.Mesh(
			new THREE.SphereGeometry(1.5, 14, 12),
			new THREE.MeshBasicMaterial({
				color: CY,
				transparent: true,
				opacity: 0.12,
				blending: THREE.AdditiveBlending,
				depthWrite: false,
			}),
		)
		core.add(coreHalo)

		// head
		const head = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.1, 1.6), this.track(shell(0x2a1748)))
		head.position.y = 2.4
		head.castShadow = true
		this.group.add(head)
		const eye = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.3, 0.12), this.track(neon(MAG, 3.4)))
		eye.position.set(0, 2.5, 0.84)
		this.group.add(eye)
		this.eye = eye
		for (const s of [-1, 1]) {
			const horn = new THREE.Mesh(new THREE.ConeGeometry(0.16, 1.1, 5), this.track(shell(0x522a80)))
			horn.position.set(s * 0.7, 3.2, 0)
			horn.rotation.z = s * 0.4
			this.group.add(horn)
		}

		// arms with cannons
		this.arms = []
		for (const s of [-1, 1]) {
			const shoulder = new THREE.Group()
			shoulder.position.set(s * 2.6, 1.2, 0)
			this.group.add(shoulder)
			const pad = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.6), this.track(shell(0x381c5c)))
			pad.castShadow = true
			shoulder.add(pad)
			const arm = new THREE.Mesh(new THREE.BoxGeometry(0.8, 2.2, 0.9), this.track(shell(0x241440)))
			arm.position.y = -1.4
			arm.castShadow = true
			shoulder.add(arm)
			const cannon = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.42, 1.8, 10), this.track(shell(0x120a20)))
			cannon.rotation.x = Math.PI / 2
			cannon.position.set(0, -2.4, 0.8)
			shoulder.add(cannon)
			const tip = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 10), this.track(neon(MAG, 2.4)))
			tip.position.set(0, -2.4, 1.7)
			shoulder.add(tip)
			this.arms.push({ shoulder, tip, s })
		}

		// orbiting shoulder rings
		this.orbits = []
		for (let i = 0; i < 2; i++) {
			const ring = new THREE.Mesh(
				new THREE.TorusGeometry(4.4 + i * 0.9, 0.12, 6, 40),
				this.track(neon(i ? VIO : MAG, 1.6)),
			)
			ring.rotation.x = Math.PI / 2 + (i ? 0.5 : -0.4)
			this.group.add(ring)
			this.orbits.push(ring)
		}

		// hover thrusters
		this.thrusters = []
		for (const s of [-1, 1]) {
			const th = new THREE.Mesh(
				new THREE.ConeGeometry(0.55, 2.4, 10, 1, true),
				new THREE.MeshBasicMaterial({
					color: 0x9fe9ff,
					transparent: true,
					opacity: 0.6,
					blending: THREE.AdditiveBlending,
					depthWrite: false,
					side: THREE.DoubleSide,
				}),
			)
			th.position.set(s * 1.3, -2.4, -0.6)
			th.rotation.x = Math.PI
			this.group.add(th)
			this.thrusters.push(th)
		}
	}

	update(dt) {
		if (this.dying) {
			this.dieT += dt
			// long, dramatic boss death
			if (Math.random() < dt * 22) {
				this.game.fx.explosion(
					_v.copy(this.pos).add(new THREE.Vector3(rand(-3, 3), rand(-2, 3), rand(-3, 3))),
					Math.random() < 0.5 ? MAG : 0xffa23c,
					1.2,
				)
				this.game.audio.explode(1.2)
			}
			this.group.rotation.z += dt * 1.2
			this.group.rotation.x += dt * 0.5
			this.pos.y -= dt * 3
			this.group.position.copy(this.pos)
			if (this.dieT > 2) {
				this.game.fx.explosion(this.pos, 0xfff0b0, 3.4)
				this.game.fx.nova(this.pos)
				this.game.audio.explode(2)
				this.game.shake(1.4)
				this.remove()
			}
			return
		}

		this.t += dt
		this._flash(dt)
		const hpFrac = this.hp / this.maxHp
		if (this.phase === 1 && hpFrac < 0.55) {
			this.phase = 2
			this.state = "enrage"
			this.stateT = 1.6
			this.game.banner("PHASE 2", "MOLTBOT PRIME IS ENRAGED")
			this.game.audio.bossSpawn()
			this.game.fx.nova(this.pos)
			this.game.shake(1)
		}

		// hover + face the hero
		const baseY = this.game.world.padTop + 7
		const targetY = baseY + Math.sin(this.t * 0.9) * 0.8
		this.pos.y = damp(this.pos.y, targetY, 0.002, dt)
		const toH = _v.set(this.heroPos.x - this.pos.x, 0, this.heroPos.z - this.pos.z)
		const dist = toH.length()
		toH.normalize()

		this.stateT -= dt
		const rate = this.phase === 2 ? 1.5 : 1

		switch (this.state) {
			case "idle": {
				// drift to keep a mid distance
				const want = 20
				const move = clamp((dist - want) * 0.5, -5, 5) * rate
				this.vel.x = damp(this.vel.x, toH.x * move, 0.002, dt)
				this.vel.z = damp(this.vel.z, toH.z * move, 0.002, dt)
				if (this.stateT <= 0) {
					const opts = this.phase === 2 ? ["spiral", "volley", "summon", "sweep"] : ["volley", "spiral", "summon"]
					this.state = opts[Math.floor(Math.random() * opts.length)]
					this.stateT = this.state === "summon" ? 1.4 : this.state === "sweep" ? 3.2 : 2.6
					this.spiral = 0
					this.shotT = 0
					if (this.state === "sweep") this.game.banner("", "INCOMING SWEEP")
				}
				break
			}
			case "volley": {
				this.vel.multiplyScalar(0.92)
				this.shotT -= dt
				if (this.shotT <= 0) {
					this.shotT = 0.26 / rate
					for (const arm of this.arms) {
						arm.tip.getWorldPosition(_v)
						const dir = _v2.copy(this.heroPos).setY(this.heroPos.y + 1).sub(_v).normalize()
						dir.x += rand(-0.05, 0.05)
						dir.y += rand(-0.03, 0.03)
						this.game.projectiles.fireEnemy(_v, dir.normalize(), {
							speed: 38,
							damage: 11,
							scale: 1.3,
						})
					}
					this.game.audio.shoot()
				}
				if (this.stateT <= 0) {
					this.state = "idle"
					this.stateT = rand(0.8, 1.5) / rate
				}
				break
			}
			case "spiral": {
				this.vel.multiplyScalar(0.94)
				this.shotT -= dt
				if (this.shotT <= 0) {
					this.shotT = 0.075 / rate
					this.spiral += 0.42
					const arms = this.phase === 2 ? 4 : 3
					for (let i = 0; i < arms; i++) {
						const a = this.spiral + (i / arms) * TAU
						const dir = _v2.set(Math.cos(a), rand(-0.06, 0.1), Math.sin(a)).normalize()
						this.game.projectiles.fireEnemy(
							_v.copy(this.pos).setY(this.pos.y - 0.4),
							dir,
							{ speed: 19, damage: 8, scale: 1.1, life: 6 },
						)
					}
				}
				if (this.stateT <= 0) {
					this.state = "idle"
					this.stateT = rand(1, 1.6) / rate
				}
				break
			}
			case "summon": {
				this.vel.multiplyScalar(0.9)
				if (this.stateT <= 0) {
					const n = this.phase === 2 ? 4 : 3
					for (let i = 0; i < n; i++) {
						const a = (i / n) * TAU
						const p = new THREE.Vector3(Math.cos(a) * 12, 0, Math.sin(a) * 12).add(this.pos)
						this.game.spawnEnemy(Math.random() < 0.5 ? Zipper : Skitter, p)
						this.game.fx.ringBurst(p, VIO, 1.4)
					}
					this.game.audio.bossSpawn()
					this.state = "idle"
					this.stateT = 1.2
				}
				break
			}
			case "sweep": {
				// slow rotating death laser
				this.vel.multiplyScalar(0.95)
				const a = this.t * 1.5
				for (let i = 0; i < 2; i++) {
					const ang = a + i * Math.PI
					const dir = _v2.set(Math.cos(ang), 0, Math.sin(ang))
					const end = _v.copy(this.pos).addScaledVector(dir, 40)
					this.game.fx.beam(this.pos, end, 0.22, 0xff3aa0, 0.12)
					// damage anything the beam line passes through
					const toHero = new THREE.Vector3().copy(this.heroPos).setY(this.pos.y).sub(this.pos)
					const along = toHero.dot(dir)
					if (along > 0 && along < 40) {
						const perp = Math.sqrt(Math.max(0, toHero.lengthSq() - along * along))
						const dy = Math.abs(this.heroPos.y + 1 - this.pos.y)
						if (perp < 1.4 && dy < 2.6) {
							if (this.game.hero.damage(13, this.pos)) this.game.onHeroHit(13)
						}
					}
				}
				if (this.stateT <= 0) {
					this.state = "idle"
					this.stateT = 1.4
				}
				break
			}
			case "enrage": {
				this.vel.multiplyScalar(0.9)
				if (Math.random() < dt * 30) {
					this.game.fx.impact(
						_v.copy(this.pos).add(new THREE.Vector3(rand(-3, 3), rand(-3, 3), rand(-3, 3))),
						_v2.set(0, 1, 0),
						MAG,
						0.8,
					)
				}
				if (this.stateT <= 0) {
					this.state = "idle"
					this.stateT = 0.5
					this.game.projectiles.clearEnemyBolts()
				}
				break
			}
		}

		this.pos.addScaledVector(this.vel, dt)
		const rr = Math.hypot(this.pos.x, this.pos.z)
		const maxR = this.game.world.radius - 12
		if (rr > maxR) {
			this.pos.x *= maxR / rr
			this.pos.z *= maxR / rr
		}
		this.group.position.copy(this.pos)
		this.center.copy(this.pos)
		this.faceHero(dt, 2.4)

		// idle motion
		this.orbits[0].rotation.z += dt * 0.8
		this.orbits[1].rotation.z -= dt * 1.1
		this.core.rotation.y += dt * 1.6
		this.core.rotation.x += dt * 0.9
		this.core.scale.setScalar(1 + Math.sin(this.t * 4) * 0.07)
		this.eye.material.emissiveIntensity = this.phase === 2 ? 4 + Math.sin(this.t * 12) * 2 : 3.2
		for (const arm of this.arms) {
			arm.shoulder.rotation.x = damp(
				arm.shoulder.rotation.x,
				this.state === "volley" ? -0.3 : Math.sin(this.t * 1.2 + arm.s) * 0.06,
				0.002,
				dt,
			)
		}
		for (const th of this.thrusters) {
			th.scale.setScalar(0.85 + Math.random() * 0.35)
			th.material.opacity = 0.45 + Math.random() * 0.3
		}
	}
}

export const GRUNTS = { Skitter, Brute, Lancer, Zipper }
