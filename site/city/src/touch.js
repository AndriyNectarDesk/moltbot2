// Touch driving controls: steer buttons on the left, pedals on the right.
//
// Deliberately NOT nova's virtual stick, and deliberately digital. The car's
// physics has only ever been fed ±1 from the keyboard — `car.js` applies steer
// raw and gets its progressiveness from the speed-dependent shaping, which was
// tuned against exactly that input. Hold-buttons reproduce the shipped keyboard
// feel bit-for-bit at the physics boundary; a stick would put analog values
// into a path that has never seen one, on devices nobody here can playtest.
//
// Per-game rather than shared, per the copy-first verdict in ARCADE.md: nova
// wants a stick and a look-drag, this wants pedals, fishing wants one button.

const $ = (id) => document.getElementById(id)

/**
 * Keyboard and touch folded into one control set.
 *
 * Additive then clamped, so a key and a pedal held together behave exactly the
 * way two opposing keys already do (W+S cancels; W plus GAS is still just 1).
 * A pure function so the test can exercise the code the game actually runs.
 */
export function mergeControls(kb, touch) {
	const clamp1 = (v) => Math.max(-1, Math.min(1, v))
	return {
		throttle: clamp1(kb.throttle + touch.throttle),
		steer: clamp1(kb.steer + touch.steer),
		handbrake: Boolean(kb.handbrake || touch.handbrake),
	}
}

/**
 * Pointer capture keeps a press alive if the finger wanders, but it throws if
 * the pointer is already gone — never let that kill an input handler.
 */
function capture(el, id) {
	try {
		el.setPointerCapture?.(id)
	} catch {
		/* pointer already released; the press still works without capture */
	}
}

export class CityTouch {
	constructor() {
		this.enabled = false
		// One entry per button currently held, keyed by element id. Levels, not
		// edges: the game polls this every frame the same way it polls the key set.
		this._held = new Set()
	}

	/** Coarse pointer + no hover is the reliable "this is a touchscreen" test. */
	static isTouchDevice() {
		return (
			matchMedia("(hover: none) and (pointer: coarse)").matches ||
			(navigator.maxTouchPoints > 0 && matchMedia("(pointer: coarse)").matches)
		)
	}

	/** What the held buttons add up to. Shape matches what `car.update` takes. */
	get state() {
		const h = this._held
		return {
			throttle: (h.has("tc-gas") ? 1 : 0) - (h.has("tc-brake") ? 1 : 0),
			steer: (h.has("tc-right") ? 1 : 0) - (h.has("tc-left") ? 1 : 0),
			handbrake: h.has("tc-drift"),
		}
	}

	attach() {
		this.root = $("touch")
		if (!this.root) return
		this.enabled = true
		for (const id of ["tc-left", "tc-right", "tc-gas", "tc-brake", "tc-drift"]) {
			this._button(id)
		}
		// The shared Input clears its key set on blur; a held pedal has to match,
		// or switching apps mid-drive leaves the car accelerating on its own.
		addEventListener("blur", () => this.releaseAll())
	}

	_button(id) {
		const el = $(id)
		if (!el) return
		const press = (e) => {
			e.preventDefault()
			e.stopPropagation()
			el.classList.add("held")
			capture(el, e.pointerId)
			this._held.add(id)
		}
		const release = (e) => {
			e.stopPropagation()
			el.classList.remove("held")
			this._held.delete(id)
		}
		el.addEventListener("pointerdown", press)
		el.addEventListener("pointerup", release)
		// cancel and leave both release: a finger sliding off a pedal, or the
		// browser stealing the gesture, must not leave the car driving itself —
		// the stuck pedal is the single worst failure mode on a phone.
		el.addEventListener("pointercancel", release)
		el.addEventListener("pointerleave", release)
	}

	releaseAll() {
		this._held.clear()
		if (!this.root) return
		for (const btn of this.root.querySelectorAll(".held")) btn.classList.remove("held")
	}

	/**
	 * Show only while actually driving. Hiding releases everything, so a pedal
	 * held at the moment the shift clock hits zero cannot keep feeding the car
	 * under the game-over screen.
	 */
	setVisible(on) {
		if (!this.root) return
		this.root.classList.toggle("hidden", !on)
		if (!on) this.releaseAll()
	}
}
