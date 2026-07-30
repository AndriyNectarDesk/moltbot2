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

		// Which sources are currently holding the button down. Counted rather than
		// a single flag because mouse, touch and Space are all aliases for the same
		// button: without this, resting a hand on Space while reeling with the
		// mouse would release the reel on keyup even though the mouse was still
		// held, and lifting a second finger would drop a touch hold. Mid-fight that
		// reads as the game ignoring the button.
		const held = new Set()

		const press = (source) => {
			held.add(source)
			if (this.down) return
			this.down = true
			this.pressed = true
			this._downAt = performance.now()
		}

		const release = (source) => {
			held.delete(source)
			if (!this.down || held.size > 0) return
			this.down = false
			this.released = true
			this._holdMs = performance.now() - this._downAt
		}

		const releaseAll = () => {
			held.clear()
			release("*")
		}

		canvas.addEventListener("mousemove", (e) => move(e.clientX, e.clientY))
		canvas.addEventListener("mousedown", (e) => {
			if (e.button === 0) press("mouse")
		})
		// mouseup on window, not the canvas: releasing outside the canvas must
		// still count, or the rod stays wound up forever.
		addEventListener("mouseup", (e) => {
			if (e.button === 0) release("mouse")
		})
		addEventListener("blur", () => releaseAll())

		canvas.addEventListener(
			"touchstart",
			(e) => {
				const t = e.changedTouches[0]
				move(t.clientX, t.clientY)
				press("touch")
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
			// Only when the last finger leaves — a second finger lifting must not
			// drop the hold.
			if (e.touches.length === 0) release("touch")
			e.preventDefault()
		}
		canvas.addEventListener("touchend", endTouch, { passive: false })
		canvas.addEventListener("touchcancel", endTouch, { passive: false })

		// Space is a full alias for the button, so the game is playable one-handed
		// from the keyboard too.
		addEventListener("keydown", (e) => {
			if (e.code === "Space" && !e.repeat) {
				press("key")
				// Only swallow the key while a run is actually in progress, so Space
				// can still activate a focused button on the menus.
				if (document.getElementById("hud") && !document.getElementById("hud").classList.contains("hidden")) {
					e.preventDefault()
				}
			}
		})
		addEventListener("keyup", (e) => {
			if (e.code === "Space") release("key")
		})

		addEventListener("contextmenu", (e) => e.preventDefault())
	}

	/** Call at the very end of a frame. */
	endFrame() {
		this.pressed = false
		this.released = false
	}
}
