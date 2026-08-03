// CITY LIGHTS' sound bank and music. The synthesis engine — WebAudio setup and
// the _tone/_noise/_env primitives — lives in ../../shared/audioengine.js,
// promoted there once all three games had proved it byte-identical. The bank
// and the music stay here, and they are this game's own.
//
// The music here is a RADIO: three stations you cycle with R, each a different
// pattern over the same scheduler, leaning in as you go faster. That's the
// cheapest possible thing that makes a city feel like a place you're driving
// through rather than a level.

import { clamp } from "../../shared/util.js"
import { DRIFT_AT } from "./car.js"
import { AudioEngine } from "../../shared/audioengine.js"

/**
 * How loud the tyres should be, 0..1, from how far sideways the car slides.
 *
 * Pure and exported so the mapping is testable without an AudioContext.
 *
 * The onset sits at 0.8 x DRIFT_AT — BELOW the threshold where the smoke and
 * the HUD light fire — on purpose: at the visual threshold the level is only
 * ~8%, a quiet pre-squeal that swells into the slide. Tyres chirp before they
 * let go, and for the drifter that chirp is an audible warning you are at the
 * edge before you are over it. The LOUD region is coherent with the visuals;
 * a hard shared threshold would make the sound switch on and off at the
 * boundary instead.
 */
export function skidLevel(slipAmount, airborne) {
	if (airborne) return 0
	return clamp((slipAmount - DRIFT_AT * 0.8) / 6, 0, 1)
}

export class Audio extends AudioEngine {
	// ---------------------------------------------------------------- SFX
	// ------------------------------------------------------------ the city

	/**
	 * The tyre screech, driven per frame while driving (like setIntensity).
	 *
	 * One persistent voice — looped noise through a bandpass — created on first
	 * use and left running at zero gain, which is strictly simpler than a
	 * start/stop lifecycle and matches the radio's persistent scheduler.
	 *
	 * Silence is the DEFAULT: every call schedules a fade-out 250ms in the
	 * future, and the next frame's call cancels it. If frames stop arriving for
	 * any reason — pause, game over, a hidden tab in roam where nothing changes
	 * state — the screech dies on its own within half a second. 250ms rather
	 * than something tighter because this game runs on thermally-throttled
	 * phones where 100-200ms frame gaps are real, and a tighter watchdog would
	 * flutter exactly when the phone is struggling.
	 */
	setSkid(level, speedFrac = 0) {
		if (!this._ready()) return
		if (!this._skid) {
			const src = this.ctx.createBufferSource()
			src.buffer = this.noiseBuffer
			src.loop = true
			const filt = this.ctx.createBiquadFilter()
			filt.type = "bandpass"
			filt.frequency.value = 900
			filt.Q.value = 1.1
			const g = this.ctx.createGain()
			g.gain.value = 0.0001
			src.connect(filt)
			filt.connect(g)
			g.connect(this.sfxGain)
			src.start()
			this._skid = { g, filt }
		}
		const t = this.t
		const gain = this._skid.g.gain
		gain.cancelScheduledValues(t)
		// Fast in, slower out — a screech that lags its slide reads as broken.
		gain.setTargetAtTime(level * 0.14, t, level > 0 ? 0.03 : 0.1)
		gain.setTargetAtTime(0, t + 0.25, 0.1)
		const freq = this._skid.filt.frequency
		freq.cancelScheduledValues(t)
		// Brightens with speed: a motorway slide screams, a car-park one squeals.
		freq.setTargetAtTime(600 + speedFrac * 1400, t, 0.05)
	}

	/** Something solid, at a volume set by how hard you hit it. */
	crash(force = 0.5) {
		if (!this._ready()) return
		this._noise({ dur: 0.18 + force * 0.2, gain: 0.1 + force * 0.22, type: "lowpass", freq: 1400, to: 260 })
		this._tone({ type: "square", freq: 150 - force * 50, to: 60, dur: 0.16, gain: 0.08 + force * 0.1 })
	}

	/** Wheels back on the road. A hard landing thumps. */
	land(hard = false) {
		if (!this._ready()) return
		this._noise({ dur: hard ? 0.22 : 0.12, gain: hard ? 0.18 : 0.08, type: "lowpass", freq: 900, to: 200 })
		if (hard) this._tone({ type: "sine", freq: 110, to: 48, dur: 0.24, gain: 0.16 })
	}

	/** Picking up a star. Bright, brief, and always in tune with the radio. */
	star() {
		if (!this._ready()) return
		const notes = [659.26, 783.99, 987.77]
		notes.forEach((f, i) =>
			setTimeout(
				() => this._ready() && this._tone({ type: "triangle", freq: f, dur: 0.16, gain: 0.1 }),
				i * 55,
			),
		)
	}

	pickup() {
		if (!this._ready()) return
		this._tone({ type: "square", freq: 420, to: 620, dur: 0.12, gain: 0.09 })
	}

	/** A delivery landing — the good sound in this game. */
	delivered() {
		if (!this._ready()) return
		const notes = [523.25, 659.26, 783.99, 1046.5]
		notes.forEach((f, i) =>
			setTimeout(
				() =>
					this._ready() &&
					this._tone({ type: "triangle", freq: f, dur: 0.26, gain: 0.11, attack: 0.01 }),
				i * 70,
			),
		)
	}

	/** A parcel lost. Deliberately deflating rather than harsh. */
	failed() {
		if (!this._ready()) return
		for (const [i, f] of [392, 311.13, 233.08].entries()) {
			setTimeout(
				() => this._ready() && this._tone({ type: "triangle", freq: f, dur: 0.3, gain: 0.1 }),
				i * 130,
			)
		}
	}

	/** End of the shift. */
	runOver() {
		if (!this._ready()) return
		for (const [i, f] of [523.25, 392, 261.63].entries()) {
			setTimeout(
				() =>
					this._ready() &&
					this._tone({ type: "triangle", freq: f, dur: 0.8, gain: 0.13, attack: 0.03 }),
				i * 340,
			)
		}
	}

	// ------------------------------------------------------------ the radio

	/** Station names, in the order R cycles them. */
	get stations() {
		return ["NEON FM", "SLOW LANE", "OFF AIR"]
	}

	setStation(i) {
		this.station = ((i % 3) + 3) % 3
		this._step = 0
	}

	startMusic() {
		if (!this._ready() || this._musicTimer) return
		if (this.station === undefined) this.station = 0
		this.musicGain.gain.cancelScheduledValues(this.t)
		this.musicGain.gain.setValueAtTime(0.0001, this.t)
		this.musicGain.gain.exponentialRampToValueAtTime(0.26, this.t + 2)
		this._nextNote = this.t + 0.1
		this._step = 0
		this._musicTimer = setInterval(() => this._schedule(), 45)
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
			this.musicGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.9)
		}
	}

	_schedule() {
		if (!this._ready()) return
		const bpm = this.station === 1 ? 84 : 112
		const spb = 60 / bpm / 4
		while (this._nextNote < this.t + 0.25) {
			this._playStep(this._step, this._nextNote, spb)
			this._step = (this._step + 1) % 32
			this._nextNote += spb
		}
	}

	_playStep(step, when, spb) {
		if (this.station === 2) return // OFF AIR — just engine and tyres
		const ctx = this.ctx
		// Both stations sit in A minor pentatonic so the star chime always fits.
		const roots = this.station === 1 ? [55, 73.42, 65.41, 49] : [110, 87.31, 98, 73.42]
		const bar = Math.floor(step / 8) % 4
		const root = roots[bar]

		// bass
		if (step % (this.station === 1 ? 8 : 4) === 0) {
			const o = ctx.createOscillator()
			const gn = ctx.createGain()
			const f = ctx.createBiquadFilter()
			o.type = this.station === 1 ? "sine" : "sawtooth"
			o.frequency.setValueAtTime(root, when)
			f.type = "lowpass"
			f.frequency.setValueAtTime(280 + this.intensity * 900, when)
			gn.gain.setValueAtTime(0.0001, when)
			gn.gain.exponentialRampToValueAtTime(0.26, when + 0.02)
			gn.gain.exponentialRampToValueAtTime(0.0001, when + spb * (this.station === 1 ? 7 : 3.4))
			o.connect(f)
			f.connect(gn)
			gn.connect(this.musicGain)
			o.start(when)
			o.stop(when + spb * 8)
		}

		// arpeggio / pad
		const scale = [220, 261.63, 293.66, 329.63, 392, 440]
		if (this.station === 0 ? step % 2 === 1 : step % 8 === 4) {
			const o = ctx.createOscillator()
			const gn = ctx.createGain()
			o.type = this.station === 1 ? "sine" : "square"
			o.frequency.setValueAtTime(scale[(step * 3) % scale.length], when)
			gn.gain.setValueAtTime(0.0001, when)
			gn.gain.exponentialRampToValueAtTime(this.station === 1 ? 0.05 : 0.07, when + 0.02)
			gn.gain.exponentialRampToValueAtTime(0.0001, when + spb * (this.station === 1 ? 6 : 1.8))
			o.connect(gn)
			gn.connect(this.musicGain)
			o.start(when)
			o.stop(when + spb * 7)
		}

		// a hat on the off-beats, upbeat station only
		if (this.station === 0 && step % 4 === 2) {
			const src = ctx.createBufferSource()
			src.buffer = this.noiseBuffer
			const gn = ctx.createGain()
			const f = ctx.createBiquadFilter()
			f.type = "highpass"
			f.frequency.setValueAtTime(6000, when)
			gn.gain.setValueAtTime(0.05, when)
			gn.gain.exponentialRampToValueAtTime(0.0001, when + 0.06)
			src.connect(f)
			f.connect(gn)
			gn.connect(this.musicGain)
			src.start(when)
			src.stop(when + 0.08)
		}
	}
}
