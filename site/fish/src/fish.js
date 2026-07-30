// Species, bite tells, and the fight.
//
// The fight is the point of this game, so it is worth stating the rule it is
// built around: TENSION RISES WHILE YOU REEL AND WHILE THE FISH RUNS, AND ONLY
// FALLS WHEN YOU LET GO. That single asymmetry produces the whole skill —
// reel during the lulls, ease off during the runs, and go into every run with
// enough slack in the bar to survive it. Nothing in Nova plays like this: there
// the input is aggression, here it is restraint.
//
// Two deliberate balance choices worth not "fixing" later without thinking:
//
//  - Big fish are EASIER to hook and much harder to land. Their tells are slow
//    and their hook window is generous; their fight is brutal. Hooking a
//    sturgeon should feel like the start of the problem, not the reward.
//  - Fish tire. Fatigue weakens their pull and lengthens their rests, so a
//    patient player is rewarded twice — they don't snap the line, and the fish
//    they're holding gets easier. Losing patience is the mistake, not losing
//    a reflex check.

import { clamp, lerp, rand } from "../../shared/util.js"

/** Above this the line is visibly in danger; at 1 it snaps. */
export const DANGER = 0.8

/**
 * The roster.
 *
 * `rare` multiplies the score, and the weights bias the roll: `w0` is how often
 * a species turns up in open water, `w1` how often over a really good spot.
 * Reading the surface is worth doing because it moves the roll from the first
 * two rows to the last two, not because it catches more fish.
 */
export const SPECIES = {
	sunfish: {
		label: "SUNFISH",
		rare: 1,
		grams: [90, 320],
		colour: 0xd9a13b,
		belly: 0xf2dfae,
		w0: 52,
		w1: 6,
		// tell: a flurry of tiny taps, then it takes it. Twitchy and easy to
		// misread as a fish already hooked.
		tell: { taps: 5, tapMs: 105, gapMs: 95, sink: 0.05, windowMs: 300 },
		// Deliberately forgiving. This is the fish a beginner catches while still
		// working out what the button does, so holding the reel down has to work —
		// a sunfish that snaps teaches nothing except that the game is unfair.
		// Every other species punishes that, which is where the learning happens.
		fight: {
			pull: 0.2,
			reelTension: 0.08,
			ease: 0.62,
			runTake: 1.6,
			reelRate: 6.5,
			runDur: [0.3, 0.6],
			restDur: [1.1, 1.7],
			stamina: 8,
		},
	},
	perch: {
		label: "PERCH",
		rare: 2,
		grams: [280, 900],
		colour: 0x7f8f45,
		belly: 0xe6d79a,
		w0: 31,
		w1: 17,
		tell: { taps: 2, tapMs: 150, gapMs: 150, sink: 0.09, windowMs: 320 },
		fight: {
			pull: 0.42,
			reelTension: 0.3,
			ease: 0.6,
			runTake: 1.7,
			reelRate: 6.2,
			runDur: [0.4, 0.9],
			restDur: [1.0, 1.6],
			stamina: 11,
		},
	},
	bass: {
		label: "BASS",
		rare: 4,
		grams: [900, 2600],
		colour: 0x4a6b46,
		belly: 0xd9d2a8,
		w0: 13,
		w1: 30,
		// one committed thump — miss it and there is no second chance
		tell: { taps: 1, tapMs: 260, gapMs: 120, sink: 0.16, windowMs: 340 },
		fight: {
			pull: 0.56,
			reelTension: 0.38,
			ease: 0.58,
			runTake: 2.2,
			reelRate: 6,
			runDur: [0.6, 1.2],
			restDur: [1.1, 1.8],
			stamina: 14,
		},
	},
	pike: {
		label: "PIKE",
		rare: 9,
		grams: [2200, 6500],
		colour: 0x3f5a3a,
		belly: 0xc8cf9a,
		w0: 3.4,
		w1: 30,
		// no taps at all — the float just leans over and keeps going
		tell: { taps: 1, tapMs: 620, gapMs: 100, sink: 0.24, windowMs: 420 },
		fight: {
			pull: 0.66,
			reelTension: 0.44,
			ease: 0.56,
			runTake: 2.5,
			reelRate: 5.6,
			runDur: [1.0, 1.7],
			restDur: [1.3, 2.1],
			stamina: 19,
		},
	},
	sturgeon: {
		label: "STURGEON",
		rare: 20,
		grams: [6000, 17000],
		colour: 0x4b4a5e,
		belly: 0xb9b2a4,
		w0: 0.25,
		w1: 15,
		// the slowest tell in the lake: it sinks, and sinks, and sinks
		tell: { taps: 1, tapMs: 900, gapMs: 120, sink: 0.34, windowMs: 480 },
		fight: {
			pull: 0.72,
			reelTension: 0.5,
			ease: 0.55,
			runTake: 2.6,
			reelRate: 5.2,
			runDur: [1.2, 2.0],
			restDur: [1.6, 2.6],
			stamina: 26,
		},
	},
}

export const SPECIES_IDS = Object.keys(SPECIES)

/**
 * Pick what took the bait.
 *
 * `quality` is the spot quality from the lake, 0 for open water and 1 for a
 * shimmer school. It slides every species' weight between its open-water and
 * best-spot value, so a good cast doesn't guarantee a sturgeon — it just makes
 * one possible.
 */
export function rollSpecies(quality) {
	const q = clamp(quality, 0, 1)
	let total = 0
	const weights = SPECIES_IDS.map((id) => {
		const s = SPECIES[id]
		const w = lerp(s.w0, s.w1, q)
		total += w
		return w
	})
	let r = Math.random() * total
	for (let i = 0; i < weights.length; i++) {
		r -= weights[i]
		if (r <= 0) return SPECIES_IDS[i]
	}
	return SPECIES_IDS[0]
}

/** Weight for a specific catch. Biased small, so a big one is genuinely a big one. */
export function rollGrams(id, quality) {
	const [lo, hi] = SPECIES[id].grams
	// Two rolls averaged pulls the distribution towards the middle, then spot
	// quality nudges it up. A monster needs both luck and a good cast.
	const base = (Math.random() + Math.random()) / 2
	const t = clamp(base * 0.85 + quality * 0.2, 0, 1)
	return Math.round(lerp(lo, hi, t))
}

/** Score for one landed fish. Grams matter, rarity matters more, flow multiplies. */
export function catchScore(id, grams, flowMult) {
	return Math.max(1, Math.round((grams / 100) * SPECIES[id].rare * flowMult))
}

// ---------------------------------------------------------------- the bite

/**
 * A fish investigating the bait.
 *
 * Runs the species' tell, then opens a hook window. Striking during the taps is
 * too early and spooks it; striking after the window is a miss. The tell is the
 * thing worth learning — each species announces itself with a different rhythm,
 * so a player who pays attention knows what they have hooked before they see it.
 */
export class Bite {
	constructor(id, grams, spotQuality) {
		this.id = id
		this.grams = grams
		this.quality = spotQuality
		const tell = SPECIES[id].tell
		this.tell = tell
		this.t = 0
		this.tapPeriod = (tell.tapMs + tell.gapMs) / 1000
		this.commitAt = tell.taps * this.tapPeriod
		this.windowEnd = this.commitAt + tell.windowMs / 1000
		// After the window it swims off on its own.
		this.goneAt = this.windowEnd + 0.7
	}

	update(dt) {
		this.t += dt
	}

	/** "taps" while it's testing the bait, "window" once it has taken it. */
	get phase() {
		if (this.t < this.commitAt) return "taps"
		if (this.t < this.windowEnd) return "window"
		return "gone"
	}

	get canHook() {
		return this.phase === "window"
	}

	get expired() {
		return this.t >= this.goneAt
	}

	/**
	 * How far under the float sits right now, in metres. This is the only thing
	 * the player can actually see, so it carries the whole tell.
	 */
	bobberSink() {
		const tell = this.tell
		if (this.t < this.commitAt) {
			const into = this.t % this.tapPeriod
			const tapSecs = tell.tapMs / 1000
			if (into > tapSecs) return 0
			// A smooth down-and-up rather than a square pulse, so slow tells read
			// as a lean and fast ones as a flick.
			return Math.sin((into / tapSecs) * Math.PI) * tell.sink
		}
		// Committed: it goes under and stays under.
		const into = this.t - this.commitAt
		return tell.sink + Math.min(1, into / 0.22) * 0.3
	}
}

// ---------------------------------------------------------------- the fight

export class Fight {
	constructor(id, grams, lineOut) {
		this.id = id
		this.grams = grams
		this.f = SPECIES[id].fight
		this.line = lineOut
		this.startLine = lineOut
		this.tension = 0.12
		this.fatigue = 0
		this.t = 0
		this.state = "rest"
		this.stateT = rand(0.3, 0.7)
		this.result = null // "landed" | "snapped" | "spooled"
		// Which way the fish is pulling, for the line and the splash. Fed by the
		// caller so the visuals track it.
		this.angle = 0
		this.surged = false
	}

	get danger() {
		return this.tension >= DANGER
	}

	get running() {
		return this.state === "run"
	}

	/** 0..1 how far in this fight is, for the HUD's line meter. */
	get progress() {
		return clamp(1 - this.line / this.startLine, 0, 1)
	}

	_nextState() {
		const f = this.f
		if (this.state === "run") {
			this.state = "rest"
			// A tired fish rests longer, which is what lets a patient player win.
			this.stateT = rand(f.restDur[0], f.restDur[1]) * (1 + 0.6 * this.fatigue)
		} else {
			this.state = "run"
			this.stateT = rand(f.runDur[0], f.runDur[1]) * (1 - 0.3 * this.fatigue)
			this.surged = true
			this.angle += rand(-0.8, 0.8)
		}
	}

	/**
	 * One step of the fight.
	 *
	 * @param dt      seconds
	 * @param reeling is the player holding the button
	 */
	update(dt, reeling) {
		if (this.result) return
		this.t += dt
		this.fatigue = clamp(this.fatigue + dt / this.f.stamina, 0, 1)
		this.surged = false

		this.stateT -= dt
		if (this.stateT <= 0) this._nextState()

		const f = this.f
		// Fatigue takes the sting out of the pull as the fight goes on.
		const pull = f.pull * (1 - 0.45 * this.fatigue)
		const running = this.state === "run"

		// The asymmetry that makes this a game: reeling always costs tension, and
		// tension only comes off while the button is up.
		if (reeling) {
			this.tension += (f.reelTension + (running ? pull : 0)) * dt
			this.line -= f.reelRate * dt
		} else {
			this.tension += ((running ? pull : 0) - f.ease) * dt
		}

		// A running fish takes line whether or not you are reeling — holding on
		// through a run is a cost you pay, not a thing you can prevent.
		if (running) this.line += f.runTake * dt

		this.tension = clamp(this.tension, 0, 1)
		this.line = Math.max(0, this.line)

		if (this.tension >= 1) {
			this.result = "snapped"
		} else if (this.line <= 0.35) {
			this.result = "landed"
		} else if (this.line > this.startLine + 14) {
			// Never reeling at all shouldn't be a safe way to keep a fish forever.
			this.result = "spooled"
		}
	}
}
