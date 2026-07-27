// Keyboard + mouse with pointer lock. Exposes per-frame deltas and edge-triggered presses.

export class Input {
	constructor(canvas) {
		this.canvas = canvas
		this.touch = null // set by TouchControls when present
		this.keys = new Set()
		this.pressed = new Set() // consumed once per frame
		this.mouse = { dx: 0, dy: 0, left: false, right: false, leftPressed: false, rightPressed: false, rightReleased: false }
		this.locked = false
		this.sensitivity = 1
		this.invertY = false
		this.onLockChange = null

		addEventListener("keydown", (e) => {
			if (e.repeat) return
			const k = e.code
			this.keys.add(k)
			this.pressed.add(k)
			if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab"].includes(k)) e.preventDefault()
		})
		addEventListener("keyup", (e) => this.keys.delete(e.code))
		addEventListener("blur", () => {
			this.keys.clear()
			this.mouse.left = this.mouse.right = false
		})

		canvas.addEventListener("mousedown", (e) => {
			if (!this.locked) return
			if (e.button === 0) {
				this.mouse.left = true
				this.mouse.leftPressed = true
			}
			if (e.button === 2) {
				this.mouse.right = true
				this.mouse.rightPressed = true
			}
		})
		addEventListener("mouseup", (e) => {
			if (e.button === 0) this.mouse.left = false
			if (e.button === 2) {
				if (this.mouse.right) this.mouse.rightReleased = true
				this.mouse.right = false
			}
		})
		addEventListener("contextmenu", (e) => e.preventDefault())
		addEventListener("mousemove", (e) => {
			if (!this.locked) return
			this.mouse.dx += e.movementX * 0.0022 * this.sensitivity
			this.mouse.dy += e.movementY * 0.0022 * this.sensitivity * (this.invertY ? -1 : 1)
		})

		document.addEventListener("pointerlockchange", () => {
			this.locked = document.pointerLockElement === this.canvas
			if (!this.locked) {
				this.mouse.left = this.mouse.right = false
			}
			this.onLockChange?.(this.locked)
		})
	}

	requestLock() {
		// Touch devices drive the camera by dragging, so there is nothing to lock.
		if (this.touch?.enabled) {
			this.locked = true
			this.onLockChange?.(true)
			return
		}
		if (!this.locked) this.canvas.requestPointerLock?.()
	}

	exitLock() {
		if (this.touch?.enabled) {
			this.locked = false
			this.touch.releaseAll()
			this.onLockChange?.(false)
			return
		}
		if (this.locked) document.exitPointerLock?.()
	}

	down(code) {
		return this.keys.has(code)
	}

	/** True exactly once for each physical key press. */
	once(code) {
		if (this.pressed.has(code)) {
			this.pressed.delete(code)
			return true
		}
		return false
	}

	/** Movement axes in local space: x = strafe (+right), y = forward (+fwd). */
	axes() {
		const stick = this.touch?.axes()
		if (stick) return stick
		let x = 0
		let y = 0
		if (this.down("KeyW") || this.down("ArrowUp")) y += 1
		if (this.down("KeyS") || this.down("ArrowDown")) y -= 1
		if (this.down("KeyD") || this.down("ArrowRight")) x += 1
		if (this.down("KeyA") || this.down("ArrowLeft")) x -= 1
		const len = Math.hypot(x, y)
		if (len > 1) {
			x /= len
			y /= len
		}
		return { x, y }
	}

	/** Call at the very end of a frame. */
	endFrame() {
		this.mouse.dx = 0
		this.mouse.dy = 0
		this.mouse.leftPressed = false
		this.mouse.rightPressed = false
		this.mouse.rightReleased = false
		this.pressed.clear()
	}
}
