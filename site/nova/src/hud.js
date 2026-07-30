// DOM heads-up display: bars, combo, banners, kill feed and world-space damage numbers.

import * as THREE from "three"
import { clamp } from "../../shared/util.js"
import { drawFace } from "./hero.js"

const $ = (id) => document.getElementById(id)

export class HUD {
	constructor() {
		this.el = {
			hud: $("hud"),
			hpFill: $("hp-fill"),
			hpGhost: $("hp-ghost"),
			hpText: $("hp-text"),
			enFill: $("en-fill"),
			enText: $("en-text"),
			heroCard: $("hero-card"),
			score: $("score"),
			waveNum: $("wave-num"),
			combo: $("combo"),
			comboNum: $("combo").querySelector("b"),
			comboBar: $("combo").querySelector("i"),
			banner: $("banner"),
			killfeed: $("killfeed"),
			floaters: $("floaters"),
			hitmarker: $("hitmarker"),
			crosshair: $("crosshair"),
			chargeRing: $("charge-ring"),
			chargeCircle: $("charge-ring").querySelector("circle"),
			vignette: $("vignette"),
			ultflash: $("ultflash"),
			bossBar: $("boss-bar"),
			bossFill: $("bb-fill"),
			bossName: document.querySelector(".bb-name"),
			lowWarn: $("low-health-warn"),
			abDash: $("ab-dash"),
			abHover: $("ab-hover"),
			abUlt: $("ab-ult"),
			abDashFill: $("ab-dash").querySelector("i"),
			abHoverFill: $("ab-hover").querySelector("i"),
			abUltFill: $("ab-ult").querySelector("i"),
		}

		const pc = $("portrait")
		drawFace(pc.getContext("2d"), 128, { portrait: true })

		this.floaters = []
		for (let i = 0; i < 16; i++) {
			const d = document.createElement("div")
			d.className = "floater"
			d.style.opacity = "0"
			this.el.floaters.appendChild(d)
			this.floaters.push({ el: d, alive: false, t: 0, pos: new THREE.Vector3(), off: 0 })
		}
		this._v = new THREE.Vector3()
		this._displayedScore = 0
		this._score = 0
		this._ghostHp = 1
		this._ultFlash = 0
	}

	show(on) {
		this.el.hud.classList.toggle("hidden", !on)
	}

	// ---------------------------------------------------------- bars
	setHealth(hp, max) {
		const f = clamp(hp / max, 0, 1)
		this.el.hpFill.style.width = `${f * 100}%`
		this.el.hpText.textContent = Math.ceil(hp)
		if (f < this._ghostHp) {
			this._ghostHp = Math.max(this._ghostHp, f)
		} else {
			this._ghostHp = f
		}
		this.el.hpGhost.style.width = `${this._ghostHp * 100}%`
		this._ghostHp = f
		this.el.vignette.style.opacity = f < 0.45 ? String((0.45 - f) * 2.2) : "0"
		this.el.lowWarn.classList.toggle("hidden", f > 0.25)
	}

	hurt() {
		this.el.heroCard.classList.remove("hurt")
		void this.el.heroCard.offsetWidth
		this.el.heroCard.classList.add("hurt")
		this.el.vignette.style.opacity = "0.9"
	}

	setEnergy(e, max) {
		this.el.enFill.style.width = `${clamp(e / max, 0, 1) * 100}%`
	}

	setScore(v) {
		this._score = v
	}

	setWave(n) {
		this.el.waveNum.textContent = n
	}

	setCombo(mult, frac) {
		if (mult <= 1) {
			this.el.combo.classList.add("hidden")
			return
		}
		this.el.combo.classList.remove("hidden")
		if (this.el.comboNum.textContent !== String(mult)) {
			this.el.comboNum.textContent = mult
			this.el.combo.classList.remove("pop")
			void this.el.combo.offsetWidth
			this.el.combo.classList.add("pop")
		}
		this.el.comboBar.style.width = `${clamp(frac, 0, 1) * 100}%`
	}

	setAbilities(hero) {
		const dash = 1 - hero.dashCd / 0.85
		this.el.abDashFill.style.height = `${(1 - clamp(dash, 0, 1)) * 100}%`
		this.el.abDash.classList.toggle("ready", hero.dashCd <= 0 && hero.energy >= 22)
		const en = hero.energy / hero.maxEnergy
		this.el.abHoverFill.style.height = `${(1 - en) * 100}%`
		this.el.abHover.classList.toggle("ready", en > 0.25)
		const ult = hero.ult / hero.maxUlt
		this.el.abUltFill.style.height = `${(1 - ult) * 100}%`
		this.el.abUlt.classList.toggle("ready", hero.ultReady)
	}

	setCharge(v) {
		const c = this.el.chargeRing
		c.style.opacity = v > 0.01 ? "1" : "0"
		this.el.chargeCircle.style.strokeDashoffset = String(276.5 * (1 - clamp(v, 0, 1)))
		c.classList.toggle("full", v >= 1)
		this.el.crosshair.classList.toggle("wide", v > 0.05)
	}

	setHostile(on) {
		this.el.crosshair.classList.toggle("hostile", on)
	}

	// ---------------------------------------------------------- boss
	showBoss(name) {
		this.el.bossName.textContent = name
		this.el.bossBar.classList.remove("hidden")
	}

	setBoss(frac) {
		this.el.bossFill.style.width = `${clamp(frac, 0, 1) * 100}%`
	}

	hideBoss() {
		this.el.bossBar.classList.add("hidden")
	}

	// ---------------------------------------------------------- feedback
	hitmarker(kill = false) {
		const h = this.el.hitmarker
		h.classList.toggle("kill", kill)
		h.classList.remove("show")
		void h.offsetWidth
		h.classList.add("show")
	}

	banner(big, small = "") {
		const b = this.el.banner
		b.innerHTML = `${big}${small ? `<small>${small}</small>` : ""}`
		b.classList.remove("show")
		void b.offsetWidth
		b.classList.add("show")
	}

	kill(name, points) {
		const d = document.createElement("div")
		d.innerHTML = `<em>${name}</em> DOWN &nbsp;<b>+${points}</b>`
		this.el.killfeed.appendChild(d)
		setTimeout(() => d.remove(), 3000)
		while (this.el.killfeed.children.length > 6) this.el.killfeed.firstChild.remove()
	}

	ultFlash() {
		this._ultFlash = 1
	}

	floater(worldPos, text, cls = "") {
		const f = this.floaters.find((x) => !x.alive)
		if (!f) return
		f.alive = true
		f.t = 0
		f.pos.copy(worldPos)
		f.off = (Math.random() - 0.5) * 40
		f.el.className = `floater ${cls}`
		f.el.textContent = text
	}

	// ---------------------------------------------------------- frame
	update(dt, camera) {
		// score odometer
		if (this._displayedScore !== this._score) {
			const diff = this._score - this._displayedScore
			this._displayedScore += Math.sign(diff) * Math.max(1, Math.abs(diff) * Math.min(1, dt * 9))
			if (Math.abs(this._score - this._displayedScore) < 1) this._displayedScore = this._score
			this.el.score.textContent = Math.round(this._displayedScore).toLocaleString()
		}

		if (this._ultFlash > 0) {
			this._ultFlash = Math.max(0, this._ultFlash - dt * 1.4)
			this.el.ultflash.style.opacity = String(this._ultFlash * 0.85)
		}

		const w = window.innerWidth
		const h = window.innerHeight
		for (const f of this.floaters) {
			if (!f.alive) continue
			f.t += dt
			const k = f.t / 1.05
			if (k >= 1) {
				f.alive = false
				f.el.style.opacity = "0"
				continue
			}
			this._v.copy(f.pos)
			this._v.y += k * 1.6
			this._v.project(camera)
			if (this._v.z > 1) {
				f.el.style.opacity = "0"
				continue
			}
			const x = (this._v.x * 0.5 + 0.5) * w + f.off
			const y = (-this._v.y * 0.5 + 0.5) * h
			f.el.style.transform = `translate(-50%,-50%) translate(${x}px, ${y}px) scale(${1 + (1 - k) * 0.5})`
			f.el.style.opacity = String(1 - k * k)
		}
	}

	reset() {
		this._displayedScore = 0
		this._score = 0
		this.el.score.textContent = "0"
		this.el.killfeed.innerHTML = ""
		this.hideBoss()
		this.el.combo.classList.add("hidden")
		this.el.vignette.style.opacity = "0"
		this.el.ultflash.style.opacity = "0"
		this.el.lowWarn.classList.add("hidden")
		for (const f of this.floaters) {
			f.alive = false
			f.el.style.opacity = "0"
		}
	}
}
