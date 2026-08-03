// The synthesis engine every game's Audio class extends — WebAudio plumbing and
// the three synth primitives, moved here after all three games proved them
// byte-identical. The sound bank and the music stay per game: they are the part
// that makes a shooter sound like a shooter and a lake like a lake.
//
// Importable in node as well as the browser: no three.js, and the AudioContext
// is only created inside init() — city's skid.test.js imports through this
// module without ever calling it.
//
// THE SUBCLASS CONTRACT. Game banks and music schedulers reach into:
//   this.ctx, this.t, this._ready()      guard + clock
//   this._tone(), this._noise(), _env()  the primitives
//   this.sfxGain, this.musicGain         the two busses (route through this.bus)
//   this.noiseBuffer                     pre-baked white noise (hats, skids)
//   this.intensity                       0..1 — each game maps its own meaning
//   this._step, this._nextNote,          state for the per-game look-ahead
//   this._musicTimer                     music schedulers; UNUSED in this file
//                                        on purpose — do not delete as dead
// Renaming or removing any of these breaks three games, not one file.

import { clamp } from "./util.js"

export class AudioEngine {
	constructor() {
		this.ctx = null
		this.enabled = true
		this.master = null
		this.bus = null
		this.musicGain = null
		this.sfxGain = null
		this.noiseBuffer = null
		this._musicTimer = null
		this._step = 0
		this._nextNote = 0
		this.intensity = 0 // 0..1 — each game maps its own meaning onto it
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

	setIntensity(v) {
		this.intensity = clamp(v, 0, 1)
	}
}
