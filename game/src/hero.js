// Captain Danylo — the hero rig, his movement and his abilities.
// Everything is built from primitives and animated procedurally (no model files).

import * as THREE from "three"
import { angleDelta, clamp, damp, lerp, rand, TAU } from "./util.js"

const SKIN = "#f6c9a0"
const SKIN_SHADE = "#e0a87e"
const HAIR = 0xe8bd63
const SUIT = 0xff7a1a
const SUIT_DARK = 0xd1500b
const WHITE = 0xf2f4ff
const CYAN = 0x31e6ff

/**
 * Draws the stylised Danylo face — spiky-haired kid with freckles, a wide grin
 * and a hero mask. Reused for both the 3D head and the HUD portrait.
 */
export function drawFace(x, S, { portrait = false } = {}) {
	x.clearRect(0, 0, S, S)
	const u = S / 256

	if (portrait) {
		const g = x.createLinearGradient(0, 0, 0, S)
		g.addColorStop(0, "#301a52")
		g.addColorStop(1, "#160d2c")
		x.fillStyle = g
		x.fillRect(0, 0, S, S)
	}

	// head shape
	x.fillStyle = SKIN
	if (portrait) {
		x.beginPath()
		x.ellipse(128 * u, 150 * u, 76 * u, 84 * u, 0, 0, TAU)
		x.fill()
	} else {
		x.fillRect(0, 0, S, S)
	}

	// cheek warmth
	const cheek = x.createRadialGradient(70 * u, 168 * u, 4 * u, 70 * u, 168 * u, 40 * u)
	cheek.addColorStop(0, "rgba(255,138,110,0.42)")
	cheek.addColorStop(1, "rgba(255,138,110,0)")
	x.fillStyle = cheek
	x.fillRect(20 * u, 128 * u, 100 * u, 90 * u)
	const cheek2 = x.createRadialGradient(186 * u, 168 * u, 4 * u, 186 * u, 168 * u, 40 * u)
	cheek2.addColorStop(0, "rgba(255,138,110,0.42)")
	cheek2.addColorStop(1, "rgba(255,138,110,0)")
	x.fillStyle = cheek2
	x.fillRect(136 * u, 128 * u, 100 * u, 90 * u)

	// hero mask across the eyes
	x.fillStyle = "#ff7a1a"
	x.beginPath()
	x.moveTo(16 * u, 96 * u)
	x.quadraticCurveTo(128 * u, 62 * u, 240 * u, 96 * u)
	x.quadraticCurveTo(236 * u, 136 * u, 196 * u, 142 * u)
	x.quadraticCurveTo(128 * u, 128 * u, 60 * u, 142 * u)
	x.quadraticCurveTo(20 * u, 136 * u, 16 * u, 96 * u)
	x.closePath()
	x.fill()
	x.strokeStyle = "rgba(120,40,0,0.5)"
	x.lineWidth = 3 * u
	x.stroke()

	// eye holes + eyes
	for (const ex of [88, 168]) {
		x.fillStyle = "#1a0d05"
		x.beginPath()
		x.ellipse(ex * u, 106 * u, 30 * u, 22 * u, 0, 0, TAU)
		x.fill()
		x.fillStyle = "#ffffff"
		x.beginPath()
		x.ellipse(ex * u, 107 * u, 25 * u, 18 * u, 0, 0, TAU)
		x.fill()
		// iris — blue-green, like the photo
		x.fillStyle = "#3f9fd6"
		x.beginPath()
		x.arc(ex * u, 108 * u, 12 * u, 0, TAU)
		x.fill()
		x.fillStyle = "#0d2436"
		x.beginPath()
		x.arc(ex * u, 108 * u, 6 * u, 0, TAU)
		x.fill()
		x.fillStyle = "rgba(255,255,255,0.95)"
		x.beginPath()
		x.arc((ex - 6) * u, 103 * u, 4 * u, 0, TAU)
		x.fill()
	}

	// brows — determined
	x.strokeStyle = "#a9742c"
	x.lineWidth = 6 * u
	x.lineCap = "round"
	x.beginPath()
	x.moveTo(66 * u, 80 * u)
	x.lineTo(110 * u, 74 * u)
	x.moveTo(190 * u, 80 * u)
	x.lineTo(146 * u, 74 * u)
	x.stroke()

	// nose
	x.strokeStyle = SKIN_SHADE
	x.lineWidth = 5 * u
	x.beginPath()
	x.moveTo(128 * u, 148 * u)
	x.lineTo(122 * u, 166 * u)
	x.lineTo(134 * u, 168 * u)
	x.stroke()

	// freckles
	x.fillStyle = "rgba(178,104,58,0.75)"
	const spots = [
		[74, 160], [86, 172], [64, 176], [96, 158], [80, 186], [100, 178],
		[182, 160], [170, 172], [192, 176], [160, 158], [176, 186], [156, 178],
		[112, 156], [144, 156],
	]
	for (const [fx, fy] of spots) {
		x.beginPath()
		x.arc(fx * u, fy * u, rand(2.2, 3.6) * u, 0, TAU)
		x.fill()
	}

	// big confident grin
	x.strokeStyle = "#7a2a1c"
	x.lineWidth = 7 * u
	x.beginPath()
	x.arc(128 * u, 182 * u, 40 * u, 0.22 * Math.PI, 0.78 * Math.PI)
	x.stroke()
	x.fillStyle = "#ffffff"
	x.beginPath()
	x.moveTo(100 * u, 200 * u)
	x.quadraticCurveTo(128 * u, 208 * u, 156 * u, 200 * u)
	x.quadraticCurveTo(128 * u, 196 * u, 100 * u, 200 * u)
	x.fill()

	if (portrait) {
		// hair tuft on top for the portrait silhouette
		x.fillStyle = "#e8bd63"
		for (let i = 0; i < 11; i++) {
			const px = 54 + i * 15
			const h = 40 + Math.sin(i * 1.7) * 24
			x.beginPath()
			x.moveTo(px * u, 84 * u)
			x.lineTo((px + 7 + Math.sin(i) * 5) * u, (84 - h) * u)
			x.lineTo((px + 16) * u, 84 * u)
			x.closePath()
			x.fill()
		}
		x.fillStyle = "#e8bd63"
		x.beginPath()
		x.ellipse(128 * u, 96 * u, 78 * u, 40 * u, 0, Math.PI, TAU)
		x.fill()
	}
}

function faceTexture() {
	const c = document.createElement("canvas")
	c.width = c.height = 256
	drawFace(c.getContext("2d"), 256)
	const t = new THREE.CanvasTexture(c)
	t.colorSpace = THREE.SRGBColorSpace
	return t
}

function emblemTexture() {
	const S = 256
	const c = document.createElement("canvas")
	c.width = c.height = S
	const x = c.getContext("2d")
	x.fillStyle = "#f2f4ff"
	x.fillRect(0, 0, S, S)
	x.fillStyle = "#ff7a1a"
	x.beginPath()
	x.moveTo(128, 14)
	x.lineTo(232, 96)
	x.lineTo(196, 226)
	x.lineTo(60, 226)
	x.lineTo(24, 96)
	x.closePath()
	x.fill()
	// lightning "D"
	x.fillStyle = "#31e6ff"
	x.beginPath()
	x.moveTo(112, 42)
	x.lineTo(178, 42)
	x.lineTo(132, 116)
	x.lineTo(176, 116)
	x.lineTo(88, 214)
	x.lineTo(116, 132)
	x.lineTo(74, 132)
	x.closePath()
	x.fill()
	const t = new THREE.CanvasTexture(c)
	t.colorSpace = THREE.SRGBColorSpace
	return t
}

const mkStd = (color, opts = {}) =>
	new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.15, ...opts })

export class Hero {
	constructor(scene, world, fx, audio) {
		this.scene = scene
		this.world = world
		this.fx = fx
		this.audio = audio

		this.pos = new THREE.Vector3(0, 0, 18)
		this.vel = new THREE.Vector3()
		this.yaw = Math.PI
		this.aimPitch = 0
		this.grounded = true
		this.coyote = 0
		this.jumpsLeft = 2
		this.phase = 0 // run cycle
		this.lean = 0
		this.strafeLean = 0

		this.maxHp = 120
		this.hp = this.maxHp
		this.maxEnergy = 100
		this.energy = this.maxEnergy
		this.ult = 0
		this.maxUlt = 100

		this.dashCd = 0
		this.iframes = 0
		this.fireCd = 0
		this.charge = 0
		this.charging = false
		this.chargeSfx = null
		this.flying = false
		this.hurtFlash = 0
		this.dead = false
		this.novaTime = 0
		this.handSide = 1
		this.recoil = 0
		this.spawnGrace = 1.5
		this.dashTime = 0
		this.deathT = 0
		this.armBlend = 0
		this.fallSpeed = 0

		this._build()
		this._tmp = new THREE.Vector3()
		this._q = new THREE.Quaternion()
	}

	// ------------------------------------------------------------ rig
	_build() {
		const root = new THREE.Group()
		this.root = root
		this.scene.add(root)

		const body = new THREE.Group()
		this.body = body
		root.add(body)

		const suitMat = mkStd(SUIT, { emissive: 0x3a1400, emissiveIntensity: 0.5 })
		const suitDark = mkStd(SUIT_DARK, { metalness: 0.35, roughness: 0.4 })
		const whiteMat = mkStd(WHITE, { roughness: 0.35 })
		const glowMat = new THREE.MeshStandardMaterial({
			color: CYAN,
			emissive: CYAN,
			emissiveIntensity: 2.6,
			roughness: 0.3,
		})
		this.glowMat = glowMat
		this.suitMat = suitMat
		this.materials = [suitMat, suitDark, whiteMat]

		// Only the big silhouette pieces cast; spikes, gloves and pads add ~30
		// shadow-pass draw calls for a difference nobody can see.
		const cast = (m) => {
			m.castShadow = true
			return m
		}

		// ---- pelvis + legs
		const pelvis = new THREE.Group()
		pelvis.position.y = 0.86
		body.add(pelvis)
		this.pelvis = pelvis
		pelvis.add(cast(new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.3, 0.36), suitDark)))

		this.legs = []
		for (const side of [-1, 1]) {
			const hip = new THREE.Group()
			hip.position.set(side * 0.17, -0.1, 0)
			pelvis.add(hip)
			const thigh = cast(new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.44, 0.26), suitMat))
			thigh.position.y = -0.22
			hip.add(thigh)
			const knee = new THREE.Group()
			knee.position.y = -0.44
			hip.add(knee)
			const shin = cast(new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.4, 0.23), suitDark))
			shin.position.y = -0.2
			knee.add(shin)
			const boot = cast(new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.2, 0.42), whiteMat))
			boot.position.set(0, -0.46, 0.06)
			knee.add(boot)
			const sole = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.06, 0.36), glowMat)
			sole.position.set(0, -0.55, 0.06)
			knee.add(sole)
			// jet flare under the boot, only visible while flying
			const jet = new THREE.Mesh(
				new THREE.ConeGeometry(0.13, 0.75, 8, 1, true),
				new THREE.MeshBasicMaterial({
					color: 0x9fe9ff,
					transparent: true,
					opacity: 0.9,
					blending: THREE.AdditiveBlending,
					depthWrite: false,
					side: THREE.DoubleSide,
				}),
			)
			jet.position.set(0, -0.95, 0.06)
			jet.rotation.x = Math.PI
			jet.visible = false
			knee.add(jet)
			this.legs.push({ hip, knee, jet, side })
		}

		// ---- chest
		const chest = new THREE.Group()
		chest.position.y = 0.14
		pelvis.add(chest)
		this.chest = chest

		const torso = cast(new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.72, 0.42), suitMat))
		torso.position.y = 0.34
		chest.add(torso)

		const emblem = new THREE.Mesh(
			new THREE.PlaneGeometry(0.34, 0.34),
			new THREE.MeshStandardMaterial({
				map: emblemTexture(),
				emissiveMap: emblemTexture(),
				emissive: 0xffffff,
				emissiveIntensity: 0.9,
				roughness: 0.4,
			}),
		)
		emblem.position.set(0, 0.4, 0.215)
		chest.add(emblem)
		this.emblem = emblem

		// belt
		const belt = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.13, 0.46), whiteMat)
		belt.position.y = 0.02
		chest.add(belt)
		const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.11, 0.06), glowMat)
		buckle.position.set(0, 0.02, 0.24)
		chest.add(buckle)

		// shoulder pads
		for (const side of [-1, 1]) {
			const pad = cast(new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.2, 0.36), whiteMat))
			pad.position.set(side * 0.44, 0.6, 0)
			chest.add(pad)
		}

		// ---- head
		const neck = new THREE.Group()
		neck.position.y = 0.78
		chest.add(neck)
		this.neck = neck

		const head = cast(
			new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.52, 0.5), [
				mkStd(0xf6c9a0),
				mkStd(0xf6c9a0),
				mkStd(0xf6c9a0),
				mkStd(0xf6c9a0),
				new THREE.MeshStandardMaterial({ map: faceTexture(), roughness: 0.65 }),
				mkStd(0xe8b98e),
			]),
		)
		head.position.y = 0.28
		neck.add(head)
		this.head = head

		// ears
		for (const side of [-1, 1]) {
			const ear = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.15, 0.12), mkStd(0xf0bd92))
			ear.position.set(side * 0.28, 0.26, -0.02)
			neck.add(ear)
		}

		// spiky blond hair
		const hairMat = mkStd(HAIR, { roughness: 0.75 })
		const hairMat2 = mkStd(0xf5d68d, { roughness: 0.75 })
		const cap = cast(new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.18, 0.52), hairMat))
		cap.position.y = 0.51
		neck.add(cap)
		const back = cast(new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.3, 0.12), hairMat))
		back.position.set(0, 0.36, -0.22)
		neck.add(back)

		this.hairSpikes = []
		for (let i = 0; i < 16; i++) {
			const spike = new THREE.Mesh(
				new THREE.ConeGeometry(rand(0.07, 0.12), rand(0.3, 0.58), 4),
				i % 3 === 0 ? hairMat2 : hairMat,
			)
			const ax = rand(-0.22, 0.22)
			const az = rand(-0.24, 0.2)
			spike.position.set(ax, 0.6 + rand(0, 0.05), az)
			spike.rotation.set(0.25 + az * 1.6 + rand(-0.3, 0.3), rand(0, TAU), rand(-0.45, 0.45) - ax * 1.9)
			spike.userData.base = spike.rotation.clone()
			neck.add(spike)
			this.hairSpikes.push(spike)
		}

		// ---- arms
		this.arms = []
		for (const side of [-1, 1]) {
			const shoulder = new THREE.Group()
			shoulder.position.set(side * 0.44, 0.58, 0)
			chest.add(shoulder)
			const upper = cast(new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.4, 0.19), suitMat))
			upper.position.y = -0.2
			shoulder.add(upper)
			const elbow = new THREE.Group()
			elbow.position.y = -0.4
			shoulder.add(elbow)
			const fore = cast(new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.36, 0.17), mkStd(0xf6c9a0)))
			fore.position.y = -0.18
			elbow.add(fore)
			const glove = cast(new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.22, 0.23), suitDark))
			glove.position.y = -0.44
			elbow.add(glove)
			const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.035, 6, 12), glowMat)
			cuff.rotation.x = Math.PI / 2
			cuff.position.y = -0.34
			elbow.add(cuff)

			// palm emitter — muzzle origin
			const emitter = new THREE.Mesh(
				new THREE.SphereGeometry(0.09, 10, 10),
				new THREE.MeshBasicMaterial({ color: 0xbff4ff }),
			)
			emitter.position.set(0, -0.52, 0.06)
			elbow.add(emitter)
			const flash = new THREE.Mesh(
				new THREE.SphereGeometry(0.26, 10, 10),
				new THREE.MeshBasicMaterial({
					color: 0xfff0c0,
					transparent: true,
					opacity: 0,
					blending: THREE.AdditiveBlending,
					depthWrite: false,
				}),
			)
			flash.position.copy(emitter.position)
			elbow.add(flash)

			this.arms.push({ shoulder, elbow, emitter, flash, side })
		}

		// ---- cape
		this.capeLen = 1.15
		this.capeHalf = this.capeLen / 2
		const capeGeo = new THREE.PlaneGeometry(0.74, this.capeLen, 8, 12)
		this.capeBase = capeGeo.attributes.position.array.slice()
		const capeMat = new THREE.MeshStandardMaterial({
			color: 0xe03a12,
			side: THREE.DoubleSide,
			roughness: 0.72,
			metalness: 0.05,
			emissive: 0x431000,
			emissiveIntensity: 0.6,
		})
		const cape = new THREE.Mesh(capeGeo, capeMat)
		cape.position.set(0, 0.03, -0.25)
		capeGeo.translate(0, -this.capeHalf, 0)
		const capeAnchor = new THREE.Group()
		capeAnchor.position.set(0, 0.66, -0.24)
		chest.add(capeAnchor)
		capeAnchor.add(cape)
		cape.position.set(0, 0, 0)
		this.cape = cape
		this.capeAnchor = capeAnchor

		// ---- aura + shadow blob
		// Fresnel shell — glows at the silhouette instead of fogging him out.
		const auraMat = new THREE.ShaderMaterial({
			transparent: true,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
			uniforms: {
				uColor: { value: new THREE.Color(0xffa23c) },
				uStrength: { value: 0 },
			},
			vertexShader: /* glsl */ `
				varying vec3 vN;
				varying vec3 vV;
				void main() {
					vec4 mv = modelViewMatrix * vec4(position, 1.0);
					vN = normalMatrix * normal;
					vV = -mv.xyz;
					gl_Position = projectionMatrix * mv;
				}
			`,
			fragmentShader: /* glsl */ `
				varying vec3 vN;
				varying vec3 vV;
				uniform vec3 uColor;
				uniform float uStrength;
				void main() {
					float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
					f = pow(clamp(f, 0.0, 1.0), 2.2);
					gl_FragColor = vec4(uColor * f * uStrength * 2.2, f * uStrength);
				}
			`,
		})
		// keep an `opacity`-like handle so the pose code reads naturally
		Object.defineProperty(auraMat, "opacity", {
			get: () => auraMat.uniforms.uStrength.value,
			set: (v) => (auraMat.uniforms.uStrength.value = v),
		})
		auraMat.color = auraMat.uniforms.uColor.value
		const aura = new THREE.Mesh(new THREE.SphereGeometry(1.45, 24, 18), auraMat)
		aura.position.y = 0.95
		root.add(aura)
		this.aura = aura

		// a personal light so he always pops against the neon
		this.light = new THREE.PointLight(0xffb46a, 5, 11, 2)
		this.light.position.set(0, 1.9, 1.1)
		root.add(this.light)
	}

	// ------------------------------------------------------------ helpers
	get eye() {
		return this._tmp.set(this.pos.x, this.pos.y + 1.45, this.pos.z)
	}

	handWorld(out, side = this.handSide) {
		const arm = this.arms[side > 0 ? 1 : 0]
		arm.emitter.getWorldPosition(out)
		return out
	}

	reset() {
		this.pos.set(0, 0.2, 18)
		this.vel.set(0, 0, 0)
		this.hp = this.maxHp
		this.energy = this.maxEnergy
		this.ult = 0
		this.dead = false
		this.charge = 0
		this.charging = false
		this.iframes = 0
		this.hurtFlash = 0
		this.dashCd = 0
		this.jumpsLeft = 2
		this.spawnGrace = 1.5
		this.dashTime = 0
		this.deathT = 0
		this.armBlend = 0
		this.fallSpeed = 0
		this.novaTime = 0
		this.recoil = 0
		this.light.intensity = 5
		this.aura.material.opacity = 0
		this.root.visible = true
		this.root.rotation.set(0, 0, 0)
	}

	// ------------------------------------------------------------ combat
	damage(amount, fromPos) {
		if (this.dead || this.iframes > 0 || this.spawnGrace > 0) return false
		this.hp = Math.max(0, this.hp - amount)
		this.hurtFlash = 1
		this.iframes = 0.45
		this.audio.hurt()
		if (fromPos) {
			const kb = this._tmp.copy(this.pos).sub(fromPos).setY(0)
			if (kb.lengthSq() > 0.0001) kb.normalize().multiplyScalar(6)
			this.vel.x += kb.x
			this.vel.z += kb.z
		}
		if (this.hp <= 0) this.dead = true
		return true
	}

	heal(v) {
		this.hp = Math.min(this.maxHp, this.hp + v)
	}

	addEnergy(v) {
		this.energy = Math.min(this.maxEnergy, this.energy + v)
	}

	addUlt(v) {
		this.ult = Math.min(this.maxUlt, this.ult + v)
	}

	get ultReady() {
		return this.ult >= this.maxUlt
	}

	// ------------------------------------------------------------ update
	update(dt, input, ctx) {
		if (this.dead) {
			this._updateDeath(dt)
			return
		}

		const t = ctx.time
		this.spawnGrace = Math.max(0, this.spawnGrace - dt)
		this.iframes = Math.max(0, this.iframes - dt)
		this.dashCd = Math.max(0, this.dashCd - dt)
		this.fireCd = Math.max(0, this.fireCd - dt)
		this.hurtFlash = Math.max(0, this.hurtFlash - dt * 3)
		this.recoil = Math.max(0, this.recoil - dt * 6)
		this.novaTime = Math.max(0, this.novaTime - dt)

		// ---------------- movement input relative to camera yaw
		const ax = input.axes()
		const camYaw = ctx.camYaw
		const fwd = this._tmp.set(-Math.sin(camYaw), 0, -Math.cos(camYaw))
		const right = new THREE.Vector3(Math.cos(camYaw), 0, -Math.sin(camYaw))
		const wish = new THREE.Vector3()
			.addScaledVector(fwd, ax.y)
			.addScaledVector(right, ax.x)
		const moving = wish.lengthSq() > 0.001
		if (moving) wish.normalize()

		// ---------------- dash
		if (input.once("ShiftLeft") || input.once("ShiftRight")) this._tryDash(wish, moving, ctx)

		// ---------------- jump / flight
		const wantUp = input.down("Space")
		if (input.once("Space")) {
			if (this.grounded || this.coyote > 0) {
				this.vel.y = 12
				this.jumpsLeft = 1
				this.grounded = false
				this.coyote = 0
				this.audio.jump()
				this.fx.ringBurst(this.pos, 0x9fe9ff, 1.1)
			} else if (this.jumpsLeft > 0) {
				this.jumpsLeft--
				this.vel.y = 11
				this.audio.jump()
				this.fx.ringBurst(this.pos, 0x31e6ff, 1.5)
			}
		}

		this.flying = false
		if (wantUp && !this.grounded && this.energy > 1 && this.vel.y < 14) {
			this.flying = true
			this.vel.y += 40 * dt
			this.vel.y = Math.min(this.vel.y, 12)
			this.energy = Math.max(0, this.energy - 26 * dt)
			if (Math.random() < dt * 26) this.audio.thruster()
			this.fx.thruster(this.pos, this.legs)
		}

		// ---------------- horizontal accel
		const maxSpeed = this.dashTime > 0 ? 30 : 12.5
		const accel = this.grounded ? 78 : 34
		const target = wish.multiplyScalar(moving ? maxSpeed : 0)
		if (this.dashTime > 0) {
			this.dashTime -= dt
		} else {
			this.vel.x = damp(this.vel.x, target.x, moving ? 0.0008 : 0.0002, dt * (accel / 60))
			this.vel.z = damp(this.vel.z, target.z, moving ? 0.0008 : 0.0002, dt * (accel / 60))
			// snappier response than pure damping gives
			this.vel.x += (target.x - this.vel.x) * clamp(accel * dt * 0.12, 0, 1)
			this.vel.z += (target.z - this.vel.z) * clamp(accel * dt * 0.12, 0, 1)
		}

		// gravity (lighter while gliding upward-ish)
		const g = this.flying ? 10 : this.vel.y < 0 && wantUp ? 16 : 27
		this.vel.y -= g * dt

		// ---------------- integrate + collide
		this.pos.addScaledVector(this.vel, dt)
		const wasGrounded = this.grounded
		const res = this.world.resolve(this.pos, this.vel, 0.55)
		this.grounded = res.grounded
		if (this.grounded) {
			this.jumpsLeft = 2
			this.coyote = 0.14
			if (!wasGrounded && this.fallSpeed < -14) {
				this.fx.ringBurst(this.pos, 0xffa23c, 1.6)
				ctx.shake(0.3)
			}
		} else {
			this.coyote = Math.max(0, this.coyote - dt)
		}
		this.fallSpeed = this.vel.y

		// fell off the world → teleport home, lose some health
		if (this.pos.y < -40) {
			this.pos.set(0, 26, 0)
			this.vel.set(0, 0, 0)
			this.hp = Math.max(1, this.hp - 15)
			this.hurtFlash = 1
			this.audio.hurt()
			ctx.shake(0.5)
		}

		// ---------------- energy regen
		if (!this.flying) this.energy = Math.min(this.maxEnergy, this.energy + 20 * dt)

		// ---------------- weapons
		this._updateWeapons(dt, input, ctx)

		// ---------------- pose
		this._pose(dt, t, ax, moving, ctx)
	}

	_tryDash(wish, moving, ctx) {
		if (this.dashCd > 0 || this.energy < 22) return
		const dir = moving
			? wish.clone()
			: new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw))
		this.vel.x = dir.x * 34
		this.vel.z = dir.z * 34
		if (!this.grounded) this.vel.y = Math.max(this.vel.y, 2)
		this.dashTime = 0.19
		this.dashCd = 0.85
		this.iframes = Math.max(this.iframes, 0.3)
		this.energy -= 22
		this.audio.dash()
		this.fx.dashTrail(this.pos, dir)
		ctx.shake(0.18)
		ctx.fovKick(9)
	}

	_updateWeapons(dt, input, ctx) {
		// primary — alternating palm bolts
		if (ctx.firing && this.fireCd <= 0 && !this.charging) {
			this.fireCd = 0.11
			this.handSide = -this.handSide
			const origin = this.handWorld(new THREE.Vector3())
			ctx.fireBolt(origin, ctx.aimPoint, this.handSide)
			this.recoil = 1
			this.arms[this.handSide > 0 ? 1 : 0].flash.material.opacity = 1
			this.audio.shoot()
			this.vel.x -= ctx.aimDir.x * 0.35
			this.vel.z -= ctx.aimDir.z * 0.35
			ctx.shake(0.045)
		}

		// secondary — hold to charge, release to fire the Nectar Beam
		if (input.mouse.rightPressed && this.energy > 12) {
			this.charging = true
			this.charge = 0
			this.chargeSfx = this.audio.beamCharge()
		}
		if (this.charging) {
			if (input.mouse.right && this.energy > 0) {
				this.charge = Math.min(1, this.charge + dt / 1.05)
				this.energy = Math.max(0, this.energy - 14 * dt)
				const p = this.handWorld(new THREE.Vector3(), 1)
				this.fx.chargeSparks(p, this.charge)
				for (const a of this.arms) a.flash.material.opacity = 0.25 + this.charge * 0.5
			} else {
				this.charging = false
				this.chargeSfx?.stop()
				this.chargeSfx = null
				if (this.charge > 0.18) {
					ctx.fireBeam(this.charge)
					this.audio.beamFire(0.6 + this.charge)
					ctx.shake(0.2 + this.charge * 0.5)
					ctx.fovKick(6 + this.charge * 10)
					const back = ctx.aimDir
					this.vel.x -= back.x * 6 * this.charge
					this.vel.z -= back.z * 6 * this.charge
				}
				this.charge = 0
			}
		}

		// ultimate
		if (input.once("KeyQ") && this.ultReady) {
			this.ult = 0
			this.novaTime = 1.1
			ctx.fireNova()
		}
	}

	// ------------------------------------------------------------ posing
	_pose(dt, t, ax, moving, ctx) {
		// face where the camera looks (over-the-shoulder shooter feel)
		const targetYaw = ctx.camYaw + Math.PI
		this.yaw += angleDelta(this.yaw, targetYaw) * clamp(dt * 16, 0, 1)
		this.root.position.copy(this.pos)
		this.body.rotation.y = this.yaw

		const speed = Math.hypot(this.vel.x, this.vel.z)
		const speed01 = clamp(speed / 12.5, 0, 1.4)

		// run cycle
		this.phase += dt * (4 + speed * 0.85)
		const swing = Math.sin(this.phase)
		const swing2 = Math.sin(this.phase * 2)

		const airborne = !this.grounded
		const flying = this.flying || (airborne && this.vel.y > 1)

		// legs
		for (const leg of this.legs) {
			const s = leg.side
			let hipX
			let kneeX
			if (airborne) {
				if (flying) {
					hipX = lerp(-0.15, 0.2, (s + 1) / 2) - 0.25
					kneeX = 0.55 + s * 0.12
				} else {
					hipX = -0.5 + s * 0.18
					kneeX = 0.85
				}
			} else if (moving) {
				hipX = swing * s * 0.85 * speed01
				kneeX = Math.max(0, -swing * s) * 1.15 * speed01
			} else {
				hipX = Math.sin(t * 1.6) * 0.03 + s * 0.02
				kneeX = 0.05
			}
			leg.hip.rotation.x = damp(leg.hip.rotation.x, hipX, 0.0005, dt)
			leg.knee.rotation.x = damp(leg.knee.rotation.x, kneeX, 0.0005, dt)
			leg.hip.rotation.z = damp(leg.hip.rotation.z, -this.strafeLean * 0.4 * s, 0.001, dt)
			leg.jet.visible = this.flying
			if (this.flying) {
				leg.jet.scale.setScalar(0.8 + Math.random() * 0.5)
				leg.jet.material.opacity = 0.55 + Math.random() * 0.45
			}
		}

		// torso lean into movement
		const localFwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw))
		const localRight = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
		const fdot = this.vel.x * localFwd.x + this.vel.z * localFwd.z
		const rdot = this.vel.x * localRight.x + this.vel.z * localRight.z
		this.lean = damp(this.lean, clamp(fdot / 26, -0.45, 0.45), 0.0005, dt)
		this.strafeLean = damp(this.strafeLean, clamp(rdot / 30, -0.4, 0.4), 0.0005, dt)
		this.pelvis.rotation.x = this.lean - this.recoil * 0.08
		this.pelvis.rotation.z = -this.strafeLean
		this.pelvis.position.y = 0.86 + (moving && !airborne ? Math.abs(swing2) * 0.055 : Math.sin(t * 1.7) * 0.02)

		// head tracks the aim point
		const pitch = clamp(ctx.camPitch, -0.7, 0.6)
		this.neck.rotation.x = damp(this.neck.rotation.x, -pitch * 0.55 - this.lean * 0.6, 0.0005, dt)
		this.neck.rotation.z = damp(this.neck.rotation.z, this.strafeLean * 0.35, 0.001, dt)

		// arms
		const shootingBlend = clamp(
			(ctx.firing ? 1 : 0) + (this.charging ? 1 : 0) + this.recoil,
			0,
			1,
		)
		this.armBlend = damp(this.armBlend ?? 0, shootingBlend, 0.0009, dt)

		for (let i = 0; i < 2; i++) {
			const arm = this.arms[i]
			const s = arm.side
			// idle/run swing
			let sx = airborne ? (flying ? -2.35 : -0.55) : moving ? -swing * s * 0.8 * speed01 : Math.sin(t * 1.5) * 0.05
			let sz = airborne ? s * 0.35 : s * 0.12 + this.strafeLean * 0.2
			let ex = airborne ? -0.25 : moving ? 0.35 + Math.max(0, swing * s) * 0.4 : 0.28

			// aim pose: raise the firing arm at the reticle
			const isFiring = (s > 0) === (this.handSide > 0)
			const w = this.armBlend * (isFiring || this.charging ? 1 : 0.55)
			const aimX = -Math.PI / 2 - pitch * 0.9 - (isFiring ? this.recoil * 0.45 : 0)
			const aimZ = s * 0.22
			const aimE = 0.1 + (isFiring ? this.recoil * 0.3 : 0.16)
			sx = lerp(sx, aimX, w)
			sz = lerp(sz, aimZ, w)
			ex = lerp(ex, aimE, w)

			// nova pose: both arms straight up, then slam
			if (this.novaTime > 0) {
				const k = clamp((1.1 - this.novaTime) / 0.35, 0, 1)
				sx = lerp(sx, -Math.PI * 0.95, 1 - k * 0.55)
				sz = lerp(sz, s * 0.5, 1)
				ex = lerp(ex, 0.05, 1)
			}

			arm.shoulder.rotation.x = damp(arm.shoulder.rotation.x, sx, 0.00005, dt)
			arm.shoulder.rotation.z = damp(arm.shoulder.rotation.z, sz, 0.0002, dt)
			arm.elbow.rotation.x = damp(arm.elbow.rotation.x, ex, 0.0001, dt)
			arm.flash.material.opacity = Math.max(0, arm.flash.material.opacity - dt * 7)
			arm.flash.scale.setScalar(1 + (1 - arm.flash.material.opacity) * 0.7)
		}

		this._poseCape(dt, t, speed01)
		this._poseHair(dt, t, speed01)

		// hurt / iframe flashing
		const flash = this.hurtFlash
		for (const m of this.materials) {
			m.emissive.setRGB(flash * 0.9, flash * 0.05, flash * 0.05)
			m.emissiveIntensity = flash > 0.02 ? 2 : m === this.suitMat ? 0.5 : 0
		}
		if (this.iframes > 0 && !this.dead) {
			this.root.visible = Math.floor(this.iframes * 22) % 2 === 0 || this.iframes < 0.15
		} else {
			this.root.visible = true
		}

		// aura: charge / ult-ready / dash
		let auraOpacity = 0
		if (this.charging) auraOpacity = 0.1 + this.charge * 0.42
		if (this.ultReady) auraOpacity = Math.max(auraOpacity, 0.1 + Math.sin(t * 5) * 0.05)
		if (this.dashTime > 0) auraOpacity = Math.max(auraOpacity, 0.4)
		if (this.novaTime > 0) auraOpacity = Math.max(auraOpacity, 0.75)
		this.aura.material.opacity = damp(this.aura.material.opacity, auraOpacity, 0.0005, dt)
		this.aura.material.color.setHex(this.charging ? 0x66e6ff : 0xffa23c)
		this.aura.scale.setScalar(1 + Math.sin(t * 7) * 0.04 + (this.novaTime > 0 ? this.novaTime * 0.9 : 0))

		this.light.intensity = 5 + (this.charging ? this.charge * 22 : 0) + this.novaTime * 34
		this.emblem.material.emissiveIntensity = 0.8 + Math.sin(t * 3) * 0.25 + this.charge * 2
	}

	_poseCape(dt, t, speed01) {
		const pos = this.cape.geometry.attributes.position
		const base = this.capeBase
		const arr = pos.array
		const windUp = clamp(-this.vel.y / 18, -0.6, 1)
		const gust = speed01 * 1.5 + (this.flying ? 1.6 : 0) + (this.dashTime > 0 ? 2.4 : 0)
		for (let i = 0; i < arr.length; i += 3) {
			const bx = base[i]
			const by = base[i + 1] - this.capeHalf // geometry was translated after capture
			const k = clamp((this.capeHalf - by) / this.capeLen, 0, 1) // 0 at collar, 1 at hem
			const wave = Math.sin(t * 6 + by * 4.5 + bx * 2.2) * 0.09 * k
			const flare = Math.sin(t * 3.3 + bx * 3) * 0.05 * k
			arr[i] = bx * (1 + k * 0.5)
			arr[i + 1] = by + k * k * (0.35 * gust + windUp * 0.25)
			arr[i + 2] = -(k * k * (0.45 + gust * 0.5)) + wave + flare
		}
		pos.needsUpdate = true
		this.cape.geometry.computeVertexNormals()
		this.capeAnchor.rotation.x = damp(this.capeAnchor.rotation.x, -0.12 - this.lean * 0.5, 0.001, dt)
		this.capeAnchor.rotation.z = damp(this.capeAnchor.rotation.z, this.strafeLean * 0.6, 0.001, dt)
	}

	_poseHair(dt, t, speed01) {
		const w = 0.12 + speed01 * 0.22 + (this.flying ? 0.28 : 0)
		for (let i = 0; i < this.hairSpikes.length; i++) {
			const s = this.hairSpikes[i]
			const b = s.userData.base
			s.rotation.x = b.x + Math.sin(t * 7 + i) * w * 0.5 + speed01 * 0.35
			s.rotation.z = b.z + Math.cos(t * 6 + i * 1.7) * w * 0.5
		}
	}

	_updateDeath(dt) {
		this.deathT += dt
		this.vel.y -= 22 * dt
		this.pos.addScaledVector(this.vel, dt)
		this.world.resolve(this.pos, this.vel, 0.55)
		this.root.position.copy(this.pos)
		this.root.rotation.z = Math.min(Math.PI / 2, this.deathT * 3)
		this.root.rotation.y = this.yaw
		this.aura.material.opacity = Math.max(0, this.aura.material.opacity - dt)
		this.light.intensity = Math.max(0, this.light.intensity - dt * 40)
	}
}
