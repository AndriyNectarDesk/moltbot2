// Render quality tiers + an adaptive scaler.
//
// The game was originally tuned on the assumption that everything could run at
// full resolution with bloom, MSAA and 2048px shadows. On integrated graphics
// that is far too much, so quality is now a first-class setting: pick a tier by
// hand, or leave it on "auto" and let the frame time decide.

export const PRESETS = {
	potato: {
		label: "POTATO",
		maxPixelRatio: 0.6,
		bloom: false,
		bloomScale: 0.4,
		shadows: false,
		shadowSize: 512,
		particleScale: 0.25,
		deco: false,
		clouds: false,
		shield: false,
	},
	low: {
		label: "LOW",
		maxPixelRatio: 0.85,
		bloom: false,
		bloomScale: 0.4,
		shadows: false,
		shadowSize: 512,
		particleScale: 0.45,
		deco: true,
		clouds: false,
		shield: true,
	},
	medium: {
		label: "MEDIUM",
		maxPixelRatio: 1,
		bloom: true,
		bloomScale: 0.5,
		shadows: false,
		shadowSize: 1024,
		particleScale: 0.75,
		deco: true,
		clouds: true,
		shield: true,
	},
	high: {
		label: "HIGH",
		maxPixelRatio: 1.35,
		bloom: true,
		bloomScale: 0.65,
		shadows: true,
		shadowSize: 1024,
		particleScale: 1,
		deco: true,
		clouds: true,
		shield: true,
	},
}

export const ORDER = ["potato", "low", "medium", "high"]

// Frame-time thresholds in ms. Drop a tier if we're consistently slower than
// DROP_MS; only climb back if we're comfortably faster than RAISE_MS.
const DROP_MS = 22 // ~45fps
const RAISE_MS = 11.5 // ~87fps
const DROP_AFTER = 1.2 // seconds of sustained slowness before dropping
const STALL_MS = 2000 // beyond this it's a tab switch or a breakpoint, not lag
const RAISE_AFTER = 9 // much slower to climb, to avoid oscillating

export class Quality {
	constructor(game) {
		this.game = game
		this.auto = true
		this.tier = "medium"
		this.slowT = 0
		this.fastT = 0
		this.frameMs = 16.7
		this.fps = 60
		this._fpsAccum = 0
		this._fpsFrames = 0
		this.onChange = null
		// Give the scene a moment to settle before judging performance.
		this.grace = 2.5
	}

	get preset() {
		return PRESETS[this.tier]
	}

	/** Pick a sensible starting tier before we have any frame-time data. */
	detectInitialTier() {
		const dpr = window.devicePixelRatio || 1
		const px = window.innerWidth * window.innerHeight * dpr * dpr
		const cores = navigator.hardwareConcurrency || 4
		const mem = navigator.deviceMemory || 4

		let tier = "medium"
		// A lot of pixels to push, or a modest machine → start lower.
		if (px > 4.5e6 || cores <= 4 || mem <= 4) tier = "low"
		if (px > 8e6 && cores <= 4) tier = "potato"
		if (px < 2.6e6 && cores >= 8 && mem >= 8) tier = "high"
		return tier
	}

	setAuto(on) {
		this.auto = on
		this.slowT = 0
		this.fastT = 0
	}

	set(tier, { fromAuto = false } = {}) {
		if (!PRESETS[tier] || tier === this.tier) return false
		this.tier = tier
		this.apply()
		this.slowT = 0
		this.fastT = 0
		this.grace = 1
		this.onChange?.(tier, fromAuto)
		return true
	}

	/** Push the current preset into the renderer, world and effects. */
	apply() {
		const p = this.preset
		const g = this.game

		const dpr = Math.min(window.devicePixelRatio || 1, p.maxPixelRatio)
		if (g.renderer.getPixelRatio() !== dpr) {
			g.renderer.setPixelRatio(dpr)
			g._resize()
		}

		g.bloom.enabled = p.bloom && g.options.bloom
		g.renderer.shadowMap.enabled = p.shadows
		g.world.setShadows(p.shadows, p.shadowSize)
		g.world.setDecor(p.deco, p.clouds, p.shield)
		g.fx.setScale(p.particleScale)
	}

	/**
	 * Call once per frame. Timing is measured here rather than taken from the
	 * caller: the game loop clamps its delta so physics stay sane, and reacting
	 * on clamped time meant a machine at 3fps took ~10 wall-clock seconds to
	 * notice it was struggling. This has to run on real time.
	 */
	sample() {
		const now = performance.now()
		if (this._last === undefined) {
			this._last = now
			return
		}
		const ms = now - this._last
		this._last = now
		// Only discard true stalls — a backgrounded tab, a breakpoint, the OS
		// suspending us. A 400ms frame is NOT a spike to ignore: it is exactly
		// the "unplayable" case this scaler exists to rescue, and an earlier
		// 250ms cutoff here silently disabled it on the slowest machines.
		if (ms > STALL_MS || document.hidden) return
		// Clamp only what feeds the average, so one bad frame can't dominate it.
		this.frameMs = this.frameMs * 0.9 + Math.min(ms, 500) * 0.1

		this._fpsAccum += ms
		this._fpsFrames++
		if (this._fpsAccum >= 500) {
			this.fps = Math.round(1000 / (this._fpsAccum / this._fpsFrames))
			this._fpsAccum = 0
			this._fpsFrames = 0
		}

		const dt = ms / 1000
		if (this.grace > 0) {
			this.grace -= dt
			return
		}
		if (!this.auto) return

		if (this.frameMs > DROP_MS) {
			this.slowT += dt
			this.fastT = 0
			if (this.slowT > DROP_AFTER) {
				const i = ORDER.indexOf(this.tier)
				if (i > 0) this.set(ORDER[i - 1], { fromAuto: true })
				else this.slowT = 0
			}
		} else if (this.frameMs < RAISE_MS) {
			this.fastT += dt
			this.slowT = 0
			if (this.fastT > RAISE_AFTER) {
				const i = ORDER.indexOf(this.tier)
				if (i < ORDER.length - 1) this.set(ORDER[i + 1], { fromAuto: true })
				else this.fastT = 0
			}
		} else {
			this.slowT = Math.max(0, this.slowT - dt)
			this.fastT = Math.max(0, this.fastT - dt)
		}
	}
}
