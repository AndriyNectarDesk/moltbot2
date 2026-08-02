// The fight, the tells, and the scoring.
//
// This file exists because the plan called the tension curve the real risk in
// this game — not the code, the FEEL. Feel isn't assertable, but the shape of it
// is: a skilled strategy should land things, a greedy one should snap the line, a
// passive one should get spooled, and the gap between a sunfish and a sturgeon
// should be large. Those are the properties that make the fight a skill rather
// than a dice roll, and they are cheap to check.

import { describe, expect, it } from "vitest"
import {
	Bite,
	DANGER,
	Fight,
	SPECIES,
	SPECIES_IDS,
	catchScore,
	rollGrams,
	rollSpecies,
} from "./fish.js"

const STEP = 1 / 60

/**
 * Play out a fight with a given policy and report what happened.
 *
 * `policy(fight)` returns whether to hold the reel this frame. Everything the
 * player can see is on the fight object, so a policy here is exactly as informed
 * as a person watching the bar.
 */
function play(id, grams, lineOut, policy, maxSeconds = 120) {
	const fight = new Fight(id, grams, lineOut)
	let t = 0
	let reelFrames = 0
	while (!fight.result && t < maxSeconds) {
		const reeling = policy(fight)
		if (reeling) reelFrames++
		fight.update(STEP, reeling)
		t += STEP
	}
	return { result: fight.result || "timeout", seconds: t, fight, reelFrames }
}

// Watches the fish, not just the bar: lets go the instant it telegraphs a run,
// which is what buys the headroom to hold a high tension the rest of the time.
const reading = (f) => !f.warning && !f.running && f.tension < 0.9

// A thermostat. Sees only the bar, never the fish. This is the policy that used
// to beat proper play, so it now has a test of its own below.
const blindAt = (t) => (f) => f.tension < t

// Hold the reel down the whole time.
const greedy = () => true

// Never reel at all.
const passive = () => false

/** Run a policy many times, since runs and rests are randomised. */
function trial(id, grams, lineOut, policy, n = 200) {
	const out = { landed: 0, snapped: 0, spooled: 0, timeout: 0, seconds: [] }
	for (let i = 0; i < n; i++) {
		const r = play(id, grams, lineOut, policy)
		out[r.result]++
		if (r.result === "landed") out.seconds.push(r.seconds)
	}
	out.median = out.seconds.length
		? out.seconds.sort((a, b) => a - b)[Math.floor(out.seconds.length / 2)]
		: null
	return out
}

describe("the fight rewards restraint", () => {
	it("lands everything when played well", () => {
		for (const id of SPECIES_IDS) {
			const grams = SPECIES[id].grams[1]
			const r = trial(id, grams, 20, reading, 120)
			// A player who lets go on the telegraph and rides out the runs should
			// essentially always land the fish. The difficulty is in knowing to do
			// that, not in a dice roll going against you.
			expect(r.landed / 120, `${id} landed rate`).toBeGreaterThan(0.9)
		}
	})

	// The regression guard for the whole point of this game. Before the runs were
	// telegraphed and given an opening shock, a thermostat that never looked at
	// the fish landed every species 100% of the time and did it slightly FASTER
	// than proper play — so the advertised skill ceiling did not exist, and the
	// original version of this suite certified the wrong property because its
	// "skilled" policy's run check was dead weight.
	it("punishes a thermostat that never watches the fish", () => {
		for (const id of ["perch", "bass", "pike", "sturgeon"]) {
			const r = trial(id, SPECIES[id].grams[1], 20, blindAt(0.8), 80)
			expect(r.landed / 80, `${id} landed rate playing blind at 0.8`).toBeLessThan(0.5)
		}
	})

	// Playing blind is still allowed — it just has to be timid, and timid is slow,
	// because line comes in faster when the line is tighter.
	it("makes a blind player go slower to stay safe", () => {
		for (const id of ["bass", "pike", "sturgeon"]) {
			const grams = SPECIES[id].grams[1]
			const safeBlind = trial(id, grams, 20, blindAt(0.5), 60)
			const attentive = trial(id, grams, 20, reading, 60)
			expect(safeBlind.landed / 60, `${id} timid blind should still land`).toBeGreaterThan(0.9)
			expect(attentive.median, `${id} reading should be faster`).toBeLessThan(safeBlind.median)
		}
	})

	it("snaps the line on everything but the smallest fish when held down", () => {
		for (const id of ["perch", "bass", "pike", "sturgeon"]) {
			const r = trial(id, SPECIES[id].grams[1], 20, greedy, 60)
			expect(r.snapped / 60, `${id} snap rate when greedy`).toBeGreaterThan(0.9)
		}
	})

	it("telegraphs every run before it starts", () => {
		const f = new Fight("pike", 5000, 20)
		let sawWarnBeforeRun = 0
		let runs = 0
		let wasWarning = false
		let prevRunning = false
		for (let i = 0; i < 60 * 60; i++) {
			f.update(STEP, false)
			if (f.running && !prevRunning) {
				runs++
				if (wasWarning) sawWarnBeforeRun++
			}
			wasWarning = f.warning
			prevRunning = f.running
			if (f.result) break
		}
		expect(runs).toBeGreaterThan(2)
		// No run may arrive unannounced — that is the contract the skill rests on.
		expect(sawWarnBeforeRun).toBe(runs)
	})

	it("hits the line the instant a run starts", () => {
		const f = new Fight("sturgeon", 12000, 20)
		f.state = "warn"
		f.stateT = STEP / 2
		f.tension = 0.4
		f.update(STEP, false)
		expect(f.running).toBe(true)
		// The shock is instant, so it cannot be reacted to — only arrived at with
		// slack in hand.
		expect(f.tension).toBeGreaterThan(0.6)
	})

	// A sunfish is meant to be a freebie — you cannot really lose one, which is
	// what makes it the fish you catch while learning the controls.
	it("forgives holding the reel down on a sunfish", () => {
		const r = trial("sunfish", 320, 20, greedy, 60)
		expect(r.landed / 60).toBeGreaterThan(0.9)
	})

	it("spools you if you never reel", () => {
		for (const id of SPECIES_IDS) {
			const r = trial(id, SPECIES[id].grams[1], 20, passive, 40)
			expect(r.spooled / 40, `${id} spooled when passive`).toBeGreaterThan(0.9)
		}
	})
})

describe("difficulty scales with the prize", () => {
	it("takes longer to land a bigger fish", () => {
		const times = SPECIES_IDS.map((id) => trial(id, SPECIES[id].grams[1], 20, reading, 80).median)
		for (let i = 1; i < times.length; i++) {
			expect(times[i], `${SPECIES_IDS[i]} vs ${SPECIES_IDS[i - 1]}`).toBeGreaterThan(times[i - 1])
		}
	})

	it("keeps even a sturgeon inside a three-minute run", () => {
		// If the best fish in the lake couldn't be landed inside the clock it would
		// be a trap rather than a prize.
		const r = trial("sturgeon", 17000, 30, reading, 120)
		expect(r.median).toBeLessThan(60)
	})

	it("gives a tired fish an easier fight", () => {
		const fresh = new Fight("sturgeon", 17000, 20)
		const tired = new Fight("sturgeon", 17000, 20)
		tired.fatigue = 1
		tired.state = fresh.state = "run"
		tired.stateT = fresh.stateT = 5
		fresh.update(STEP, false)
		tired.update(STEP, false)
		expect(tired.tension).toBeLessThan(fresh.tension)
	})
})

describe("tension", () => {
	it("only falls when the button is up", () => {
		const f = new Fight("bass", 2000, 20)
		f.state = "rest"
		f.stateT = 10
		const start = f.tension
		f.update(0.5, true)
		expect(f.tension).toBeGreaterThan(start)
		const peak = f.tension
		f.update(0.5, false)
		expect(f.tension).toBeLessThan(peak)
	})

	it("marks danger before it snaps, so there is a warning to react to", () => {
		const f = new Fight("pike", 5000, 20)
		f.state = "rest"
		f.stateT = 30
		let sawDanger = false
		while (!f.result) {
			f.update(STEP, true)
			if (f.danger && !f.result) sawDanger = true
		}
		expect(f.result).toBe("snapped")
		expect(sawDanger).toBe(true)
		expect(DANGER).toBeLessThan(1)
	})

	it("takes line during a run whether or not you reel", () => {
		const a = new Fight("pike", 5000, 20)
		const b = new Fight("pike", 5000, 20)
		for (const f of [a, b]) {
			f.state = "run"
			f.stateT = 10
		}
		a.update(0.4, false)
		b.update(0.4, true)
		// Reeling still nets progress, but the run costs line either way.
		expect(a.line).toBeGreaterThan(a.startLine)
		expect(b.line).toBeLessThan(b.startLine)
	})

	it("reports progress from nothing to nearly landed", () => {
		const f = new Fight("perch", 500, 20)
		expect(f.progress).toBe(0)
		f.line = 2
		expect(f.progress).toBeGreaterThan(0.85)
	})
})

describe("bite tells", () => {
	it("gives every species a distinct rhythm", () => {
		const commits = SPECIES_IDS.map((id) => new Bite(id, 100, 0).commitAt)
		expect(new Set(commits).size).toBe(SPECIES_IDS.length)
	})

	it("opens the window only after the taps are done", () => {
		const b = new Bite("perch", 500, 0)
		b.update(b.commitAt - 0.05)
		expect(b.phase).toBe("taps")
		expect(b.canHook).toBe(false)
		b.update(0.1)
		expect(b.phase).toBe("window")
		expect(b.canHook).toBe(true)
	})

	it("closes the window and then leaves", () => {
		const b = new Bite("bass", 1500, 0)
		b.update(b.windowEnd + 0.01)
		expect(b.canHook).toBe(false)
		expect(b.expired).toBe(false)
		b.update(0.8)
		expect(b.expired).toBe(true)
	})

	// Big fish are easier to hook and harder to land, on purpose: hooking a
	// sturgeon should feel like the beginning of the problem.
	it("gives slower fish a more generous window", () => {
		expect(SPECIES.sturgeon.tell.windowMs).toBeGreaterThan(SPECIES.sunfish.tell.windowMs)
	})

	it("shows the float going under once it commits", () => {
		const b = new Bite("sturgeon", 12000, 0)
		b.update(b.commitAt + 0.3)
		expect(b.bobberSink()).toBeGreaterThan(SPECIES.sturgeon.tell.sink)
	})

	it("brings the float back up between taps", () => {
		const b = new Bite("sunfish", 200, 0)
		// mid-gap, between two taps
		b.update(SPECIES.sunfish.tell.tapMs / 1000 + 0.04)
		expect(b.bobberSink()).toBe(0)
	})
})

describe("what the water is worth", () => {
	it("catches mostly small fish in open water", () => {
		const counts = {}
		for (let i = 0; i < 3000; i++) {
			const id = rollSpecies(0)
			counts[id] = (counts[id] || 0) + 1
		}
		expect((counts.sunfish || 0) / 3000).toBeGreaterThan(0.4)
		expect((counts.sturgeon || 0) / 3000).toBeLessThan(0.02)
	})

	it("makes the rare fish reachable over a good spot", () => {
		const counts = {}
		for (let i = 0; i < 3000; i++) {
			const id = rollSpecies(1)
			counts[id] = (counts[id] || 0) + 1
		}
		// The whole reason to learn to read the surface.
		expect((counts.sturgeon || 0) / 3000).toBeGreaterThan(0.1)
		expect((counts.pike || 0) / 3000).toBeGreaterThan(0.2)
		expect((counts.sunfish || 0) / 3000).toBeLessThan(0.15)
	})

	it("keeps weights inside the species range", () => {
		for (const id of SPECIES_IDS) {
			for (const q of [0, 0.5, 1]) {
				for (let i = 0; i < 200; i++) {
					const g = rollGrams(id, q)
					expect(g).toBeGreaterThanOrEqual(SPECIES[id].grams[0])
					expect(g).toBeLessThanOrEqual(SPECIES[id].grams[1])
				}
			}
		}
	})
})

describe("scoring", () => {
	it("makes hunting rare fish beat farming common ones", () => {
		// One good pike must be worth more than a bucket of sunfish, or the
		// optimal play is to sit in open water and spam the easy bite.
		const pike = catchScore("pike", 4000, 1)
		const sunfishBucket = 8 * catchScore("sunfish", 320, 1)
		expect(pike).toBeGreaterThan(sunfishBucket)
	})

	it("multiplies by flow", () => {
		expect(catchScore("bass", 2000, 3)).toBe(catchScore("bass", 2000, 1) * 3)
	})

	it("never scores a fish at zero", () => {
		expect(catchScore("sunfish", 90, 1)).toBeGreaterThan(0)
	})

	it("puts a perfect sturgeon well clear of anything else", () => {
		const best = catchScore("sturgeon", 17000, 3)
		const good = catchScore("pike", 6500, 3)
		expect(best / good).toBeGreaterThan(2)
	})
})

// ---------------------------------------------------------------- the bite, played by a human
//
// This suite exists because the bite was certified by a zero-latency sim and
// then failed its first human: the windows were 300-480ms, a first-time player
// needs ~350ms to see the float commit and tap, and sunfish+perch — 83% of
// open-water bites — were near-impossible to hook. The fight got a
// "punishes a thermostat" test after its own version of this mistake; this is
// the bite's equivalent. If a retune ever drops the windows back into reflex
// territory, this fails before a kid does.
describe("the bite, played by a human", () => {
	// Deterministic, so a failure is reproducible — same LCG as collide.test.js.
	let seed = 424242
	const rnd = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff
		return seed / 0x7fffffff
	}

	/**
	 * Reaction latency: mean + spread·(sum of three uniforms − 1.5).
	 *
	 * The SAME model the diagnosis sim used, constants included, so this test
	 * describes the human who actually failed rather than a cleaner one who
	 * would have passed the old windows. Note the effective sd is spread/2
	 * (≈30ms at spread 0.06) — a player of consistent speed, not a twitchy one.
	 */
	const latency = (mean, spread) => mean + spread * (rnd() + rnd() + rnd() - 1.5)

	/** Does a strike at commit+L land inside the species' window? */
	const hooks = (id, L) => {
		const b = new Bite(id, 500, 0)
		b.update(b.commitAt + Math.max(0, L))
		return b.canHook
	}

	it("lets a first-timer hook the common fish", () => {
		// ~350ms: sees the float go under, taps. First run of the game, phone in
		// hand. The common species must not be a reflex bar.
		for (const id of ["sunfish", "perch", "bass"]) {
			let hooked = 0
			for (let i = 0; i < 1000; i++) if (hooks(id, latency(0.35, 0.06))) hooked++
			expect(hooked / 1000, id).toBeGreaterThan(0.9)
		}
	})

	it("still misses when genuinely asleep at the rod", () => {
		// Deterministic, every species: the largest window is 780ms, so a strike
		// 900ms after the take must always be late. The window got wider, not
		// un-missable.
		for (const id of SPECIES_IDS) {
			expect(hooks(id, 0.9), id).toBe(false)
		}
	})

	it("makes a distracted player miss the quick fish more often than not", () => {
		// ~600ms: looking at the scenery. The gate still exists for the species
		// that are supposed to be quick.
		let hooked = 0
		for (let i = 0; i < 1000; i++) if (hooks("sunfish", latency(0.6, 0.06))) hooked++
		expect(hooked / 1000).toBeLessThan(0.4)
	})

	it("still spooks an early strike — the actual skill is untouched", () => {
		const b = new Bite("sunfish", 200, 0)
		b.update(b.commitAt - 0.1)
		expect(b.phase).toBe("taps")
		expect(b.canHook).toBe(false)
	})
})
