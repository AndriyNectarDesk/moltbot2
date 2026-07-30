// DANYLO: NECTAR NOVA — game bootstrap, camera rig, wave director and main loop.

import * as THREE from "three"
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js"
import { RenderPass } from "three/addons/postprocessing/RenderPass.js"
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js"
import { OutputPass } from "three/addons/postprocessing/OutputPass.js"

import { clamp, damp, lerp, rand, TAU } from "../../shared/util.js"
import { Audio } from "./audio.js"
import { Input } from "../../shared/input.js"
import { World } from "./world.js"
import { FX } from "./fx.js"
import { Hero } from "./hero.js"
import { Projectiles, Pickups } from "./projectiles.js"
import { HUD } from "./hud.js"
import { Quality, PRESETS } from "./quality.js"
import { TouchControls } from "./touch.js"
import { Leaderboard } from "../../shared/leaderboard.js"
import { bindIdentity } from "../../shared/identity.js"
import { Brute, Lancer, MoltbotPrime, Skitter, Zipper } from "./enemies.js"

const $ = (id) => document.getElementById(id)

const COMBO_WINDOW = 4
const RANKS = [
	[0, "ROOKIE"],
	[4000, "SIDEKICK"],
	[12000, "DEFENDER"],
	[28000, "GUARDIAN"],
	[55000, "CHAMPION"],
	[95000, "LEGEND"],
	[160000, "NECTAR NOVA"],
]

class Game {
	constructor() {
		this.canvas = $("scene")
		this.state = "menu"
		this.time = 0
		this.timeScale = 1
		this.slowMo = 0
		this.trauma = 0
		this.fov = 68
		this.fovTarget = 68
		this.options = { shake: true, bloom: true, audio: true, invertY: false, sens: 1 }

		this._initRenderer()
		this.audio = new Audio()
		this.input = new Input(this.canvas)
		this.touch = new TouchControls(this.input)
		this.isTouch = TouchControls.isTouchDevice()
		if (this.isTouch) {
			this.touch.attach()
			this.input.touch = this.touch
		}
		// Aiming with a thumb is imprecise, so touch players get auto-fire by
		// default: hold the reticle near a target and Danylo shoots.
		this.autoFire = this.isTouch
		this.aimHostile = false
		this.hud = new HUD()
		this.board = new Leaderboard("nova")

		this.world = new World(this.scene)
		this.fx = new FX(this.scene)
		this.hero = new Hero(this.scene, this.world, this.fx, this.audio)
		this.projectiles = new Projectiles(this.scene, this.world, this.fx)
		this.pickups = new Pickups(this.scene, this.fx, this.audio)
		this.enemies = []
		this.spawnQueue = []

		this.camYaw = 0
		this.camPitch = 0.14
		this.camPos = new THREE.Vector3(0, 6, 26)
		this.camLook = new THREE.Vector3()
		this.aimPoint = new THREE.Vector3(0, 2, 0)
		this.aimDir = new THREE.Vector3(0, 0, -1)
		this.raycaster = new THREE.Raycaster()
		this.raycaster.far = 300
		this._camRay = new THREE.Raycaster()
		this._camDir = new THREE.Vector3()
		this._v = new THREE.Vector3()
		this._v2 = new THREE.Vector3()
		this._shakeOff = new THREE.Vector3()

		this.quality = new Quality(this)
		this.quality.tier = this.quality.detectInitialTier()
		this.quality.onChange = (tier, fromAuto) => this._onQualityChange(tier, fromAuto)
		this.quality.apply()
		// The starting tier is assigned directly, so sync the readout by hand or
		// it keeps whatever the markup said.
		$("perf-tier").textContent = PRESETS[this.quality.tier].label

		this.resetRun()
		this._bindUI()
		addEventListener("resize", () => this._resize())
		this._resize()

		this.refreshTitleBoard()
		$("loading").classList.add("hidden")
		this.clock = new THREE.Clock()
		this._loop = this._loop.bind(this)
		requestAnimationFrame(this._loop)
	}

	// ------------------------------------------------------------ setup
	_initRenderer() {
		const renderer = new THREE.WebGLRenderer({
			canvas: this.canvas,
			antialias: false,
			powerPreference: "high-performance",
		})
		// Pixel ratio and shadows are owned by the Quality tier (see quality.js);
		// these are just safe starting values.
		renderer.setPixelRatio(1)
		renderer.shadowMap.enabled = false
		renderer.shadowMap.type = THREE.PCFShadowMap
		renderer.toneMapping = THREE.ACESFilmicToneMapping
		renderer.toneMappingExposure = 0.86
		this.renderer = renderer

		this.scene = new THREE.Scene()
		this.camera = new THREE.PerspectiveCamera(this.fov, innerWidth / innerHeight, 0.1, 1600)
		this.scene.add(this.camera)

		const size = renderer.getDrawingBufferSize(new THREE.Vector2())
		const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
			type: THREE.HalfFloatType,
			samples: 0,
		})
		this.composer = new EffectComposer(renderer, rt)
		this.composer.addPass(new RenderPass(this.scene, this.camera))
		// Bloom runs at half resolution — it is a blur, so nobody can tell.
		this.bloom = new UnrealBloomPass(
			new THREE.Vector2(innerWidth * 0.5, innerHeight * 0.5),
			0.62,
			0.62,
			0.92,
		)
		this.composer.addPass(this.bloom)
		this.composer.addPass(new OutputPass())
	}

	_resize() {
		// A 0x0 viewport (hidden iframe, container not yet laid out) would make
		// the aspect NaN and poison the projection matrix for good, since this
		// only re-runs on a resize event.
		const w = Math.max(1, innerWidth)
		const h = Math.max(1, innerHeight)
		this.camera.aspect = w / h
		this.camera.updateProjectionMatrix()
		this.renderer.setSize(w, h)
		this.composer.setSize(w, h)
		const bs = this.quality ? this.quality.preset.bloomScale : 0.5
		this.bloom.setSize(Math.max(64, w * bs), Math.max(64, h * bs))
	}

	_bindUI() {
		$("btn-play").onclick = () => this.start()
		$("btn-again").onclick = () => this.start()
		$("btn-resume").onclick = () => this.resume()
		$("btn-quit").onclick = () => this.toMenu()
		// Every screen that can trap you needs a way out; the game-over screen used
		// to offer nothing but "play again".
		$("btn-menu-after").onclick = () => this.toMenu()

		const opt = (id, key, fn) => {
			const el = $(id)
			el.onchange = () => {
				this.options[key] = el.type === "checkbox" ? el.checked : Number(el.value)
				fn?.(this.options[key])
			}
		}
		opt("opt-shake", "shake")
		opt("opt-bloom", "bloom", (v) => {
			this.bloom.enabled = v && this.quality.preset.bloom
		})

		const qsel = $("opt-quality")
		if (qsel) {
			qsel.value = "auto"
			qsel.onchange = () => {
				if (qsel.value === "auto") {
					this.quality.setAuto(true)
				} else {
					this.quality.setAuto(false)
					this.quality.set(qsel.value)
				}
			}
		}
		const fpsToggle = $("opt-fps")
		if (fpsToggle) {
			fpsToggle.onchange = () => $("perf").classList.toggle("hidden", !fpsToggle.checked)
		}
		opt("opt-audio", "audio", (v) => this.audio.setEnabled(v))
		opt("opt-invert", "invertY", (v) => (this.input.invertY = v))
		opt("opt-sens", "sens", (v) => (this.input.sensitivity = v / 100))

		this._bindSubmit()

		const pauseBtn = $("btn-pause")
		if (pauseBtn) pauseBtn.onclick = () => (this.state === "playing" ? this.pause() : this.resume())

		const af = $("opt-autofire")
		if (af) {
			af.checked = this.autoFire
			af.onchange = () => (this.autoFire = af.checked)
		}

		// Portrait on a phone leaves no usable view; nag until they rotate.
		const checkOrientation = () => {
			if (!this.isTouch) return
			const portrait = innerHeight > innerWidth
			$("rotate").classList.toggle("hidden", !portrait)
			if (portrait && this.state === "playing") this.pause()
		}
		addEventListener("resize", checkOrientation)
		addEventListener("orientationchange", () => setTimeout(checkOrientation, 250))
		checkOrientation()

		this.input.onLockChange = (locked) => {
			document.body.classList.toggle("playing", locked)
			if (!locked && this.state === "playing") this.pause()
		}
	}

	/**
	 * Wire the game-over submit row: who you are, then your PIN, then post.
	 *
	 * The order matters for feel. You never touch either of these to PLAY — the
	 * roster is remembered and the PIN is asked once per device, here, after
	 * you've already had your run. A guest needs neither.
	 */
	_bindSubmit() {
		const submitBtn = $("btn-submit")
		const pinInput = $("go-pin")
		const msg = $("go-submit-msg")

		// The strip of names, the signup form and the PIN field are shared across
		// all three games — one identity for the whole arcade.
		this._identity = bindIdentity({
			board: this.board,
			row: document.querySelector(".who-row"),
			pinWrap: $("go-pin-wrap"),
			pinInput,
			onChange: () => {
				msg.textContent = ""
				msg.classList.remove("warn")
				// A guest plays for themselves; there's nothing to prove.
				submitBtn.textContent = this.board.hasIdentity ? "POST SCORE" : "SAVE HERE"
			},
		})
		pinInput.addEventListener("keydown", (e) => {
			e.stopPropagation()
			if (e.key === "Enter") submitBtn.click()
		})

		submitBtn.onclick = async () => {
			if (this._submitted) return

			if (this.board.hasIdentity) {
				const pin = pinInput.value.trim()
				if (!pin) {
					msg.textContent = "ENTER YOUR PIN"
					msg.classList.add("warn")
					pinInput.focus()
					return
				}
				this.board.setPin(pin)
			}

			this._submitted = true
			submitBtn.disabled = true
			submitBtn.textContent = "POSTING…"
			msg.classList.remove("warn")
			msg.textContent = ""

			const res = await this.board.submit({
				score: this.score,
				stats: { wave: this.wave, kills: this.kills, combo: this.bestCombo },
				durationMs: this.runMs,
				// The run is saved locally on the first attempt; a retry must not
				// append a second copy of it.
				skipLocal: this._localSaved,
			})
			this._localSaved = true

			this._renderBoard($("go-board"), res.entries.slice(0, 8), {
				shared: res.shared,
				highlightAt: res.rank,
				title: "TOP RUNS",
			})

			if (res.ok) {
				submitBtn.textContent = res.shared ? "POSTED" : "SAVED"
				if (res.shared && res.improved === false) {
					// The server kept an earlier, better run of yours and wrote
					// nothing. Saying "POSTED" for that would be a small lie.
					msg.textContent = "YOUR BEST THIS WEEK IS STILL HIGHER"
				} else if (res.rank === 1) {
					msg.textContent = res.shared ? "TOP OF THE WEEK" : "NEW PERSONAL BEST"
				} else if (res.rank) {
					msg.textContent = `RANK #${res.rank}`
				}
				if (res.shared && res.points) {
					msg.textContent += ` · ${res.points} PRIZE ${res.points === 1 ? "POINT" : "POINTS"}`
				}
			} else {
				// Say what actually went wrong. A rejected PIN used to be reported
				// as an unreachable board, which sent you hunting the wrong fault.
				msg.classList.add("warn")
				if (res.status === 403 && /pin/i.test(res.error || "")) {
					msg.textContent = "WRONG PIN — SAVED ON THIS DEVICE"
					this.board.forgetPin()
					pinInput.value = ""
				} else if (res.status === 403) {
					// The roster isn't set up server-side; blaming the PIN here
					// would send a kid round in circles retyping a correct one.
					msg.textContent = "BOARD NOT SET UP YET — SAVED ON THIS DEVICE"
				} else if (res.status === 429) {
					msg.textContent = "TOO SOON — SAVED ON THIS DEVICE"
				} else if (res.status === 409) {
					msg.textContent = "THIS WEEK IS CLOSED — SAVED ON THIS DEVICE"
				} else {
					msg.textContent = "SAVED ON THIS DEVICE — BOARD UNREACHABLE"
				}
				// Always allow another go. A 20s cooldown or a wifi blip must not
				// permanently strand a run that might be the week's best — the
				// next accepted submission has to beat your own score, so a lost
				// great run can never be posted again.
				this._submitted = false
				submitBtn.disabled = false
				submitBtn.textContent = "TRY AGAIN"
			}
			this.refreshTitleBoard()
		}
	}

	/** Paint a score table into a container. */
	_renderBoard(el, entries, { shared, highlightAt = null, title }) {
		if (!el) return
		const head = `<div class="board-title">${title}${shared ? "" : " · THIS DEVICE"}</div>`
		if (!entries.length) {
			el.innerHTML = `${head}<div class="board-empty">NO RUNS YET — BE THE FIRST</div>`
			return
		}
		const rows = entries
			.map((e, i) => {
				const you = highlightAt === i + 1 ? " you" : ""
				const name = String(e.player || e.name || "ANON").replace(/[<>&]/g, "")
				const wave = (e.stats && e.stats.wave) || e.wave
				return (
					`<div class="board-row top-${i + 1}${you}">` +
					`<span class="rk">${i + 1}</span>` +
					`<span class="nm">${name.toUpperCase()}</span>` +
					`<span class="wv">${wave ? `W${wave}` : ""}</span>` +
					`<span class="sc">${Number(e.score).toLocaleString()}</span>` +
					`</div>`
				)
			})
			.join("")
		el.innerHTML = head + rows
	}

	/** Refresh the compact table on the title screen. */
	async refreshTitleBoard() {
		const { entries, shared } = await this.board.top(5)
		this._renderBoard($("title-board"), entries, { shared, title: "HALL OF FAME" })
	}

	_onQualityChange(tier, fromAuto) {
		const label = PRESETS[tier].label
		$("perf-tier").textContent = label
		const sel = $("opt-quality")
		if (sel && !this.quality.auto) sel.value = tier
		if (fromAuto && this.state === "playing") {
			// Say it once so a sudden visual downgrade isn't mysterious.
			this.hud.banner("", `GRAPHICS → ${label}`)
		}
	}

	// ------------------------------------------------------------ flow
	resetRun() {
		for (const e of this.enemies) e.remove()
		this.enemies = []
		this.spawnQueue = []
		this.projectiles.clear()
		this.pickups.clear()
		this.fx.clear()
		this.hero.reset()
		this.hud.reset()

		this.wave = 0
		this.score = 0
		this.kills = 0
		this.combo = 1
		this.bestCombo = 1
		this.comboT = 0
		this.waveState = "idle"
		this.waveT = 1.5
		this.boss = null
		this.camYaw = 0
		this.camPitch = 0.14
		this.timeScale = 1
		this.slowMo = 0
		this.trauma = 0
		this.deadT = 0
	}

	start() {
		if (this.isTouch) {
			document.documentElement.requestFullscreen?.().catch(() => {})
			screen.orientation?.lock?.("landscape").catch(() => {})
		}
		this.audio.init()
		this.audio.resume()
		this.audio.setEnabled(this.options.audio)
		this.resetRun()
		this.runStartedAt = Date.now()
		this.state = "playing"
		$("title").classList.add("hidden")
		$("gameover").classList.add("hidden")
		$("pause").classList.add("hidden")
		this.hud.show(true)
		this.touch.setVisible(this.isTouch)
		this.input.requestLock()
		this.audio.startMusic()
		this.hud.banner("SUIT UP", "CAPTAIN DANYLO — GO")
	}

	pause() {
		if (this.state !== "playing") return
		this.touch.releaseAll()
		this.state = "paused"
		$("pause").classList.remove("hidden")
		this.touch.setVisible(false)
		this.input.exitLock()
	}

	resume() {
		if (this.state !== "paused") return
		$("pause").classList.add("hidden")
		this.state = "playing"
		this.touch.setVisible(this.isTouch)
		this.input.requestLock()
		this.audio.resume()
	}

	toMenu() {
		this.state = "menu"
		$("pause").classList.add("hidden")
		$("gameover").classList.add("hidden")
		$("title").classList.remove("hidden")
		this.refreshTitleBoard()
		this.hud.show(false)
		this.touch.setVisible(false)
		this.input.exitLock()
		this.audio.stopMusic()
		this.resetRun()
	}

	gameOver() {
		this.state = "over"
		this.touch.setVisible(false)
		this.audio.stopMusic()
		this.audio.gameOver()
		this.input.exitLock()
		$("go-score").textContent = this.score.toLocaleString()
		$("go-wave").textContent = this.wave
		$("go-kills").textContent = this.kills
		$("go-combo").textContent = `x${this.bestCombo}`
		let rank = RANKS[0][1]
		for (const [min, name] of RANKS) if (this.score >= min) rank = name
		$("go-rank").textContent = rank
		$("go-title").textContent = this.wave >= 10 ? "HERO DOWN" : "DOWN BUT NOT OUT"
		$("gameover").classList.remove("hidden")

		// How long the run actually took. Only used as a flag signal on the
		// board — a huge score in a few seconds contradicts itself.
		this.runMs = this.runStartedAt ? Date.now() - this.runStartedAt : undefined

		// Reset the submit form for this run; the roster pick and PIN persist.
		$("go-pin").value = this.board.pin
		$("go-submit-msg").textContent = ""
		$("go-submit-msg").classList.remove("warn")
		$("btn-submit").disabled = false
		// Repaints the name strip and sets the submit button to match who is
		// playing — a friend may have signed up since the last run.
		this._identity.refresh()
		this._submitted = false
		this._localSaved = false
		this.board.top(8).then(({ entries, shared }) =>
			this._renderBoard($("go-board"), entries, { shared, title: "TOP RUNS" }),
		)
	}

	// ------------------------------------------------------------ waves
	_startWave() {
		this.wave++
		this.hud.setWave(this.wave)
		const isBoss = this.wave % 5 === 0
		this.waveState = "spawning"

		if (isBoss) {
			this.hud.banner("WARNING", `MOLTBOT PRIME — MARK ${this.wave / 5}`)
			this.audio.bossSpawn()
			this.audio.setIntensity(1)
			this.spawnQueue.push({ t: 1.8, cls: MoltbotPrime, pos: new THREE.Vector3(0, 0, -18), tier: this.wave })
			this.fx.nova(new THREE.Vector3(0, 8, -18))
			this.shake(0.9)
			return
		}

		this.audio.setIntensity(clamp(this.wave / 22, 0, 0.8))
		this.hud.banner(`WAVE ${this.wave}`, this._waveTag())
		this.audio.waveStart()

		// budget-based composition, ramping in variety as waves go up
		let budget = 3.2 + this.wave * 1.75
		const roster = [{ cls: Zipper, cost: 0.6, from: 1 }, { cls: Skitter, cost: 1, from: 1 }]
		if (this.wave >= 3) roster.push({ cls: Lancer, cost: 1.7, from: 3 })
		if (this.wave >= 4) roster.push({ cls: Brute, cost: 2.4, from: 4 })

		let delay = 0.35
		let guard = 0
		while (budget > 0.5 && guard++ < 60) {
			const pool = roster.filter((r) => r.cost <= budget + 0.2)
			const pickRoster = pool[Math.floor(Math.random() * pool.length)]
			if (!pickRoster) break
			budget -= pickRoster.cost
			this.spawnQueue.push({
				t: delay,
				cls: pickRoster.cls,
				pos: this.world.randomSpawn(18, 40),
				tier: this.wave,
			})
			delay += rand(0.14, 0.42)
		}
	}

	_waveTag() {
		const tags = [
			"THEY KEEP COMING",
			"HOLD THE PAD",
			"SHOW THEM THE CAPE",
			"NECTAR CORE STABLE",
			"MORE SIGNALS INBOUND",
			"THE CITY IS WATCHING",
			"NO FEAR",
		]
		return tags[(this.wave - 1) % tags.length]
	}

	spawnEnemy(cls, pos, tier = this.wave) {
		const e = new cls(this, pos, tier)
		this.enemies.push(e)
		if (e.isBoss) {
			this.boss = e
			this.hud.showBoss(`${e.name} — MK ${Math.max(1, Math.floor(this.wave / 5))}`)
			this.hud.setBoss(1)
		}
		return e
	}

	_updateWaves(dt) {
		// timed spawns with a portal flash
		for (let i = this.spawnQueue.length - 1; i >= 0; i--) {
			const s = this.spawnQueue[i]
			s.t -= dt
			if (!s.warned && s.t < 0.55) {
				s.warned = true
				this.fx.ringBurst(s.pos, 0x8a3cff, 1.6)
				this.fx._flash(s.pos, 0xff2d95, 0.2, 2.2, 0.5)
			}
			if (s.t <= 0) {
				this.spawnEnemy(s.cls, s.pos, s.tier)
				this.fx.explosion(s.pos, 0x8a3cff, 0.6)
				this.spawnQueue.splice(i, 1)
			}
		}

		if (this.waveState === "idle") {
			this.waveT -= dt
			if (this.waveT <= 0) this._startWave()
		} else if (this.waveState === "spawning") {
			if (this.spawnQueue.length === 0 && this.enemies.length === 0) {
				// wave cleared
				this.waveState = "idle"
				this.waveT = 3.6
				const bonus = 500 * this.wave
				this.addScore(bonus, null)
				this.hud.banner("WAVE CLEAR", `+${bonus.toLocaleString()} BONUS`)
				this.audio.setIntensity(clamp(this.wave / 22, 0, 0.8))
				this.hero.addUlt(25)
				this.hud.hideBoss()
				this.boss = null
				// reward drops around the hero
				for (let i = 0; i < 2; i++) {
					this.pickups.spawn(this._v.copy(this.hero.pos).add(new THREE.Vector3(rand(-4, 4), 1, rand(-4, 4))), "hp")
					this.pickups.spawn(this._v.copy(this.hero.pos).add(new THREE.Vector3(rand(-4, 4), 1, rand(-4, 4))), "en")
				}
			}
		}
	}

	// ------------------------------------------------------------ combat hooks
	addScore(points, atPos) {
		const total = Math.round(points * this.combo)
		this.score += total
		this.hud.setScore(this.score)
		if (atPos) this.hud.floater(atPos, `+${total}`, this.combo > 2 ? "crit" : "")
		return total
	}

	fireBolt(origin, aimPoint, side) {
		const dir = this._v.copy(aimPoint).sub(origin).normalize()
		this.projectiles.firePlayer(origin, dir, { damage: 15 })
	}

	fireBeam(charge) {
		const origin = this.hero.handWorld(new THREE.Vector3(), 1)
		origin.y += 0.1
		const dir = this._v.copy(this.aimPoint).sub(origin).normalize()
		const radius = 0.7 + charge * 1.5
		const damage = 45 + charge * 165
		const range = 110
		const end = this._v2.copy(origin).addScaledVector(dir, range)

		let hitAny = false
		for (const e of this.enemies) {
			if (!e.alive || e.dying) continue
			const toE = new THREE.Vector3().copy(e.center).sub(origin)
			const along = toE.dot(dir)
			if (along < 0 || along > range) continue
			const perp = Math.sqrt(Math.max(0, toE.lengthSq() - along * along))
			if (perp > radius + e.radius) continue
			const point = new THREE.Vector3().copy(origin).addScaledVector(dir, along)
			this.onHitEnemy(e, damage, point, dir)
			hitAny = true
		}
		this.fx.beam(origin, end, radius, 0x8fe8ff, 0.5)
		this.fx.beam(origin, end, radius * 0.45, 0xffffff, 0.42)
		this.fx.muzzle(origin, dir, 0x8fe8ff)
		this.fx._flash(origin, 0xffffff, 0.4, 3 + charge * 3, 0.28)
		this.hud.setHostile(hitAny)
	}

	fireNova() {
		const p = this.hero.pos.clone().setY(this.hero.pos.y + 1)
		this.fx.nova(p)
		this.audio.nova()
		this.hud.ultFlash()
		this.hud.banner("NECTAR NOVA", "")
		this.shake(1.2)
		this.fovKick(22)
		this.slowMo = 1.0
		this.projectiles.clearEnemyBolts()
		this.hero.iframes = Math.max(this.hero.iframes, 1.4)

		// expanding damage ring — everything inside gets hammered
		const R = 30
		for (const e of [...this.enemies]) {
			if (!e.alive || e.dying) continue
			const d = e.center.distanceTo(p)
			if (d > R) continue
			const falloff = 1 - clamp(d / R, 0, 1) * 0.55
			this.onHitEnemy(e, 320 * falloff, e.center.clone(), this._v.copy(e.center).sub(p).normalize())
		}
	}

	onHitEnemy(enemy, damage, point, dir) {
		const res = enemy.hit(damage, point)
		if (res.dmg <= 0) return
		this.fx.impact(point, dir ? this._v2.copy(dir).negate() : this._v2.set(0, 1, 0), res.crit ? 0xffd08a : 0x62e8ff, res.crit ? 1.3 : 0.9)
		this.audio.hit()
		this.hud.hitmarker(res.killed)
		this.hud.floater(point, String(Math.round(res.dmg)), res.crit ? "crit" : "")
		this.hero.addUlt(res.dmg / 14)
		if (this.boss === enemy) this.hud.setBoss(enemy.hp / enemy.maxHp)
	}

	onEnemyKilled(enemy) {
		this.kills++
		this.comboT = COMBO_WINDOW
		this.combo = Math.min(8, this.combo + 1)
		this.bestCombo = Math.max(this.bestCombo, this.combo)
		const pts = this.addScore(enemy.score, enemy.center.clone())
		this.hud.kill(enemy.name, pts)
		this.hero.addUlt(enemy.isBoss ? 100 : 7)
		this.fx.explosion(enemy.center, enemy.isBoss ? 0xffd08a : 0xff5ab0, enemy.isBoss ? 2.4 : 1)
		this.audio.explode(enemy.isBoss ? 1.6 : 0.85)
		this.shake(enemy.isBoss ? 1 : 0.22)

		if (enemy.isBoss) {
			this.slowMo = 1
			this.hud.banner("PRIME DESTROYED", "THE SKY-CITY IS SAFE… FOR NOW")
			this.hud.hideBoss()
			this.boss = null
			for (let i = 0; i < 6; i++) {
				this.pickups.spawn(enemy.center.clone().add(new THREE.Vector3(rand(-3, 3), 0, rand(-3, 3))), i % 2 ? "hp" : "en")
			}
		} else if (Math.random() < 0.24) {
			this.pickups.spawn(enemy.center.clone(), Math.random() < 0.55 ? "hp" : "en")
		}
	}

	onHeroHit() {
		this.hud.hurt()
		this.shake(0.45)
		this.combo = 1
		this.comboT = 0
	}

	/** True while the primary weapon should be firing, by button or auto-fire. */
	get firing() {
		if (this.hero.charging) return false
		return this.input.mouse.left || (this.autoFire && this.aimHostile)
	}

	shake(amount) {
		if (!this.options.shake) return
		this.trauma = clamp(this.trauma + amount, 0, 1.4)
	}

	fovKick(deg) {
		this.fovTarget = 68 + deg
	}

	// ------------------------------------------------------------ camera
	_updateCamera(dt, realDt) {
		const m = this.input.mouse
		if (this.state === "playing" && this.input.locked) {
			this.camYaw -= m.dx
			this.camPitch = clamp(this.camPitch + m.dy, -0.95, 1.15)
		}

		const h = this.hero
		const pivot = this._v.set(h.pos.x, h.pos.y + 1.6, h.pos.z)
		const dist =
			(this.state === "menu" ? 9 : 6.6) +
			h.charge * 1.2 +
			clamp(Math.hypot(h.vel.x, h.vel.z) / 22, 0, 1.4)
		const cp = Math.cos(this.camPitch)
		const shoulder = 1.25
		const offset = new THREE.Vector3(
			Math.sin(this.camYaw) * cp * dist + Math.cos(this.camYaw) * shoulder,
			Math.sin(this.camPitch) * dist + 1.15,
			Math.cos(this.camYaw) * cp * dist - Math.sin(this.camYaw) * shoulder,
		)
		const want = pivot.clone().add(offset)

		const k = this.state === "playing" ? 0.0008 : 0.002
		this.camPos.x = damp(this.camPos.x, want.x, k, realDt)
		this.camPos.y = damp(this.camPos.y, want.y, k, realDt)
		this.camPos.z = damp(this.camPos.z, want.z, k, realDt)

		// Boom collision: pull the camera in if a platform sits between it and
		// the hero, and never let it sink through the surface he's standing on.
		this._camDir.copy(this.camPos).sub(pivot)
		const boom = this._camDir.length()
		if (boom > 0.001) {
			this._camDir.divideScalar(boom)
			this._camRay.set(pivot, this._camDir)
			this._camRay.far = boom
			const hits = this._camRay.intersectObjects(this.world.hitMeshes, false)
			if (hits.length) {
				this.camPos.copy(pivot).addScaledVector(this._camDir, Math.max(2, hits[0].distance - 0.5))
			}
		}
		const floor = this.world.groundAt(this.camPos.x, this.camPos.z, pivot.y + 0.4)
		if (floor > -100 && this.camPos.y < floor + 0.9) {
			this.camPos.y = floor + 0.9
		}

		// screen shake
		this.trauma = Math.max(0, this.trauma - realDt * 1.35)
		const s = this.trauma * this.trauma
		this._shakeOff.set(
			(Math.random() * 2 - 1) * s * 0.8,
			(Math.random() * 2 - 1) * s * 0.8,
			(Math.random() * 2 - 1) * s * 0.5,
		)

		this.camera.position.copy(this.camPos).add(this._shakeOff)
		// Look just past the hero's head so he frames slightly below centre-left.
		const ahead = 3.0
		const lookAt = this._v2.set(
			pivot.x - Math.sin(this.camYaw) * cp * ahead,
			pivot.y - Math.sin(this.camPitch) * ahead + 0.55,
			pivot.z - Math.cos(this.camYaw) * cp * ahead,
		)
		this.camera.lookAt(lookAt)
		this.camera.rotateZ((Math.random() * 2 - 1) * s * 0.05)

		// fov breathing / kick
		this.fovTarget = damp(this.fovTarget, 68 + (h.dashTime > 0 ? 8 : 0) + this.hero.charge * 4, 0.002, realDt)
		this.fov = damp(this.fov, this.fovTarget, 0.0009, realDt)
		if (Math.abs(this.camera.fov - this.fov) > 0.01) {
			this.camera.fov = this.fov
			this.camera.updateProjectionMatrix()
		}
	}

	_updateAim() {
		this.camera.updateMatrixWorld()
		this.raycaster.setFromCamera({ x: 0, y: 0 }, this.camera)
		const ray = this.raycaster.ray
		this.aimDir.copy(ray.direction)

		let bestDist = 240
		let hitEnemy = false

		// enemies first — cheap sphere test with a touch of aim assist
		for (const e of this.enemies) {
			if (!e.alive || e.dying) continue
			const toE = this._v.copy(e.center).sub(ray.origin)
			const along = toE.dot(ray.direction)
			if (along < 1 || along > 240) continue
			const perp = Math.sqrt(Math.max(0, toE.lengthSq() - along * along))
			const assist = e.radius * 1.35 + along * 0.012
			if (perp < assist && along < bestDist) {
				bestDist = along
				hitEnemy = true
				this.aimPoint.copy(e.center)
			}
		}

		if (!hitEnemy) {
			const hits = this.raycaster.intersectObjects(this.world.hitMeshes, false)
			if (hits.length && hits[0].distance < bestDist) {
				this.aimPoint.copy(hits[0].point)
			} else {
				this.aimPoint.copy(ray.origin).addScaledVector(ray.direction, 120)
			}
		}
		this.aimHostile = hitEnemy
		this.hud.setHostile(hitEnemy)
	}

	// ------------------------------------------------------------ loop
	_loop() {
		requestAnimationFrame(this._loop)
		const realDt = Math.min(this.clock.getDelta(), 0.05)

		// slow-mo easing
		if (this.slowMo > 0) {
			this.slowMo = Math.max(0, this.slowMo - realDt * 0.85)
			this.timeScale = lerp(1, 0.32, clamp(this.slowMo, 0, 1))
		} else {
			this.timeScale = damp(this.timeScale, 1, 0.001, realDt)
		}

		const playing = this.state === "playing" || this.state === "over"
		const dt = playing ? realDt * this.timeScale : 0
		this.time += dt

		if (this.state === "playing" && this.input.once("Escape")) this.pause()
		if (this.input.once("KeyM")) {
			this.options.audio = !this.options.audio
			$("opt-audio").checked = this.options.audio
			this.audio.setEnabled(this.options.audio)
		}

		if (this.state === "menu") this._menuCamera(realDt)

		if (playing) {
			this._updateAim()
			this.hero.update(dt, this.input, this)

			for (let i = this.enemies.length - 1; i >= 0; i--) {
				const e = this.enemies[i]
				e.update(dt)
				if (!e.alive) this.enemies.splice(i, 1)
			}

			this.projectiles.update(dt, this)
			this.pickups.update(dt, this.hero, this.world, (kind) => {
				if (kind === "hp") {
					this.hero.heal(28)
					this.hud.floater(this.hero.pos.clone().setY(this.hero.pos.y + 2), "+28", "heal")
				} else {
					this.hero.addEnergy(45)
					this.hero.addUlt(12)
					this.hud.floater(this.hero.pos.clone().setY(this.hero.pos.y + 2), "ENERGY", "heal")
				}
			})

			if (this.state === "playing") this._updateWaves(dt)

			// combo decay
			if (this.comboT > 0) {
				this.comboT -= dt
				if (this.comboT <= 0) this.combo = 1
			}
			this.hud.setCombo(this.combo, this.comboT / COMBO_WINDOW)

			if (this.boss) this.hud.setBoss(this.boss.hp / this.boss.maxHp)

			if (this.hero.dead && this.state === "playing") {
				this.state = "dying"
				this.slowMo = 1.2
				this.fx.explosion(this.hero.pos, 0xffa23c, 1.4)
				this.shake(1)
				this.audio.setIntensity(0)
				setTimeout(() => this.gameOver(), 2200)
			}
		}

		if (this.state === "dying") {
			// keep the world alive while the death cam plays out
			const d = realDt * this.timeScale
			this.hero.update(d, this.input, this)
			for (const e of this.enemies) e.update(d)
			this.projectiles.update(d, this)
			this.time += d
		}

		this.world.update(playing || this.state === "dying" ? dt : realDt * 0.4, this.time)
		this.fx.update(this.state === "menu" || this.state === "paused" ? realDt * 0.4 : realDt * this.timeScale)
		this._updateCamera(dt, realDt)

		// HUD
		this.hud.setHealth(this.hero.hp, this.hero.maxHp)
		this.hud.setEnergy(this.hero.energy, this.hero.maxEnergy)
		this.hud.setAbilities(this.hero)
		this.hud.setCharge(this.hero.charging ? this.hero.charge : 0)
		this.hud.update(realDt, this.camera)

		this.composer.render()
		this.quality.sample()
		if (this._perfT === undefined || this.time - this._perfT > 0.25) {
			this._perfT = this.time
			$("perf-fps").textContent = this.quality.fps
		}
		this.input.endFrame()
	}

	/** Slow orbit around the hero on the title screen. */
	_menuCamera(dt) {
		this.camYaw += dt * 0.16
		this.camPitch = 0.12 + Math.sin(this.time * 0.4) * 0.05
		this.time += dt
		this.hero.root.position.copy(this.hero.pos)
		this.hero._pose(dt, this.time, { x: 0, y: 0 }, false, this)
		this.hero.aura.material.opacity = 0.12 + Math.sin(this.time * 2) * 0.05
	}
}

window.addEventListener("DOMContentLoaded", () => {
	try {
		const game = new Game()
		// Handy for tinkering from the devtools console:
		//   game.hero.hp = 999; game.spawnEnemy(__E.MoltbotPrime, new __THREE.Vector3())
		window.game = game
		game.THREE = THREE
		window.__THREE = THREE
		window.__E = { Skitter, Brute, Lancer, Zipper, MoltbotPrime }
	} catch (err) {
		console.error(err)
		const l = $("loading")
		l.classList.remove("hidden")
		l.innerHTML = `<div class="t-inner"><h2>WEBGL ERROR</h2><p>${String(err.message || err)}</p></div>`
	}
})
