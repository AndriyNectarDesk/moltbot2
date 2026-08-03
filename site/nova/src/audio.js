// NECTAR NOVA's sound bank and music. The synthesis engine — WebAudio setup and
// the _tone/_noise/_env primitives — lives in ../../shared/audioengine.js,
// promoted there once all three games had proved it byte-identical. What stays
// here is what makes the shooter sound like a shooter: sharp transients, big
// explosions, and a driving minor arpeggio whose intensity ramps up during
// boss fights.

import { rand } from "../../shared/util.js"
import { AudioEngine } from "../../shared/audioengine.js"

export class Audio extends AudioEngine {
	// ---------------------------------------------------------------- SFX
	shoot() {
		if (!this._ready()) return
		this._tone({ type: "square", freq: rand(760, 900), to: 190, dur: 0.1, gain: 0.13 })
		this._tone({ type: "sawtooth", freq: rand(1500, 1750), to: 420, dur: 0.07, gain: 0.06 })
		this._noise({ dur: 0.06, gain: 0.05, type: "highpass", freq: 2200 })
	}

	beamCharge() {
		if (!this._ready()) return null
		const t0 = this.t
		const osc = this.ctx.createOscillator()
		const g = this.ctx.createGain()
		osc.type = "sawtooth"
		osc.frequency.setValueAtTime(90, t0)
		osc.frequency.exponentialRampToValueAtTime(720, t0 + 1.1)
		g.gain.setValueAtTime(0.0001, t0)
		g.gain.exponentialRampToValueAtTime(0.14, t0 + 1.0)
		const filt = this.ctx.createBiquadFilter()
		filt.type = "bandpass"
		filt.Q.value = 6
		filt.frequency.setValueAtTime(300, t0)
		filt.frequency.exponentialRampToValueAtTime(2400, t0 + 1.1)
		osc.connect(filt)
		filt.connect(g)
		g.connect(this.sfxGain)
		osc.start(t0)
		return {
			stop: () => {
				const t = this.t
				g.gain.cancelScheduledValues(t)
				g.gain.setValueAtTime(Math.max(g.gain.value, 0.0002), t)
				g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08)
				osc.stop(t + 0.12)
			},
		}
	}

	beamFire(power = 1) {
		if (!this._ready()) return
		this._tone({ type: "sawtooth", freq: 240 * power, to: 60, dur: 0.5, gain: 0.22 })
		this._tone({ type: "square", freq: 1200, to: 300, dur: 0.35, gain: 0.1 })
		this._noise({ dur: 0.45, gain: 0.2, type: "bandpass", freq: 2600, to: 300, q: 2 })
	}

	hit() {
		if (!this._ready()) return
		this._tone({ type: "square", freq: rand(1500, 2000), to: 900, dur: 0.045, gain: 0.09 })
	}

	explode(size = 1) {
		if (!this._ready()) return
		this._noise({ dur: 0.55 * size, gain: 0.34, type: "lowpass", freq: 1600, to: 60 })
		this._tone({ type: "sine", freq: 150 * (1 / size), to: 28, dur: 0.6 * size, gain: 0.3 })
		this._tone({ type: "sawtooth", freq: 320, to: 40, dur: 0.25, gain: 0.09 })
	}

	dash() {
		if (!this._ready()) return
		this._noise({ dur: 0.34, gain: 0.2, type: "bandpass", freq: 300, to: 3400, q: 1.4 })
		this._tone({ type: "sine", freq: 180, to: 700, dur: 0.28, gain: 0.09 })
	}

	jump() {
		if (!this._ready()) return
		this._tone({ type: "sine", freq: 320, to: 700, dur: 0.16, gain: 0.1 })
	}

	thruster() {
		if (!this._ready()) return
		this._noise({ dur: 0.16, gain: 0.045, type: "bandpass", freq: rand(500, 900), q: 1.2 })
	}

	hurt() {
		if (!this._ready()) return
		this._tone({ type: "sawtooth", freq: 260, to: 70, dur: 0.32, gain: 0.2 })
		this._noise({ dur: 0.22, gain: 0.16, type: "lowpass", freq: 900, to: 120 })
	}

	pickup(kind = "hp") {
		if (!this._ready()) return
		const base = kind === "hp" ? 520 : 660
		this._tone({ type: "triangle", freq: base, dur: 0.1, gain: 0.14 })
		setTimeout(() => this._ready() && this._tone({ type: "triangle", freq: base * 1.5, dur: 0.16, gain: 0.13 }), 80)
	}

	nova() {
		if (!this._ready()) return
		this._tone({ type: "sawtooth", freq: 60, to: 1400, dur: 0.55, gain: 0.2 })
		setTimeout(() => {
			if (!this._ready()) return
			this._noise({ dur: 1.2, gain: 0.4, type: "lowpass", freq: 3000, to: 40 })
			this._tone({ type: "sine", freq: 90, to: 20, dur: 1.3, gain: 0.34 })
		}, 480)
	}

	waveStart() {
		if (!this._ready()) return
		const notes = [392, 523, 659, 784]
		notes.forEach((f, i) =>
			setTimeout(() => this._ready() && this._tone({ type: "square", freq: f, dur: 0.2, gain: 0.11 }), i * 95),
		)
	}

	bossSpawn() {
		if (!this._ready()) return
		this._tone({ type: "sawtooth", freq: 110, to: 55, dur: 1.6, gain: 0.24 })
		this._tone({ type: "sawtooth", freq: 112, to: 56, dur: 1.6, gain: 0.2, detune: 22 })
		this._noise({ dur: 1.8, gain: 0.18, type: "lowpass", freq: 400, to: 60 })
	}

	gameOver() {
		if (!this._ready()) return
		const notes = [440, 370, 294, 196]
		notes.forEach((f, i) =>
			setTimeout(() => this._ready() && this._tone({ type: "triangle", freq: f, dur: 0.55, gain: 0.16 }), i * 210),
		)
	}

	// ---------------------------------------------------------------- music
	startMusic() {
		if (!this._ready() || this._musicTimer) return
		this.musicGain.gain.cancelScheduledValues(this.t)
		this.musicGain.gain.setValueAtTime(0.0001, this.t)
		this.musicGain.gain.exponentialRampToValueAtTime(0.34, this.t + 2.5)
		this._nextNote = this.t + 0.1
		this._step = 0
		this._musicTimer = setInterval(() => this._schedule(), 40)
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
			this.musicGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.7)
		}
	}

	/** Look-ahead scheduler: a driving 16th-note bass + heroic arpeggio. */
	_schedule() {
		if (!this._ready()) return
		const bpm = 132 + this.intensity * 24
		const spb = 60 / bpm / 4
		while (this._nextNote < this.t + 0.2) {
			this._playStep(this._step, this._nextNote, spb)
			this._step = (this._step + 1) % 32
			this._nextNote += spb
		}
	}

	_playStep(step, when, spb) {
		const ctx = this.ctx
		// A minor-ish heroic progression: Am - F - C - G
		const roots = [110, 87.31, 130.81, 98]
		const bar = Math.floor(step / 8) % 4
		const root = roots[bar]

		// bass
		if (step % 2 === 0) {
			const o = ctx.createOscillator()
			const g = ctx.createGain()
			o.type = "sawtooth"
			o.frequency.setValueAtTime(root / 2, when)
			const f = ctx.createBiquadFilter()
			f.type = "lowpass"
			f.frequency.setValueAtTime(240 + this.intensity * 700, when)
			g.gain.setValueAtTime(0.0001, when)
			g.gain.exponentialRampToValueAtTime(0.3, when + 0.01)
			g.gain.exponentialRampToValueAtTime(0.0001, when + spb * 1.7)
			o.connect(f)
			f.connect(g)
			g.connect(this.musicGain)
			o.start(when)
			o.stop(when + spb * 2)
		}

		// arpeggio
		const arp = [0, 7, 12, 16, 12, 7, 19, 12]
		const semi = arp[step % 8]
		const freq = root * 2 * Math.pow(2, semi / 12)
		const o2 = ctx.createOscillator()
		const g2 = ctx.createGain()
		o2.type = "square"
		o2.frequency.setValueAtTime(freq, when)
		g2.gain.setValueAtTime(0.0001, when)
		g2.gain.exponentialRampToValueAtTime(0.05 + this.intensity * 0.05, when + 0.008)
		g2.gain.exponentialRampToValueAtTime(0.0001, when + spb * 0.9)
		const d = ctx.createDelay()
		d.delayTime.value = spb * 3
		const dg = ctx.createGain()
		dg.gain.value = 0.25
		o2.connect(g2)
		g2.connect(this.musicGain)
		g2.connect(d)
		d.connect(dg)
		dg.connect(this.musicGain)
		o2.start(when)
		o2.stop(when + spb)

		// hats
		if (step % 4 === 2) {
			const src = ctx.createBufferSource()
			src.buffer = this.noiseBuffer
			const f = ctx.createBiquadFilter()
			f.type = "highpass"
			f.frequency.value = 7000
			const g = ctx.createGain()
			g.gain.setValueAtTime(0.06, when)
			g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05)
			src.connect(f)
			f.connect(g)
			g.connect(this.musicGain)
			src.start(when)
			src.stop(when + 0.06)
		}

		// kick
		if (step % 8 === 0 || step % 8 === 5) {
			const o = ctx.createOscillator()
			const g = ctx.createGain()
			o.type = "sine"
			o.frequency.setValueAtTime(150, when)
			o.frequency.exponentialRampToValueAtTime(42, when + 0.11)
			g.gain.setValueAtTime(0.4, when)
			g.gain.exponentialRampToValueAtTime(0.0001, when + 0.24)
			o.connect(g)
			g.connect(this.musicGain)
			o.start(when)
			o.stop(when + 0.3)
		}
	}
}
