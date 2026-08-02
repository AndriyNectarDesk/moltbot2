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
		// Button id → the set of pointers currently holding it. Levels, not edges:
		// the game polls this every frame the same way it polls the key set.
		// Counted per pointer for the same reason fish's pointer.js counts its
		// sources: with a plain flag, a second finger grazing GAS and lifting
		// would release the pedal under the finger still pressing it — which
		// mid-shift reads as the game ignoring the button.
		this._held = new Map()
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
		const down = (id) => (this._held.get(id)?.size ?? 0) > 0
		return {
			throttle: (down("tc-gas") ? 1 : 0) - (down("tc-brake") ? 1 : 0),
			steer: (down("tc-right") ? 1 : 0) - (down("tc-left") ? 1 : 0),
			handbrake: down("tc-drift"),
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
			let holders = this._held.get(id)
			if (!holders) this._held.set(id, (holders = new Set()))
			holders.add(e.pointerId)
		}
		const release = (e) => {
			e.stopPropagation()
			const holders = this._held.get(id)
			holders?.delete(e.pointerId)
			// Only when the last finger leaves — a second finger grazing the pedal
			// and lifting must not release it under the one still pressing.
			if (!holders || holders.size === 0) el.classList.remove("held")
		}
		el.addEventListener("pointerdown", press)
		el.addEventListener("pointerup", release)
		// With pointer capture held, a finger sliding off never fires leave —
		// events stay retargeted at the button until pointerup or pointercancel,
		// which is what actually guarantees a pedal can't stick. The leave
		// listener is belt-and-braces for the no-capture fallback in `capture()`.
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
