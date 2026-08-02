// @vitest-environment happy-dom
//
// The touch driving controls, exercised through real pointer events.
//
// The singles are asserted BEFORE the compounds on purpose: gas+brake → 0 and
// left+right → 0 are also what a completely dead event wire produces, so on
// their own they would pass vacuously — the repo has been burned by exactly
// that shape of test three times (see ARCADE.md).

import { beforeEach, describe, expect, it } from "vitest"
import { CityTouch, mergeControls } from "./touch.js"

const NEUTRAL = { throttle: 0, steer: 0, handbrake: false }

function mount() {
	document.body.innerHTML = `
		<div id="touch" class="hidden">
			<div id="tc-steer">
				<button id="tc-left"></button>
				<button id="tc-right"></button>
			</div>
			<div id="tc-pedals">
				<button id="tc-drift"></button>
				<button id="tc-brake"></button>
				<button id="tc-gas"></button>
			</div>
		</div>`
	const touch = new CityTouch()
	touch.attach()
	return touch
}

const fire = (id, type, pointerId = 1) =>
	document.getElementById(id).dispatchEvent(new window.PointerEvent(type, { pointerId, bubbles: true }))

let touch

beforeEach(() => {
	touch = mount()
})

describe("the pedals", () => {
	it("starts neutral", () => {
		expect(touch.state).toEqual(NEUTRAL)
	})

	it("gas alone accelerates", () => {
		fire("tc-gas", "pointerdown")
		expect(touch.state).toEqual({ throttle: 1, steer: 0, handbrake: false })
		fire("tc-gas", "pointerup")
		expect(touch.state).toEqual(NEUTRAL)
	})

	it("brake alone brakes", () => {
		fire("tc-brake", "pointerdown")
		expect(touch.state.throttle).toBe(-1)
	})

	it("each steer button steers its own way", () => {
		fire("tc-left", "pointerdown")
		expect(touch.state.steer).toBe(-1)
		fire("tc-left", "pointerup")
		fire("tc-right", "pointerdown")
		expect(touch.state.steer).toBe(1)
	})

	it("drift is the handbrake", () => {
		fire("tc-drift", "pointerdown")
		expect(touch.state.handbrake).toBe(true)
		fire("tc-drift", "pointerup")
		expect(touch.state.handbrake).toBe(false)
	})

	// Only meaningful because the singles above prove the wire is live.
	it("opposed inputs cancel, like the keyboard already does", () => {
		fire("tc-gas", "pointerdown", 1)
		fire("tc-brake", "pointerdown", 2)
		expect(touch.state.throttle).toBe(0)
		fire("tc-left", "pointerdown", 3)
		fire("tc-right", "pointerdown", 4)
		expect(touch.state.steer).toBe(0)
	})
})

describe("nothing can stick", () => {
	// A finger sliding off a pedal is the single worst failure mode on a phone:
	// the car keeps accelerating and no further tap on that button fixes it.
	it("releases when the finger slides off the button", () => {
		fire("tc-gas", "pointerdown")
		expect(touch.state.throttle).toBe(1)
		fire("tc-gas", "pointerleave")
		expect(touch.state.throttle).toBe(0)
	})

	it("releases when the browser steals the gesture", () => {
		fire("tc-gas", "pointerdown")
		fire("tc-gas", "pointercancel")
		expect(touch.state.throttle).toBe(0)
	})

	// The inverse hazard: two fingers on ONE pedal, and the first to lift must
	// not release it under the finger still pressing. Fish's pointer.js counts
	// its sources for exactly this reason.
	it("keeps a pedal held while any finger is still on it", () => {
		fire("tc-gas", "pointerdown", 1)
		fire("tc-gas", "pointerdown", 2)
		fire("tc-gas", "pointerup", 1)
		expect(touch.state.throttle).toBe(1)
		expect(document.getElementById("tc-gas").classList.contains("held")).toBe(true)
		fire("tc-gas", "pointerup", 2)
		expect(touch.state.throttle).toBe(0)
		expect(document.getElementById("tc-gas").classList.contains("held")).toBe(false)
	})

	it("releases everything when the window blurs, like the keyboard does", () => {
		fire("tc-gas", "pointerdown", 1)
		fire("tc-drift", "pointerdown", 2)
		window.dispatchEvent(new window.Event("blur"))
		expect(touch.state).toEqual(NEUTRAL)
	})

	it("releases everything when hidden — the shift ending mid-hold", () => {
		fire("tc-gas", "pointerdown", 1)
		fire("tc-left", "pointerdown", 2)
		touch.setVisible(true)
		touch.setVisible(false)
		expect(touch.state).toEqual(NEUTRAL)
		expect(document.getElementById("touch").classList.contains("hidden")).toBe(true)
		expect(document.querySelectorAll(".held")).toHaveLength(0)
	})
})

describe("mergeControls", () => {
	// This is the function _readInput actually calls, not a re-implementation.
	it("passes touch through an idle keyboard untouched", () => {
		expect(mergeControls(NEUTRAL, { throttle: 1, steer: -1, handbrake: true })).toEqual({
			throttle: 1,
			steer: -1,
			handbrake: true,
		})
	})

	it("clamps a key and a pedal held together to what either alone gives", () => {
		expect(mergeControls({ throttle: 1, steer: 1, handbrake: false }, { throttle: 1, steer: 1, handbrake: false }))
			.toEqual({ throttle: 1, steer: 1, handbrake: false })
	})

	it("lets a key and a pedal cancel, like two opposing keys already do", () => {
		expect(mergeControls({ throttle: 1, steer: 0, handbrake: false }, { throttle: -1, steer: 0, handbrake: false }).throttle).toBe(0)
	})

	it("takes the handbrake from either source", () => {
		expect(mergeControls({ ...NEUTRAL, handbrake: true }, NEUTRAL).handbrake).toBe(true)
		expect(mergeControls(NEUTRAL, { ...NEUTRAL, handbrake: true }).handbrake).toBe(true)
	})
})
