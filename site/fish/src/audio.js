// Fully procedural audio — no sample files, everything is synthesised with WebAudio.
//
// The synthesis engine below (init/_env/_tone/_noise and the look-ahead music
// scheduler) is copied verbatim from the shooter. What is replaced is everything
// above it in the stack: the sound bank and the music. A shooter wants sharp
// transients and a driving minor arpeggio; a lake at dawn wants soft attacks and
// a slow pentatonic pad, and no amount of parameterising one into the other
// would have been worth the seam.

import { clamp, rand } from "../../shared/util.js"

export class Audio {
	constructor() {
		this.ctx = null
		this.enabled = true
		this.master = null
		this.musicGain = null
		this.sfxGain = null
		this.noiseBuffer = null
		this._musicTimer = null
		this._step = 0
		this._nextNote = 0
		this.intensity = 0 // 0..1, lifts the music as the clock runs down
	}

	/** Must be called from a user gesture. */
	init() {
		if (this.ctx) return
		const AC = window.AudioContext || window.webkitAudioContext
		if (!AC) {
			this.enabled = false
			return
		}
		this.ctx = new AC()
		this.master = this.ctx.createGain()
		this.master.gain.value = 0.75
		this.master.connect(this.ctx.destination)

		// A gentle limiter keeps the big explosions from clipping.
		const comp = this.ctx.createDynamicsCompressor()
		comp.threshold.value = -12
		comp.ratio.value = 8
		comp.attack.value = 0.003
		comp.release.value = 0.18
		comp.connect(this.master)
		this.bus = comp

		this.musicGain = this.ctx.createGain()
		this.musicGain.gain.value = 0.0
		this.musicGain.connect(this.bus)

		this.sfxGain = this.ctx.createGain()
		this.sfxGain.gain.value = 0.9
		this.sfxGain.connect(this.bus)

		// Pre-baked white noise, reused by every noise-based effect.
		const len = this.ctx.sampleRate * 2
		this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
		const data = this.noiseBuffer.getChannelData(0)
		for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
	}

	resume() {
		if (this.ctx && this.ctx.state === "suspended") this.ctx.resume()
	}

	setEnabled(on) {
		this.enabled = on
		if (this.master) this.master.gain.value = on ? 0.75 : 0
	}

	get t() {
		return this.ctx.currentTime
	}

	_ready() {
		return this.ctx && this.enabled
	}

	_env(node, t0, peak, attack, decay) {
		const g = node.gain
		g.cancelScheduledValues(t0)
		g.setValueAtTime(0.0001, t0)
		g.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + attack)
		g.exponentialRampToValueAtTime(0.0001, t0 + attack + decay)
	}

	_tone({ type = "sine", freq = 440, to = null, dur = 0.2, gain = 0.3, attack = 0.005, dest = null, detune = 0 }) {
		const t0 = this.t
		const osc = this.ctx.createOscillator()
		const g = this.ctx.createGain()
		osc.type = type
		osc.frequency.setValueAtTime(freq, t0)
		osc.detune.value = detune
		if (to !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(to, 1), t0 + dur)
		this._env(g, t0, gain, attack, dur)
		osc.connect(g)
		g.connect(dest || this.sfxGain)
		osc.start(t0)
		osc.stop(t0 + dur + attack + 0.05)
		return { osc, g }
	}

	_noise({ dur = 0.3, gain = 0.3, type = "lowpass", freq = 1200, to = null, q = 1, dest = null }) {
		const t0 = this.t
		const src = this.ctx.createBufferSource()
		src.buffer = this.noiseBuffer
		src.loop = true
		const filt = this.ctx.createBiquadFilter()
		filt.type = type
		filt.frequency.setValueAtTime(freq, t0)
		filt.Q.value = q
		if (to !== null) filt.frequency.exponentialRampToValueAtTime(Math.max(to, 20), t0 + dur)
		const g = this.ctx.createGain()
		this._env(g, t0, gain, 0.006, dur)
		src.connect(filt)
		filt.connect(g)
		g.connect(dest || this.sfxGain)
		src.start(t0)
		src.stop(t0 + dur + 0.1)
	}

	// ---------------------------------------------------------------- SFX
	// ------------------------------------------------------------ the lake

	/** Rod whip and the line hissing off the reel. Longer cast, longer hiss. */
	cast(power = 0.5) {
		if (!this._ready()) return
		this._noise({ dur: 0.1 + power * 0.16, gain: 0.1, type: "highpass", freq: 900, to: 2600, q: 0.7 })
		this._tone({ type: "sine", freq: 320, to: 190, dur: 0.14, gain: 0.05 })
	}

	/** The float landing. A soft plop, not a splash — this is a small float. */
	splash() {
		if (!this._ready()) return
		this._tone({ type: "sine", freq: 640, to: 130, dur: 0.16, gain: 0.16 })
		this._noise({ dur: 0.2, gain: 0.09, type: "lowpass", freq: 1400, to: 340 })
	}

	/** A fish testing the bait. Pitched by how hard it pulled, so tells are audible. */
	nibble(sink = 0.1) {
		if (!this._ready()) return
		const f = 520 - sink * 700
		this._tone({ type: "triangle", freq: f, to: f * 0.7, dur: 0.1, gain: 0.1 })
	}

	/**
	 * The take — the moment the float goes under and the strike window opens.
	 * This is the ONE moment the whole bite funnel turns on, and it used to be
	 * silent: nibble plays when the taps start, hook after a successful strike,
	 * and nothing marked the instant between. On a phone the float is a few
	 * pixels, so ears have to be able to carry this. A single low gulp, clearly
	 * not nibble's tick and quieter than hook, which stays the game's one sharp
	 * sound.
	 */
	take() {
		if (!this._ready()) return
		this._tone({ type: "sine", freq: 400, to: 150, dur: 0.18, gain: 0.12 })
		this._noise({ dur: 0.14, gain: 0.05, type: "lowpass", freq: 900, to: 300 })
	}

	/** Setting the hook: the one sharp sound in the game, because it earned it. */
	hook() {
		if (!this._ready()) return
		this._noise({ dur: 0.12, gain: 0.16, type: "bandpass", freq: 1700, q: 1.4 })
		this._tone({ type: "square", freq: 300, to: 520, dur: 0.12, gain: 0.09 })
	}

	/**
	 * The telegraph: the fish gathering itself. Deliberately a rising two-note
	 * figure so it reads as "something is about to happen" rather than as a hit —
	 * this is the cue that the whole fight skill hangs on, so it has to land even
	 * if the player is looking at the water instead of the bar.
	 */
	brace() {
		if (!this._ready()) return
		this._tone({ type: "triangle", freq: 300, to: 470, dur: 0.16, gain: 0.11, attack: 0.01 })
		this._noise({ dur: 0.16, gain: 0.05, type: "bandpass", freq: 420, q: 1.2 })
	}

	/** A fresh run — a low surge under the line. */
	surge() {
		if (!this._ready()) return
		this._tone({ type: "sine", freq: 90, to: 58, dur: 0.4, gain: 0.16 })
		this._noise({ dur: 0.3, gain: 0.05, type: "lowpass", freq: 500 })
	}

	/** The line going. Deliberately the ugliest sound here. */
	snap() {
		if (!this._ready()) return
		this._noise({ dur: 0.12, gain: 0.3, type: "highpass", freq: 2200 })
		this._tone({ type: "sawtooth", freq: 780, to: 120, dur: 0.22, gain: 0.14 })
	}

	/** It got away quietly. */
	spook() {
		if (!this._ready()) return
		this._tone({ type: "sine", freq: 300, to: 170, dur: 0.26, gain: 0.09 })
		this._noise({ dur: 0.22, gain: 0.06, type: "lowpass", freq: 800, to: 300 })
	}

	/**
	 * Landed. The rarer the fish the higher and longer the chime climbs, so a
	 * sturgeon is audibly different from a sunfish before you read the card.
	 */
	landed(rare = 1) {
		if (!this._ready()) return
		this._tone({ type: "sine", freq: 480, to: 200, dur: 0.2, gain: 0.13 })
		this._noise({ dur: 0.26, gain: 0.1, type: "lowpass", freq: 1200, to: 300 })
		// Pentatonic, so any number of notes still lands in tune.
		const notes = [523.25, 587.33, 698.46, 783.99, 932.33]
		const n = Math.min(notes.length, 2 + Math.round(Math.log2(rare)))
		for (let i = 0; i < n; i++) {
			setTimeout(
				() =>
					this._ready() &&
					this._tone({ type: "triangle", freq: notes[i], dur: 0.3, gain: 0.1, attack: 0.02 }),
				120 + i * 95,
			)
		}
	}

	/** End of the three minutes. A soft two-note fall, not a buzzer. */
	runOver() {
		if (!this._ready()) return
		for (const [i, f] of [392, 261.63].entries()) {
			setTimeout(
				() =>
					this._ready() &&
					this._tone({ type: "triangle", freq: f, dur: 0.9, gain: 0.14, attack: 0.05 }),
				i * 420,
			)
		}
	}

	// ------------------------------------------------------------ music

	startMusic() {
		if (!this._ready() || this._musicTimer) return
		this.musicGain.gain.cancelScheduledValues(this.t)
		this.musicGain.gain.setValueAtTime(0.0001, this.t)
		this.musicGain.gain.exponentialRampToValueAtTime(0.2, this.t + 4)
		this._nextNote = this.t + 0.1
		this._step = 0
		this._musicTimer = setInterval(() => this._schedule(), 60)
	}

	stopMusic() {
		if (this._musicTimer) {
			clearInterval(this._musicTimer)
			this._musicTimer = null
		}
		if (this.musicGain && this.ctx) {
			const t = this.t
			this.musicGain.gain.cancelScheduledValues(t)
			this.musicGain.gain.setValueAtTime(Math.max(this.musicGain.gain.value, 0.0002), t)
			this.musicGain.gain.exponentialRampToValueAtTime(0.0001, t + 1.4)
		}
	}

	/** Look-ahead scheduler, same as the shooter's — just far slower. */
	_schedule() {
		if (!this._ready()) return
		// 52 bpm, barely moving, and it only creeps up as the clock runs out.
		const bpm = 52 + this.intensity * 10
		const spb = 60 / bpm / 2
		while (this._nextNote < this.t + 0.5) {
			this._playStep(this._step, this._nextNote, spb)
			this._step = (this._step + 1) % 32
			this._nextNote += spb
		}
	}

	_playStep(step, when, spb) {
		const ctx = this.ctx
		// D-major pentatonic over a slow I-vi-IV-V wander. No minor third
		// anywhere, which is most of why it reads as calm rather than wistful.
		const roots = [73.42, 61.74, 98, 82.41]
		const bar = Math.floor(step / 8) % 4
		const root = roots[bar]

		// A long low pad note at the top of each bar.
		if (step % 8 === 0) {
			for (const mult of [1, 2, 3]) {
				const o = ctx.createOscillator()
				const g = ctx.createGain()
				const f = ctx.createBiquadFilter()
				o.type = "sine"
				o.frequency.setValueAtTime(root * mult, when)
				o.detune.setValueAtTime(rand(-6, 6), when)
				f.type = "lowpass"
				f.frequency.setValueAtTime(700 + this.intensity * 500, when)
				g.gain.setValueAtTime(0.0001, when)
				g.gain.exponentialRampToValueAtTime(0.16 / mult, when + 0.8)
				g.gain.exponentialRampToValueAtTime(0.0001, when + spb * 7.6)
				o.connect(f)
				f.connect(g)
				g.connect(this.musicGain)
				o.start(when)
				o.stop(when + spb * 8)
			}
		}

		// A sparse pentatonic drop, like the odd bird over the water.
		if (step % 4 === 2 && Math.random() < 0.5) {
			const scale = [293.66, 329.63, 369.99, 440, 493.88, 587.33]
			const o = ctx.createOscillator()
			const g = ctx.createGain()
			o.type = "triangle"
			o.frequency.setValueAtTime(scale[Math.floor(Math.random() * scale.length)], when)
			g.gain.setValueAtTime(0.0001, when)
			g.gain.exponentialRampToValueAtTime(0.07, when + 0.06)
			g.gain.exponentialRampToValueAtTime(0.0001, when + spb * 2.4)
			o.connect(g)
			g.connect(this.musicGain)
			o.start(when)
			o.stop(when + spb * 3)
		}
	}


	setIntensity(v) {
		this.intensity = clamp(v, 0, 1)
	}
}
