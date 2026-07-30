// The HUD: clock, tension, flow, and what you just caught.
//
// Everything here is DOM over the canvas, same as Nova. The one piece that
// really matters is the tension bar — it is the instrument the whole fight is
// played on, so it has to be readable at a glance and it has to warn before it
// kills you rather than at the same moment.

import { SPECIES } from "./fish.js"
import { clamp } from "../../shared/util.js"

const $ = (id) => document.getElementById(id)

export class HUD {
	constructor() {
		this.el = {
			hud: $("hud"),
			clock: $("clock"),
			score: $("score"),
			flow: $("flow"),
			flowWrap: $("flow-wrap"),
			tension: $("tension"),
			tensionFill: $("tension-fill"),
			lineFill: $("line-fill"),
			fighting: $("fighting"),
			fishName: $("fight-name"),
			prompt: $("prompt"),
			promptKey: $("prompt-key"),
			power: $("power"),
			powerFill: $("power-fill"),
			spot: $("spot"),
			card: $("card"),
			cardName: $("card-name"),
			cardWeight: $("card-weight"),
			cardScore: $("card-score"),
			tally: $("tally"),
			toast: $("toast"),
		}
		this._cardTimer = null
		this._toastTimer = null
		this._shownScore = 0
		this.reset()
	}

	show(on) {
		this.el.hud.classList.toggle("hidden", !on)
	}

	reset() {
		this._shownScore = 0
		this.el.score.textContent = "0"
		this.el.clock.textContent = "3:00"
		this.el.clock.classList.remove("low")
		this.setFlow(1)
		this.hideFight()
		this.hidePower()
		this.setSpot(null)
		this.el.card.classList.add("hidden")
		this.el.toast.classList.add("hidden")
		this.el.tally.innerHTML = ""
	}

	// ------------------------------------------------------------ clock + score

	setClock(secondsLeft) {
		const s = Math.max(0, Math.ceil(secondsLeft))
		const m = Math.floor(s / 60)
		this.el.clock.textContent = `${m}:${String(s % 60).padStart(2, "0")}`
		// The last half-minute is worth noticing without being a klaxon; this is a
		// calm game and a panic timer would fight that.
		this.el.clock.classList.toggle("low", s <= 30)
	}

	/** Odometer, so the score visibly climbs rather than jumping. */
	setScore(target, dt) {
		if (this._shownScore === target) return
		const diff = target - this._shownScore
		const step = Math.max(1, Math.abs(diff) * 6 * dt)
		this._shownScore =
			Math.abs(diff) <= step ? target : this._shownScore + Math.sign(diff) * step
		this.el.score.textContent = Math.round(this._shownScore).toLocaleString()
	}

	setFlow(mult) {
		this.el.flow.textContent = `${mult.toFixed(1)}×`
		this.el.flowWrap.classList.toggle("hot", mult >= 2)
		this.el.flowWrap.classList.toggle("max", mult >= 3)
	}

	// ------------------------------------------------------------ casting

	setPower(charge, reach) {
		this.el.power.classList.remove("hidden")
		this.el.powerFill.style.width = `${clamp(charge, 0, 1) * 100}%`
		this.el.power.dataset.reach = `${Math.round(reach)}m`
	}

	hidePower() {
		this.el.power.classList.add("hidden")
	}

	/** Name the water under the reticle, so the spots are learnable rather than secret. */
	setSpot(label) {
		this.el.spot.textContent = label || ""
		this.el.spot.classList.toggle("hidden", !label)
	}

	prompt(text, key = "") {
		this.el.prompt.classList.remove("hidden")
		this.el.prompt.firstChild.textContent = text
		this.el.promptKey.textContent = key
		this.el.promptKey.classList.toggle("hidden", !key)
	}

	hidePrompt() {
		this.el.prompt.classList.add("hidden")
	}

	// ------------------------------------------------------------ the fight

	showFight(id) {
		this.el.fighting.classList.remove("hidden")
		// Deliberately named. Knowing you have a pike on is what makes the tells
		// worth learning, and it is more exciting than a mystery.
		this.el.fishName.textContent = SPECIES[id].label
	}

	hideFight() {
		this.el.fighting.classList.add("hidden")
		this.el.fighting.classList.remove("bracing")
		this.el.tension.classList.remove("danger", "warn")
		this.el.tensionFill.style.width = "0%"
		this.el.lineFill.style.width = "0%"
	}

	/**
	 * @param warning the fish is gathering itself for a run
	 *
	 * The warning state has to be impossible to miss, because it is the entire
	 * skill gate: seeing it and letting go is what lets a player hold a high,
	 * fast-reeling tension the rest of the time. If it were subtle the mechanic
	 * would exist without being usable.
	 */
	setFight(tension, progress, danger, warning) {
		this.el.tensionFill.style.width = `${clamp(tension, 0, 1) * 100}%`
		this.el.lineFill.style.width = `${clamp(progress, 0, 1) * 100}%`
		this.el.tension.classList.toggle("danger", danger)
		this.el.tension.classList.toggle("warn", warning)
		this.el.fighting.classList.toggle("bracing", warning)
	}

	// ------------------------------------------------------------ results

	/** The catch card: the bit a kid actually wants to see. */
	catchCard(id, grams, score) {
		const s = SPECIES[id]
		this.el.cardName.textContent = s.label
		this.el.cardWeight.textContent =
			grams >= 1000 ? `${(grams / 1000).toFixed(2)} kg` : `${grams} g`
		this.el.cardScore.textContent = `+${score.toLocaleString()}`
		this.el.card.classList.remove("hidden")
		this.el.card.classList.remove("pop")
		// Force a reflow so the animation restarts on a quick second catch.
		void this.el.card.offsetWidth
		this.el.card.classList.add("pop")
		clearTimeout(this._cardTimer)
		this._cardTimer = setTimeout(() => this.el.card.classList.add("hidden"), 2600)
	}

	toast(text, kind = "") {
		this.el.toast.textContent = text
		this.el.toast.className = `toast ${kind}`
		clearTimeout(this._toastTimer)
		this._toastTimer = setTimeout(() => this.el.toast.classList.add("hidden"), 1800)
	}

	/** One pip per species landed, so the collection goal is visible all run. */
	setTally(counts) {
		this.el.tally.innerHTML = Object.keys(SPECIES)
			.map((id) => {
				const n = counts[id] || 0
				return (
					`<div class="pip${n ? " got" : ""}" title="${SPECIES[id].label}">` +
					`<span class="pn">${SPECIES[id].label.slice(0, 2)}</span>` +
					`<span class="pc">${n || ""}</span></div>`
				)
			})
			.join("")
	}
}
