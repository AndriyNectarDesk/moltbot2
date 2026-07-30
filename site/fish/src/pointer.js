// Pointer and one button. That is the whole control scheme.
//
// Deliberately NOT ../../shared/input.js. That module is built around pointer
// lock and relative deltas, which is right for a shooter that owns the cursor
// and wrong here: this game never grabs the cursor, and it needs an absolute
// position on the water rather than a stream of movements. Trying to serve both
// from one module would have meant a mode flag threading through every method
// for two consumers that want opposite things.
//
// One button does everything, and what it does depends on what is happening:
// hold and release to cast, tap to set the hook, hold to reel. Mouse, touch and
// Space all feed the same three signals, so nothing downstream cares which was
// used.

export class Pointer {
	constructor(canvas) {
		this.canvas = canvas
		// Normalised device coords, -1..1, y up. Starts mid-screen and slightly
		// out over the water so the reticle is somewhere sensible before the
		// player has moved anything.
		this.nx = 0
		this.ny = 0.05
		this.down = false
		this.pressed = false
		this.released = false
		this.isTouch = matchMedia("(hover: none) and (pointer: coarse)").matches
		this._holdMs = 0
		this._downAt = 0

		const move = (clientX, clientY) => {
			const r = this.canvas.getBoundingClientRect()
			if (!r.width || !r.height) return
			this.nx = ((clientX - r.left) / r.width) * 2 - 1
			this.ny = -(((clientY - r.top) / r.height) * 2 - 1)
		}

		const press = () => {
			if (this.down) return
			this.down = true
			this.pressed = true
			this._downAt = performance.now()
		}

		const release = () => {
			if (!this.down) return
			this.down = false
			this.released = true
			this._holdMs = performance.now() - this._downAt
		}

		canvas.addEventListener("mousemove", (e) => move(e.clientX, e.clientY))
		canvas.addEventListener("mousedown", (e) => {
			if (e.button === 0) press()
		})
		// mouseup on window, not the canvas: releasing outside the canvas must
		// still count, or the rod stays wound up forever.
		addEventListener("mouseup", (e) => {
			if (e.button === 0) release()
		})
		addEventListener("blur", () => release())

		canvas.addEventListener(
			"touchstart",
			(e) => {
				const t = e.changedTouches[0]
				move(t.clientX, t.clientY)
				press()
				e.preventDefault()
			},
			{ passive: false },
		)
		canvas.addEventListener(
			"touchmove",
			(e) => {
				move(e.changedTouches[0].clientX, e.changedTouches[0].clientY)
				e.preventDefault()
			},
			{ passive: false },
		)
		const endTouch = (e) => {
			release()
			e.preventDefault()
		}
		canvas.addEventListener("touchend", endTouch, { passive: false })
		canvas.addEventListener("touchcancel", endTouch, { passive: false })

		// Space is a full alias for the button, so the game is playable one-handed
		// from the keyboard too.
		addEventListener("keydown", (e) => {
			if (e.code === "Space" && !e.repeat) {
				press()
				e.preventDefault()
			}
		})
		addEventListener("keyup", (e) => {
			if (e.code === "Space") release()
		})

		addEventListener("contextmenu", (e) => e.preventDefault())
	}

	/** How long the button was held, in seconds, for the release just consumed. */
	get holdSeconds() {
		return this._holdMs / 1000
	}

	/** Seconds the button has been held so far, for a charge that is still building. */
	get holdingSeconds() {
		return this.down ? (performance.now() - this._downAt) / 1000 : 0
	}

	/** Call at the very end of a frame. */
	endFrame() {
		this.pressed = false
		this.released = false
	}
}
