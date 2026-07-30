// The HUD: speedo, waypoint, shift clock and the free-roam bits.
//
// Two modes share one HUD. Free roam shows almost nothing on purpose — a speedo,
// a star count and the radio — because the whole point of it is that nothing is
// being asked of you. SHIFT adds the clock, the cash, the streak and the job
// card, and the difference between the two should be obvious at a glance.

import { clamp } from "../../shared/util.js"

const $ = (id) => document.getElementById(id)

export class HUD {
	constructor() {
		this.el = {
			hud: $("hud"),
			speed: $("speed"),
			speedFill: $("speed-fill"),
			gear: $("gear"),
			stars: $("stars"),
			starTotal: $("star-total"),
			radio: $("radio"),
			mode: $("mode"),
			shift: $("shift"),
			clock: $("clock"),
			cash: $("cash"),
			streak: $("streak"),
			job: $("job"),
			jobKind: $("job-kind"),
			jobWhere: $("job-where"),
			jobBar: $("job-bar"),
			jobFill: $("job-fill"),
			arrow: $("arrow"),
			arrowDist: $("arrow-dist"),
			drift: $("drift"),
			toast: $("toast"),
			pop: $("pop"),
			perf: $("perf"),
		}
		this._toastT = null
		this._popT = null
		this._shownCash = 0
	}

	show(on) {
		this.el.hud.classList.toggle("hidden", !on)
	}

	// ------------------------------------------------------------ always on

	setSpeed(kph, frac, reversing, drifting, airborne) {
		this.el.speed.textContent = String(kph)
		this.el.speedFill.style.width = `${clamp(frac, 0, 1) * 100}%`
		this.el.gear.textContent = airborne ? "AIR" : reversing ? "R" : "D"
		this.el.gear.classList.toggle("air", airborne)
		this.el.drift.classList.toggle("on", drifting)
	}

	setStars(taken, total) {
		this.el.stars.textContent = String(taken)
		this.el.starTotal.textContent = `/ ${total}`
	}

	setRadio(name) {
		this.el.radio.textContent = name
	}

	setMode(label, shifting) {
		this.el.mode.textContent = label
		this.el.mode.classList.toggle("shift", shifting)
		this.el.shift.classList.toggle("hidden", !shifting)
	}

	/**
	 * The waypoint arrow.
	 *
	 * Rotated by the angle between where the car is pointing and where it needs to
	 * go, so it reads as "turn that way" rather than needing a minimap. Cheaper
	 * than a minimap and easier for a kid to follow at speed.
	 */
	setWaypoint(relativeAngle, distance, kind) {
		if (relativeAngle === null) {
			this.el.arrow.classList.add("hidden")
			return
		}
		this.el.arrow.classList.remove("hidden")
		this.el.arrow.style.transform = `rotate(${relativeAngle}rad)`
		this.el.arrow.dataset.kind = kind
		this.el.arrowDist.textContent = `${Math.round(distance)}m`
	}

	// ------------------------------------------------------------ shift only

	setClock(seconds) {
		const s = Math.max(0, Math.ceil(seconds))
		this.el.clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
		this.el.clock.classList.toggle("low", s <= 30)
	}

	/** Odometer, so the cash climbs instead of jumping. */
	setCash(target, dt) {
		if (this._shownCash === target) return
		const diff = target - this._shownCash
		const step = Math.max(1, Math.abs(diff) * 7 * dt)
		this._shownCash = Math.abs(diff) <= step ? target : this._shownCash + Math.sign(diff) * step
		this.el.cash.textContent = `$${Math.round(this._shownCash).toLocaleString()}`
	}

	resetCash() {
		this._shownCash = 0
		this.el.cash.textContent = "$0"
	}

	setStreak(mult) {
		this.el.streak.textContent = `${mult.toFixed(2).replace(/\.00$/, "")}×`
		this.el.streak.classList.toggle("hot", mult >= 2)
		this.el.streak.classList.toggle("max", mult >= 3)
	}

	setJob(job) {
		if (!job) {
			this.el.job.classList.add("hidden")
			return
		}
		this.el.job.classList.remove("hidden")
		this.el.jobKind.textContent = job.carrying ? "DELIVER TO" : "COLLECT FROM"
		this.el.jobWhere.textContent = (job.carrying ? job.drop : job.pickup).label
		const frac = clamp(job.left / job.allowed, 0, 1)
		this.el.jobFill.style.width = `${frac * 100}%`
		this.el.jobBar.classList.toggle("low", frac < 0.3)
	}

	// ------------------------------------------------------------ feedback

	toast(text, kind = "") {
		this.el.toast.textContent = text
		this.el.toast.className = `toast ${kind}`
		clearTimeout(this._toastT)
		this._toastT = setTimeout(() => this.el.toast.classList.add("hidden"), 2000)
	}

	/** The big number that pops when a delivery lands. */
	pop(text, kind = "") {
		this.el.pop.textContent = text
		this.el.pop.className = `pop ${kind}`
		this.el.pop.classList.remove("go")
		void this.el.pop.offsetWidth
		this.el.pop.classList.add("go")
		clearTimeout(this._popT)
		this._popT = setTimeout(() => this.el.pop.classList.add("hidden"), 1400)
	}

	reset() {
		this.resetCash()
		this.setStreak(1)
		this.setJob(null)
		this.setWaypoint(null)
		this.el.toast.classList.add("hidden")
		this.el.pop.classList.add("hidden")
	}
}
