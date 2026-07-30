// Touch controls: virtual stick, drag-to-look, and action buttons.
//
// These write straight into the existing Input instance, so the rest of the
// game never learns whether a key or a thumb is driving it.

import { clamp } from "../../shared/util.js"

const $ = (id) => document.getElementById(id)

/**
 * Pointer capture keeps a drag alive if the finger slides off the element, but
 * it throws if the pointer is already gone — never let that kill an input
 * handler mid-frame.
 */
function capture(el, id) {
	try {
		el.setPointerCapture?.(id)
	} catch {
		/* pointer already released; the drag still works without capture */
	}
}

export class TouchControls {
	constructor(input) {
		this.input = input
		this.enabled = false
		this.stick = { id: null, ox: 0, oy: 0, x: 0, y: 0 }
		this.look = { id: null, lx: 0, ly: 0 }
		this.lookSensitivity = 1.7
		this.radius = 58
		this.el = {}
	}

	/** Coarse pointer + no hover is the reliable "this is a touchscreen" test. */
	static isTouchDevice() {
		return (
			matchMedia("(hover: none) and (pointer: coarse)").matches ||
			(navigator.maxTouchPoints > 0 && matchMedia("(pointer: coarse)").matches)
		)
	}

	attach() {
		this.el = {
			root: $("touch"),
			left: $("touch-left"),
			right: $("touch-right"),
			base: $("stick-base"),
			knob: $("stick-knob"),
		}
		if (!this.el.root) return
		this.enabled = true
		document.body.classList.add("touch")

		// ---- movement stick (left half)
		this.el.left.addEventListener("pointerdown", (e) => {
			if (this.stick.id !== null) return
			this.stick.id = e.pointerId
			this.stick.ox = e.clientX
			this.stick.oy = e.clientY
			capture(this.el.left, e.pointerId)
			this._placeStick(e.clientX, e.clientY, true)
			e.preventDefault()
		})
		this.el.left.addEventListener("pointermove", (e) => {
			if (e.pointerId !== this.stick.id) return
			this._placeStick(e.clientX, e.clientY, false)
			e.preventDefault()
		})
		const endStick = (e) => {
			if (e.pointerId !== this.stick.id) return
			this.stick.id = null
			this.stick.x = 0
			this.stick.y = 0
			this.el.base.classList.remove("active")
		}
		this.el.left.addEventListener("pointerup", endStick)
		this.el.left.addEventListener("pointercancel", endStick)

		// ---- look (right half)
		this.el.right.addEventListener("pointerdown", (e) => {
			if (this.look.id !== null) return
			this.look.id = e.pointerId
			this.look.lx = e.clientX
			this.look.ly = e.clientY
			capture(this.el.right, e.pointerId)
			e.preventDefault()
		})
		this.el.right.addEventListener("pointermove", (e) => {
			if (e.pointerId !== this.look.id) return
			const dx = e.clientX - this.look.lx
			const dy = e.clientY - this.look.ly
			this.look.lx = e.clientX
			this.look.ly = e.clientY
			// Feed the same channel the mouse uses.
			this.input.mouse.dx += dx * 0.0034 * this.lookSensitivity * this.input.sensitivity
			this.input.mouse.dy +=
				dy * 0.0034 * this.lookSensitivity * this.input.sensitivity * (this.input.invertY ? -1 : 1)
			e.preventDefault()
		})
		const endLook = (e) => {
			if (e.pointerId !== this.look.id) return
			this.look.id = null
		}
		this.el.right.addEventListener("pointerup", endLook)
		this.el.right.addEventListener("pointercancel", endLook)

		// ---- action buttons
		this._button("btn-fire", {
			down: () => (this.input.mouse.left = true),
			up: () => (this.input.mouse.left = false),
		})
		this._button("btn-beam", {
			down: () => {
				this.input.mouse.right = true
				this.input.mouse.rightPressed = true
			},
			up: () => {
				this.input.mouse.right = false
				this.input.mouse.rightReleased = true
			},
		})
		this._button("btn-jump", {
			down: () => {
				this.input.keys.add("Space")
				this.input.pressed.add("Space")
			},
			up: () => this.input.keys.delete("Space"),
		})
		this._button("btn-dash", {
			down: () => {
				this.input.keys.add("ShiftLeft")
				this.input.pressed.add("ShiftLeft")
			},
			up: () => this.input.keys.delete("ShiftLeft"),
		})
		this._button("btn-nova", {
			down: () => {
				this.input.keys.add("KeyQ")
				this.input.pressed.add("KeyQ")
			},
			up: () => this.input.keys.delete("KeyQ"),
		})
	}

	_button(id, { down, up }) {
		const el = $(id)
		if (!el) return
		const press = (e) => {
			e.preventDefault()
			e.stopPropagation()
			el.classList.add("held")
			capture(el, e.pointerId)
			down()
		}
		const release = (e) => {
			e.stopPropagation()
			el.classList.remove("held")
			up()
		}
		el.addEventListener("pointerdown", press)
		el.addEventListener("pointerup", release)
		el.addEventListener("pointercancel", release)
		el.addEventListener("pointerleave", release)
	}

	_placeStick(x, y, recenter) {
		const s = this.stick
		if (recenter) {
			// Drop the stick wherever the thumb landed rather than a fixed spot.
			this.el.base.style.left = `${x}px`
			this.el.base.style.top = `${y}px`
			this.el.base.classList.add("active")
		}
		let dx = x - s.ox
		let dy = y - s.oy
		const len = Math.hypot(dx, dy)
		if (len > this.radius) {
			dx = (dx / len) * this.radius
			dy = (dy / len) * this.radius
		}
		this.el.knob.style.transform = `translate(-50%,-50%) translate(${dx}px, ${dy}px)`
		s.x = clamp(dx / this.radius, -1, 1)
		s.y = clamp(-dy / this.radius, -1, 1) // screen-down is backwards
	}

	/** Movement axes from the stick, or null when it isn't being held. */
	axes() {
		if (!this.enabled || this.stick.id === null) return null
		// Small dead zone so a resting thumb doesn't drift.
		const dead = 0.16
		const m = Math.hypot(this.stick.x, this.stick.y)
		if (m < dead) return { x: 0, y: 0 }
		return { x: this.stick.x, y: this.stick.y }
	}

	/** Release everything — used when the game pauses or a screen opens. */
	releaseAll() {
		this.stick.id = null
		this.stick.x = 0
		this.stick.y = 0
		this.look.id = null
		this.el.base?.classList.remove("active")
		for (const id of ["btn-fire", "btn-beam", "btn-jump", "btn-dash", "btn-nova"]) {
			$(id)?.classList.remove("held")
		}
		this.input.mouse.left = false
		this.input.mouse.right = false
		this.input.keys.delete("Space")
		this.input.keys.delete("ShiftLeft")
		this.input.keys.delete("KeyQ")
	}

	setVisible(on) {
		if (this.el.root) this.el.root.classList.toggle("hidden", !on)
	}
}
