// Species, bite tells, and the fight.
//
// The fight is the point of this game, so it is worth stating the rules it is
// built around:
//
//   1. TENSION RISES WHILE YOU REEL AND WHILE THE FISH RUNS, AND ONLY FALLS
//      WHEN YOU LET GO.
//   2. A RUN STARTS WITH A SHOCK, AND THE FISH TELLS YOU IT IS COMING.
//
// Rule 2 exists because rule 1 alone is not a skill. Without it, releasing the
// button recovers tension several times faster than any run can add it, so
// "reel below a threshold, release above it" — a thermostat that never even
// looks at whether the fish is running — lands every fish in the lake, and
// slightly faster than playing properly. There is no anticipation to reward if
// runs arrive unannounced, so watching the fish would be strictly pointless.
//
// So each run is preceded by a short telegraph (`warn`), and the moment the run
// begins the line takes an instant hit (`surge`). A shock cannot be reacted to,
// only prepared for: the player who sees the telegraph and lets go arrives at
// the run with slack and rides it out, while the thermostat holding at its
// threshold eats the surge and snaps. Playing blind is still possible, but only
// by holding a much lower threshold — which means far less reeling, a longer
// fight, and fewer fish inside the three minutes.
//
// Nothing in Nova plays like this: there the input is aggression, here it is
// restraint plus attention.
//
// Two deliberate balance choices worth not "fixing" later without thinking:
//
//  - Big fish are EASIER to hook and much harder to land. Their tells are slow
//    and their hook window is generous; their fight is brutal. Hooking a
//    sturgeon should feel like the start of the problem, not the reward.
//  - Hook windows are sized for HUMAN reactions, not simulated ones. The first
//    versions were 300-480ms, certified by a zero-latency sim, and the first
//    human to ever play the game could not hook a fish: seeing the float go
//    under and tapping takes a first-timer ~350ms before the window even starts
//    counting. The skill of the bite is reading the tell and NOT striking early
//    — it was never meant to also be a reflex bar. There is now a
//    human-latency test that keeps it honest.
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
		tell: { taps: 5, tapMs: 105, gapMs: 95, sink: 0.13, windowMs: 560 },
		// Deliberately forgiving. This is the fish a beginner catches while still
		// working out what the button does, so holding the reel down has to work —
		// a sunfish that snaps teaches nothing except that the game is unfair.
		// Every other species punishes that, which is where the learning happens.
		fight: {
			pull: 0.2,
			reelTension: 0.22,
			ease: 0.62,
			runTake: 1.6,
			reelRate: 9.0,
			runDur: [0.3, 0.6],
			restDur: [1.1, 1.7],
			stamina: 8,
			// seconds of telegraph before a run, and the instant tension hit
			// when it starts — see the header. Bigger fish announce it for longer
			// and hit harder, so they are readable but unforgiving if you are not.
			warn: 0.30,
			surge: 0.05,
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
		tell: { taps: 2, tapMs: 150, gapMs: 150, sink: 0.19, windowMs: 580 },
		fight: {
			pull: 0.5,
			reelTension: 0.46,
			ease: 0.66,
			runTake: 1.7,
			reelRate: 6.2,
			runDur: [0.4, 0.9],
			restDur: [1.0, 1.6],
			stamina: 11,
			// seconds of telegraph before a run, and the instant tension hit
			// when it starts — see the header. Bigger fish announce it for longer
			// and hit harder, so they are readable but unforgiving if you are not.
			warn: 0.34,
			surge: 0.34,
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
		tell: { taps: 1, tapMs: 260, gapMs: 120, sink: 0.26, windowMs: 620 },
		fight: {
			pull: 0.52,
			reelTension: 0.56,
			ease: 0.64,
			runTake: 2.2,
			reelRate: 6.0,
			runDur: [0.6, 1.2],
			restDur: [1.1, 1.8],
			stamina: 14,
			// seconds of telegraph before a run, and the instant tension hit
			// when it starts — see the header. Bigger fish announce it for longer
			// and hit harder, so they are readable but unforgiving if you are not.
			warn: 0.40,
			surge: 0.38,
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
		tell: { taps: 1, tapMs: 620, gapMs: 100, sink: 0.32, windowMs: 700 },
		fight: {
			pull: 0.5,
			reelTension: 0.64,
			ease: 0.62,
			runTake: 2.5,
			reelRate: 5.6,
			runDur: [1.0, 1.7],
			restDur: [1.3, 2.1],
			stamina: 19,
			// seconds of telegraph before a run, and the instant tension hit
			// when it starts — see the header. Bigger fish announce it for longer
			// and hit harder, so they are readable but unforgiving if you are not.
			warn: 0.45,
			surge: 0.41,
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
		tell: { taps: 1, tapMs: 900, gapMs: 120, sink: 0.4, windowMs: 780 },
		fight: {
			pull: 0.5,
			reelTension: 0.72,
			ease: 0.6,
			runTake: 2.6,
			reelRate: 5.2,
			runDur: [1.2, 2.0],
			restDur: [1.6, 2.6],
			stamina: 26,
			// seconds of telegraph before a run, and the instant tension hit
			// when it starts — see the header. Bigger fish announce it for longer
			// and hit harder, so they are readable but unforgiving if you are not.
			warn: 0.50,
			surge: 0.44,
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
			const tapSecs = tell.tapMs / 1000
			const index = Math.floor(this.t / this.tapPeriod)
			const into = this.t % this.tapPeriod
			const isLast = index >= tell.taps - 1
			if (into <= tapSecs) {
				const k = into / tapSecs
				// A smooth down-and-up rather than a square pulse, so slow tells read
				// as a lean and fast ones as a flick. The FINAL tap doesn't come back
				// up: it leans over and stays leaning, which is what the single-tap
				// species are described as doing and what the player is watching for.
				return Math.sin(Math.min(isLast ? k * 0.5 : k, 1) * Math.PI) * tell.sink
			}
			return isLast ? tell.sink : 0
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

	/** The fish is about to go. Let go now. */
	get warning() {
		return this.state === "warn"
	}

	/** 0..1 how far in this fight is, for the HUD's line meter. */
	get progress() {
		return clamp(1 - this.line / this.startLine, 0, 1)
	}

	/** rest → warn → run → rest. The warn state is the whole skill gate. */
	_nextState() {
		const f = this.f
		if (this.state === "run") {
			this.state = "rest"
			// A tired fish rests longer, which is what lets a patient player win.
			this.stateT = rand(f.restDur[0], f.restDur[1]) * (1 + 0.6 * this.fatigue)
		} else if (this.state === "rest") {
			// Telegraph: the fish gathers itself. It is not pulling yet, so this is
			// free time to let go — the only warning you get, and the reason
			// watching the fish beats watching only the bar.
			this.state = "warn"
			this.stateT = f.warn * (1 + 0.25 * this.fatigue)
			this.angle += rand(-0.5, 0.5)
		} else {
			this.state = "run"
			this.stateT = rand(f.runDur[0], f.runDur[1]) * (1 - 0.3 * this.fatigue)
			// The shock. Instant, so it cannot be reacted to — only arrived at with
			// enough slack. A tired fish hits softer.
			this.tension = clamp(this.tension + f.surge * (1 - 0.4 * this.fatigue), 0, 1)
			this.surged = true
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
		//
		// Line comes in faster when the line is tighter. This is what makes
		// reading the fish PAY rather than merely be safer: a thermostat hovers at
		// whatever threshold it holds and spends the same fraction of its time
		// reeling regardless of where that threshold is — duty cycle is set by
		// ease/reelTension, not by the threshold — so without this, a cautious
		// blind player finished just as fast as an attentive one. Tying progress to
		// tension means the headroom that reading the telegraph buys you is
		// headroom you can actually spend.
		if (reeling) {
			this.tension += (f.reelTension + (running ? pull : 0)) * dt
			this.line -= f.reelRate * (0.45 + 1.1 * this.tension) * dt
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
