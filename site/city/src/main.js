// SOFIA: CITY LIGHTS — bootstrap, the car in the world, and the two modes.
//
// Free roam is the game: no clock, no damage, no fail state, no score. Drive
// around a neon city at dusk, find stars, unlock cars, listen to the radio. It is
// deliberately not on the leaderboard, because putting a weekly competition on
// the part someone asked for as "just driving around" would ruin exactly the
// thing that makes it good.
//
// SHIFT is the contest: five minutes of chained deliveries, and the only mode
// that scores. You opt into it from the pause menu or with Enter.
//
// Keyboard-driven, and it reuses ../../shared/input.js as-is — that module's
// pointer-lock machinery is all on the mouse path, so the keyboard half works
// untouched. This is the first genuine reuse of it outside the shooter.

import * as THREE from "three"
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js"
import { RenderPass } from "three/addons/postprocessing/RenderPass.js"
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js"
import { OutputPass } from "three/addons/postprocessing/OutputPass.js"

import { clamp, damp, lerp } from "../../shared/util.js"
import { GUEST, Leaderboard } from "../../shared/leaderboard.js"
import { Input } from "../../shared/input.js"
import { Audio } from "./audio.js"
import { BLOCK, CITY_HALF, City } from "./city.js"
import { CARS, CAR_IDS, Car } from "./car.js"
import { buildCarMesh } from "./carmesh.js"
import { resolveCircle } from "./collide.js"
import { SHIFT_SECONDS, Shift } from "./shift.js"
import { HUD } from "./hud.js"
import { FX } from "./fx.js"
import { Quality } from "./quality.js"

const $ = (id) => document.getElementById(id)

const CAR_RADIUS = 2.3
const GRAVITY = 27
/** Impact speed above which a bump counts as a crash. */
const CRASH_AT = 9

const STARS_KEY = "city.stars"
const CARS_KEY = "city.cars"

const RANKS = [
	[0, "LEARNER"],
	[3000, "COURIER"],
	[9000, "REGULAR"],
	[18000, "NIGHT SHIFT"],
	[30000, "ACE"],
	[45000, "CITY LIGHTS"],
]

class Game {
	constructor() {
		this.state = "menu" // menu | roam | shift | paused | over
		this.time = 0
		this.options = { audio: true, bloom: true }

		this.canvas = $("scene")
		this._initRenderer()

		this.audio = new Audio()
		this.input = new Input(this.canvas)
		this.hud = new HUD()
		this.board = new Leaderboard("city")

		this.city = new City(this.scene)
		this.fx = new FX(this.scene)

		this.car = new Car("scout", 0, 0, 0)
		this.carMesh = buildCarMesh("scout")
		this.scene.add(this.carMesh)

		this.shift = new Shift((avoid, minDist) => this._pickSpot(avoid, minDist))

		this.quality = new Quality(this)
		this.quality.onChange = (tier, fromAuto) => {
			if (fromAuto) this.hud.toast(`GRAPHICS → ${this.quality.preset.label}`)
		}
		this.quality.set(this.quality.detectInitialTier())
		this.quality.apply()

		this._hit = {}
		this._v = new THREE.Vector3()
		this._camAt = new THREE.Vector3(0, 8, 18)
		this._camLook = new THREE.Vector3()
		this._sky = new THREE.Color()
		this._rampVy = 0
		this._prevGround = 0
		this._radio = 0

		this._loadProgress()
		this._bindUI()
		this._resize()
		addEventListener("resize", () => this._resize())
		this.refreshTitleBoard()

		$("loading").classList.add("hidden")
		this._loop = this._loop.bind(this)
		this.clock = new THREE.Clock()
		requestAnimationFrame(this._loop)
	}

	// ------------------------------------------------------------ setup

	_initRenderer() {
		this.renderer = new THREE.WebGLRenderer({
			canvas: this.canvas,
			antialias: false,
			powerPreference: "high-performance",
		})
		this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.35))
		this.renderer.shadowMap.enabled = true
		this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
		this.renderer.toneMapping = THREE.ACESFilmicToneMapping
		this.renderer.toneMappingExposure = 1.1

		this.scene = new THREE.Scene()
		this.camera = new THREE.PerspectiveCamera(64, 1, 0.3, 700)
		this.camera.position.set(0, 9, 20)

		this.composer = new EffectComposer(this.renderer)
		this.composer.addPass(new RenderPass(this.scene, this.camera))
		// Generous bloom — the neon IS the look of this game.
		this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.72, 0.7, 0.72)
		this.composer.addPass(this.bloom)
		this.composer.addPass(new OutputPass())
	}

	_resize() {
		// A 0x0 viewport would make the aspect NaN and poison the projection matrix
		// permanently, since this only re-runs on a resize event.
		const w = Math.max(1, innerWidth)
		const h = Math.max(1, innerHeight)
		this.camera.aspect = w / h
		this.camera.updateProjectionMatrix()
		this.renderer.setSize(w, h, false)
		this.composer.setSize(w, h)
		if (this.bloom) {
			const s = this.quality ? this.quality.preset.bloomScale : 0.5
			this.bloom.setSize(Math.max(64, w * s), Math.max(64, h * s))
		}
	}

	// ------------------------------------------------------------ progress

	/**
	 * Stars and unlocked cars persist across sessions, per game, in localStorage.
	 *
	 * Free-roam progress deliberately never touches the leaderboard — it's private
	 * collecting, not a competition.
	 */
	_loadProgress() {
		try {
			const stars = JSON.parse(localStorage.getItem(STARS_KEY) || "[]")
			if (Array.isArray(stars)) this.city.restoreStars(stars)
			const cars = JSON.parse(localStorage.getItem(CARS_KEY) || "null")
			this.unlocked = new Set(Array.isArray(cars) ? cars : ["scout"])
		} catch {
			this.unlocked = new Set(["scout"])
		}
		this.unlocked.add("scout")
		this._paintGarage()
	}

	_saveProgress() {
		try {
			localStorage.setItem(STARS_KEY, JSON.stringify(this.city.takenIndices()))
			localStorage.setItem(CARS_KEY, JSON.stringify([...this.unlocked]))
		} catch {
			// private mode; progress just won't persist
		}
	}

	_paintGarage() {
		const wrap = $("garage")
		if (!wrap) return
		const taken = this.city.starsTaken
		wrap.innerHTML = CAR_IDS.map((id) => {
			const c = CARS[id]
			const have = this.unlocked.has(id)
			const canBuy = !have && taken >= c.stars
			const cls = ["car-card", have ? "have" : canBuy ? "buy" : "locked"].join(" ")
			return (
				`<button class="${cls}" data-car="${id}">` +
				`<span class="cc-name">${c.label}</span>` +
				`<span class="cc-blurb">${c.blurb}</span>` +
				`<span class="cc-cost">${have ? (this.car.id === id ? "DRIVING" : "SELECT") : `${c.stars} ★`}</span>` +
				`</button>`
			)
		}).join("")
		for (const btn of wrap.querySelectorAll(".car-card")) {
			btn.onclick = () => this._chooseCar(btn.dataset.car)
		}
	}

	_chooseCar(id) {
		const spec = CARS[id]
		if (!spec) return
		if (!this.unlocked.has(id)) {
			if (this.city.starsTaken < spec.stars) {
				this.hud.toast(`NEEDS ${spec.stars} STARS`, "bad")
				return
			}
			this.unlocked.add(id)
			this._saveProgress()
			this.hud.toast(`${spec.label} UNLOCKED`, "good")
		}
		this.car.setCar(id)
		this.scene.remove(this.carMesh)
		this._disposeMesh(this.carMesh)
		this.carMesh = buildCarMesh(id)
		this.scene.add(this.carMesh)
		this._paintGarage()
	}

	_disposeMesh(root) {
		root.traverse((o) => {
			if (o.geometry) o.geometry.dispose()
			if (o.material) {
				for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose()
			}
		})
	}

	// ------------------------------------------------------------ UI

	_bindUI() {
		$("btn-roam").onclick = () => this.startRoam()
		$("btn-shift").onclick = () => this.startShift()
		$("btn-resume").onclick = () => this.resume()
		$("btn-quit").onclick = () => this.toMenu()
		$("btn-shift-now").onclick = () => this.startShift()
		$("btn-again").onclick = () => this.startShift()
		$("btn-roam-after").onclick = () => this.startRoam()
		$("btn-menu-after").onclick = () => this.toMenu()

		const pauseBtn = $("btn-pause")
		if (pauseBtn) pauseBtn.onclick = () => (this.state === "paused" ? this.resume() : this.pause())

		const opt = (id, key, fn) => {
			const el = $(id)
			if (!el) return
			el.checked = this.options[key]
			el.onchange = () => {
				this.options[key] = el.checked
				fn?.(el.checked)
			}
		}
		opt("opt-audio", "audio", (v) => this.audio.setEnabled(v))
		opt("opt-bloom", "bloom", (v) => {
			this.bloom.enabled = v && this.quality.preset.bloom
		})

		const qsel = $("opt-quality")
		if (qsel) {
			qsel.value = "auto"
			qsel.onchange = () => {
				if (qsel.value === "auto") this.quality.setAuto(true)
				else {
					this.quality.setAuto(false)
					this.quality.set(qsel.value)
				}
			}
		}
		const fps = $("opt-fps")
		if (fps) fps.onchange = () => $("perf").classList.toggle("hidden", !fps.checked)

		document.addEventListener("visibilitychange", () => {
			if (document.hidden && this.state === "shift") this.pause()
		})

		const checkOrientation = () => {
			const touch = matchMedia("(hover: none) and (pointer: coarse)").matches
			$("rotate").classList.toggle("hidden", !(touch && innerHeight > innerWidth))
		}
		addEventListener("resize", checkOrientation)
		addEventListener("orientationchange", () => setTimeout(checkOrientation, 250))
		checkOrientation()

		this._bindSubmit()
	}

	/** Same roster-then-PIN flow as the other two games. */
	_bindSubmit() {
		const submitBtn = $("btn-submit")
		const pinInput = $("go-pin")
		const msg = $("go-submit-msg")

		const paintRoster = () => {
			for (const btn of document.querySelectorAll(".who")) {
				btn.classList.toggle("on", btn.dataset.who === (this.board.name || GUEST))
			}
			const guest = !this.board.isRostered
			$("go-pin-wrap").classList.toggle("hidden", guest)
			submitBtn.textContent = guest ? "SAVE HERE" : "POST SCORE"
		}

		for (const btn of document.querySelectorAll(".who")) {
			btn.onclick = () => {
				const who = btn.dataset.who
				if (who !== this.board.name) this.board.forgetPin()
				this.board.setName(who === GUEST ? "" : who)
				pinInput.value = this.board.pin
				msg.textContent = ""
				msg.classList.remove("warn")
				paintRoster()
			}
		}

		pinInput.value = this.board.pin
		pinInput.addEventListener("keydown", (e) => {
			e.stopPropagation()
			if (e.key === "Enter") submitBtn.click()
		})

		submitBtn.onclick = async () => {
			if (this._submitted) return
			if (this.board.isRostered) {
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
				score: this.shift.score,
				stats: this.shift.stats(this.city.starsTaken),
				durationMs: SHIFT_SECONDS * 1000,
				skipLocal: this._localSaved,
			})
			this._localSaved = true

			this._renderBoard($("go-board"), res.entries.slice(0, 8), {
				shared: res.shared,
				highlightAt: res.rank,
				title: "BEST THIS WEEK",
			})

			if (res.ok) {
				submitBtn.textContent = res.shared ? "POSTED" : "SAVED"
				if (res.shared && res.improved === false) {
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
				msg.classList.add("warn")
				if (res.status === 403 && /pin/i.test(res.error || "")) {
					msg.textContent = "WRONG PIN — SAVED ON THIS DEVICE"
					this.board.forgetPin()
					pinInput.value = ""
				} else if (res.status === 403) {
					msg.textContent = "BOARD NOT SET UP YET — SAVED ON THIS DEVICE"
				} else if (res.status === 429) {
					msg.textContent = "TOO SOON — SAVED ON THIS DEVICE"
				} else if (res.status === 409) {
					msg.textContent = "THIS WEEK IS CLOSED — SAVED ON THIS DEVICE"
				} else {
					msg.textContent = "SAVED ON THIS DEVICE — BOARD UNREACHABLE"
				}
				this._submitted = false
				submitBtn.disabled = false
				submitBtn.textContent = "TRY AGAIN"
			}
			this.refreshTitleBoard()
		}

		paintRoster()
	}

	_renderBoard(el, entries, { shared, highlightAt = null, title }) {
		if (!el) return
		const head = `<div class="board-title">${title}${shared ? "" : " · THIS DEVICE"}</div>`
		if (!entries.length) {
			el.innerHTML = `${head}<div class="board-empty">NO SHIFTS YET — BE THE FIRST</div>`
			return
		}
		el.innerHTML =
			head +
			entries
				.map((e, i) => {
					const you = highlightAt === i + 1 ? " you" : ""
					const name = String(e.player || "ANON").replace(/[<>&]/g, "")
					const d = e.stats && e.stats.deliveries
					return (
						`<div class="board-row top-${i + 1}${you}">` +
						`<span class="rk">${i + 1}</span>` +
						`<span class="nm">${name.toUpperCase()}</span>` +
						`<span class="wv">${d ? `${d} JOBS` : ""}</span>` +
						`<span class="sc">${Number(e.score).toLocaleString()}</span>` +
						`</div>`
					)
				})
				.join("")
	}

	async refreshTitleBoard() {
		const { entries, shared } = await this.board.top(5)
		this._renderBoard($("title-board"), entries, { shared, title: "BEST THIS WEEK" })
	}

	// ------------------------------------------------------------ modes

	_screens(show) {
		for (const id of ["title", "pause", "gameover"]) {
			$(id).classList.toggle("hidden", id !== show)
		}
	}

	_placeCar() {
		this.car.x = 0
		this.car.z = 8
		this.car.heading = 0
		this.car.y = 0
		this.car.stop()
		this._rampVy = 0
		this._prevGround = 0
	}

	startRoam() {
		this.audio.init()
		this.audio.resume()
		this.audio.setEnabled(this.options.audio)
		this._placeCar()
		this.state = "roam"
		this._screens(null)
		this.hud.show(true)
		this.hud.reset()
		this.hud.setStars(this.city.starsTaken, this.city.stars.length)
		this.hud.setMode("FREE ROAM", false)
		this.audio.startMusic()
		this.hud.toast("NO CLOCK, NO RULES — GO AND HAVE A LOOK", "good")
	}

	startShift() {
		this.audio.init()
		this.audio.resume()
		this.audio.setEnabled(this.options.audio)
		this._placeCar()
		this.shift.reset()
		this.state = "shift"
		this._submitted = false
		this._localSaved = false
		this._screens(null)
		this.hud.show(true)
		this.hud.reset()
		this.hud.setStars(this.city.starsTaken, this.city.stars.length)
		this.hud.setMode("SHIFT", true)
		this.audio.startMusic()
		this.hud.toast("FIVE MINUTES — GO", "good")
	}

	pause() {
		if (this.state !== "roam" && this.state !== "shift") return
		this._wasState = this.state
		this.state = "paused"
		this._screens("pause")
		this.audio.stopMusic()
		$("btn-shift-now").classList.toggle("hidden", this._wasState === "shift")
	}

	resume() {
		if (this.state !== "paused") return
		this.state = this._wasState
		this._screens(null)
		// A long pause can leave the context suspended, and the radio would just
		// never come back.
		this.audio.resume()
		this.audio.startMusic()
	}

	toMenu() {
		this.state = "menu"
		this._screens("title")
		this.hud.show(false)
		this.audio.stopMusic()
		this._saveProgress()
		this._paintGarage()
		this.refreshTitleBoard()
	}

	shiftOver() {
		this.state = "over"
		this.audio.stopMusic()
		this.audio.runOver()
		this.hud.show(false)
		this._saveProgress()

		const s = this.shift
		$("go-score").textContent = s.score.toLocaleString()
		$("go-jobs").textContent = String(s.delivered)
		$("go-dropped").textContent = String(s.dropped)
		$("go-streak").textContent = `${s.bestStreak}`
		$("go-best").textContent = s.bestRunSeconds ? `${s.bestRunSeconds}s` : "—"
		let rank = RANKS[0][1]
		for (const [min, name] of RANKS) if (s.score >= min) rank = name
		$("go-rank").textContent = rank
		$("go-title").textContent = s.delivered === 0 ? "NOTHING DELIVERED" : "SHIFT OVER"
		this._screens("gameover")

		$("go-pin").value = this.board.pin
		$("go-submit-msg").textContent = ""
		$("go-submit-msg").classList.remove("warn")
		$("btn-submit").disabled = false
		$("btn-submit").textContent = this.board.isRostered ? "POST SCORE" : "SAVE HERE"
		$("go-pin-wrap").classList.toggle("hidden", !this.board.isRostered)

		this.board
			.top(8)
			.then(({ entries, shared }) =>
				this._renderBoard($("go-board"), entries, { shared, title: "BEST THIS WEEK" }),
			)
	}

	/** A street spot at least `minDist` from `avoid`, so jobs are never trivial. */
	_pickSpot(avoid, minDist = 40) {
		const spots = this.city.spots
		for (let tries = 0; tries < 40; tries++) {
			const s = spots[Math.floor(Math.random() * spots.length)]
			if (Math.hypot(s.x - avoid.x, s.z - avoid.z) >= minDist) return s
		}
		return spots[Math.floor(Math.random() * spots.length)]
	}

	// ------------------------------------------------------------ driving

	_readInput() {
		const i = this.input
		let throttle = 0
		let steer = 0
		if (i.down("KeyW") || i.down("ArrowUp")) throttle += 1
		if (i.down("KeyS") || i.down("ArrowDown")) throttle -= 1
		if (i.down("KeyA") || i.down("ArrowLeft")) steer -= 1
		if (i.down("KeyD") || i.down("ArrowRight")) steer += 1
		return { throttle, steer, handbrake: i.down("Space") }
	}

	_driveCar(dt) {
		// Fully specified rather than `{}`: `control.steer` would be undefined, and
		// the airborne branch below multiplies it, so one frame of that would put a
		// NaN into the heading and never come back. (This branch is unreachable
		// today — _driveCar only runs while driving — which is exactly why it would
		// be a nasty surprise later.)
		const control =
			this.state === "paused" ? { throttle: 0, steer: 0, handbrake: false } : this._readInput()
		const airborne = this.car.y > this.city.groundAt(this.car.x, this.car.z) + 0.12

		// No grip in the air, so a jump keeps its momentum instead of being
		// steerable like a hovercraft.
		this.car.update(dt, airborne ? { throttle: 0, steer: control.steer * 0.15 } : control)
		this.car.airborne = airborne

		// ---- vertical
		const ground = this.city.groundAt(this.car.x, this.car.z)
		if (airborne) {
			this.car.vy -= GRAVITY * dt
			this.car.y += this.car.vy * dt
			if (this.car.y <= ground) {
				const hard = this.car.vy < -13
				this.car.y = ground
				this.car.vy = 0
				this.fx.ringBurst(new THREE.Vector3(this.car.x, ground + 0.2, this.car.z), 0xffc857, 0.7)
				this.audio.land(hard)
				if (hard) this.car.vx *= 0.82
				this.car.vz *= hard ? 0.82 : 1
			}
		} else {
			// On the ground: follow the surface, but limit how fast the car can be
			// lifted so driving into the SIDE of a ramp bumps you up rather than
			// teleporting you five metres into the air.
			const climb = ground - this.car.y
			this.car.y += clamp(climb, -GRAVITY * dt, 16 * dt)
			this.car.vy = 0
			// Leaving the lip of a ramp: convert the slope into a launch.
			//
			// The multiplier is doing real work rather than fudging units. These
			// ramps rise 5m over 20m, which is a 14° angle, so the honest vertical
			// component at 25 m/s is about 6 m/s — a 20cm hop, which is nothing. A
			// kicker that actually throws the car is what makes the ramps worth
			// finding, and this is an arcade game about a kid jumping a car.
			const rate = (ground - this._prevGround) / Math.max(dt, 1e-4)
			if (this._prevGround > 0.6 && ground < this._prevGround - 0.05 && this.car.speed > 9) {
				this.car.vy = Math.max(0, this._rampVy)
			}
			// Clamped, because `groundAt` is a step function: the wedge has vertical
			// faces at its lip and down both sides, so crossing one of those edges
			// makes `rate` the full ramp height divided by one frame — measured at
			// 788 m/s. Nothing but the climb limiter below was stopping that from
			// reaching `vy`, and a launch can never legitimately exceed the car's own
			// speed anyway.
			this._rampVy = clamp(rate * 2.2, 0, Math.min(15, this.car.speed * 0.7))
		}
		this._prevGround = ground

		// ---- horizontal collision
		const r = resolveCircle(this.city.grid, this.car.x, this.car.z, CAR_RADIUS, this._hit)
		if (r.hit) {
			this.car.x = r.x
			this.car.z = r.z
			const impact = this.car.bounce(r.nx, r.nz)
			if (impact > CRASH_AT) {
				this.fx.impact(
					new THREE.Vector3(this.car.x, 1, this.car.z),
					new THREE.Vector3(r.nx, 0.4, r.nz),
					0.8,
				)
				this.audio.crash(clamp(impact / 24, 0.2, 1))
				if (this.state === "shift") this.shift.crash()
			}
		}

		// Belt and braces: never let the car leave the map, whatever happens above.
		const lim = CITY_HALF + 6
		this.car.x = clamp(this.car.x, -lim, lim)
		this.car.z = clamp(this.car.z, -lim, lim)
	}

	_paintCar(dt) {
		const c = this.car
		this.carMesh.position.set(c.x, c.y + 0.62, c.z)
		this.carMesh.rotation.y = c.heading
		this.carMesh.rotation.z = c.lean
		// Nose down a little under braking and up under power, from the change in
		// forward speed. Cheap, and it does a lot for the sense of weight.
		const accel = (c.forwardSpeed - (this._lastFwd ?? 0)) / Math.max(dt, 1e-4)
		this._lastFwd = c.forwardSpeed
		this.carMesh.rotation.x = damp(this.carMesh.rotation.x, clamp(-accel * 0.004, -0.07, 0.07), 0.001, dt)
		if (this.carMesh.userData.spin) {
			for (const w of this.carMesh.userData.spin) w.rotation.x = c.wheelSpin
		}
		if (this.carMesh.userData.steerWheels) {
			// Negated for the same reason as the yaw rate: +Y rotation points the
			// wheels left, and a positive steer input means right.
			for (const w of this.carMesh.userData.steerWheels) w.rotation.y = -c.steerShown * 0.5
		}
		// Tyre smoke while sliding.
		if (c.drifting && !c.airborne && Math.random() < 0.6) {
			this.fx.spawn(
				c.x - c.fwdX * 1.6,
				0.25,
				c.z - c.fwdZ * 1.6,
				(Math.random() - 0.5) * 2,
				Math.random() * 1.4,
				(Math.random() - 0.5) * 2,
				0xd8d2e8,
				0.5,
				0.7,
				-0.6,
				1.2,
			)
		}
	}

	_updateCamera(dt) {
		const c = this.car
		// Chase camera: further back and lower the faster you go, so speed reads
		// in the frame rather than only on the speedo.
		const back = lerp(11, 16.5, c.speedFrac)
		const up = lerp(5.4, 4.4, c.speedFrac)
		// Look where the car is GOING when sliding, not where it points — otherwise
		// a drift swings the whole world around and you can't see the corner.
		const dirX = c.speed > 3 ? c.vx / c.speed : c.fwdX
		const dirZ = c.speed > 3 ? c.vz / c.speed : c.fwdZ
		const blendX = lerp(c.fwdX, dirX, 0.45)
		const blendZ = lerp(c.fwdZ, dirZ, 0.45)

		this._camAt.set(c.x - blendX * back, c.y + up, c.z - blendZ * back)
		const k = 1 - Math.pow(0.0006, dt)
		this.camera.position.lerp(this._camAt, k)
		if (this.camera.position.y < 1.6) this.camera.position.y = 1.6

		this._v.set(c.x + blendX * 8, c.y + 1.9, c.z + blendZ * 8)
		this._camLook.lerp(this._v, 1 - Math.pow(0.0008, dt))
		this.camera.lookAt(this._camLook)
		this.camera.fov = lerp(60, 72, c.speedFrac)
		this.camera.updateProjectionMatrix()
	}

	/** Angle from where the car points to where it needs to go, for the arrow. */
	_waypoint() {
		if (this.state !== "shift" || !this.shift.job) return null
		const job = this.shift.job
		const t = job.carrying ? job.drop : job.pickup
		const dx = t.x - this.car.x
		const dz = t.z - this.car.z
		const dist = Math.hypot(dx, dz)
		// `bearing` is a compass angle — clockwise-positive from -Z, which is what a
		// CSS rotate() wants. `heading` is an ordinary maths angle, so it runs the
		// other way: the car's own compass bearing is -heading. The relative angle
		// is therefore bearing - (-heading), and getting that sign wrong put the
		// arrow out by twice the heading — correct only when driving due north or
		// due south, which is exactly often enough to look like it works.
		const bearing = Math.atan2(dx, -dz)
		let rel = bearing + this.car.heading
		while (rel > Math.PI) rel -= Math.PI * 2
		while (rel < -Math.PI) rel += Math.PI * 2
		return { rel, dist, kind: job.carrying ? "drop" : "pickup" }
	}

	// ------------------------------------------------------------ loop

	_loop() {
		requestAnimationFrame(this._loop)
		const dt = Math.min(this.clock.getDelta(), 0.05)
		this.time += dt

		const driving = this.state === "roam" || this.state === "shift"

		// Polled outside the driving branch: endFrame() clears the edge every frame,
		// so an Escape pressed while paused was being consumed and thrown away —
		// leaving a keyboard-only game whose pause menu could only be left with a
		// mouse.
		if (this.input.once("Escape")) {
			if (driving) this.pause()
			else if (this.state === "paused") this.resume()
		}

		if (driving) {
			if (this.input.once("KeyR")) this._nextStation()
			if (this.input.once("Enter") && this.state === "roam") this.startShift()

			this._driveCar(dt)

			const got = this.city.collectStars(this.car.x, this.car.y, this.car.z)
			if (got) {
				this.audio.star()
				this.hud.setStars(this.city.starsTaken, this.city.stars.length)
				this.fx.ringBurst(new THREE.Vector3(this.car.x, this.car.y + 1, this.car.z), 0xffe58a, 0.8)
				this._saveProgress()
				this._checkUnlocks()
			}

			if (this.state === "shift") {
				this.shift.update(dt, this.car)
				this._handleShiftEvent()
				this.hud.setClock(this.shift.timeLeft)
				this.hud.setCash(this.shift.score, dt)
				this.hud.setStreak(this.shift.multiplier)
				this.hud.setJob(this.shift.job)
				if (this.shift.over) this.shiftOver()
			}

			const wp = this._waypoint()
			this.hud.setWaypoint(wp ? wp.rel : null, wp ? wp.dist : 0, wp ? wp.kind : "")
			this.hud.setSpeed(
				this.car.kph,
				this.car.speedFrac,
				this.car.forwardSpeed < -0.5,
				this.car.drifting,
				this.car.airborne,
			)
			this.audio.setIntensity(this.car.speedFrac)
		} else if (this.state === "menu") {
			// Slow orbit over the city behind the menu.
			const a = this.time * 0.07
			this.camera.position.set(Math.cos(a) * BLOCK * 2.4, 46, Math.sin(a) * BLOCK * 2.4)
			this.camera.lookAt(0, 6, 0)
			this.camera.fov = 60
			this.camera.updateProjectionMatrix()
		}

		this.city.update(dt)
		this.fx.update(dt)
		if (driving) {
			this._paintCar(dt)
			this._updateCamera(dt)
		}
		this.renderer.setClearColor(this.city.skyColour(this._sky))

		this.composer.render()
		this.quality.sample()
		if (this._perfT === undefined || this.time - this._perfT > 0.4) {
			this._perfT = this.time
			const f = $("perf-fps")
			if (f) f.textContent = String(this.quality.fps)
			const t = $("perf-tier")
			if (t) t.textContent = this.quality.preset.label
		}
		this.input.endFrame()
	}

	_handleShiftEvent() {
		const e = this.shift.takeEvent()
		if (!e) return
		if (e.kind === "job") this.hud.toast(`NEW JOB — ${e.job.pickup.label}`)
		else if (e.kind === "pickup") {
			this.audio.pickup()
			this.hud.toast(`GOT IT — TAKE IT TO ${this.shift.job.drop.label}`, "good")
		} else if (e.kind === "delivered") {
			this.audio.delivered()
			this.hud.pop(`+$${e.gained.toLocaleString()}`, e.clean ? "good" : "")
			this.fx.ringBurst(new THREE.Vector3(this.car.x, 1.2, this.car.z), 0x4ce0a0, 1.1)
		} else if (e.kind === "dropped") {
			this.audio.failed()
			this.hud.pop("TOO LATE", "bad")
		}
	}

	_checkUnlocks() {
		const taken = this.city.starsTaken
		for (const id of CAR_IDS) {
			if (!this.unlocked.has(id) && taken >= CARS[id].stars) {
				this.unlocked.add(id)
				this.hud.toast(`${CARS[id].label} UNLOCKED — PICK IT IN THE GARAGE`, "good")
				this._saveProgress()
				this._paintGarage()
			}
		}
	}

	_nextStation() {
		this._radio = (this._radio + 1) % this.audio.stations.length
		this.audio.setStation(this._radio)
		this.hud.setRadio(this.audio.stations[this._radio])
		this.hud.toast(`RADIO — ${this.audio.stations[this._radio]}`)
	}
}

// The same intentional debug surface as the other two games.
addEventListener("DOMContentLoaded", () => {
	try {
		window.game = new Game()
		window.__THREE = THREE
	} catch (err) {
		console.error(err)
		const load = $("loading")
		if (load) {
			load.classList.remove("hidden")
			// Report what actually broke. Blaming WebGL for every startup failure
			// sends whoever is debugging it to look at the GPU when the real cause
			// is usually a plain TypeError two lines into a constructor.
			const webgl = !document.createElement("canvas").getContext("webgl2")
			load.innerHTML = webgl
				? `<div class="t-inner"><h2>NO WEBGL2</h2><p class="t-sub">This city needs WebGL2. Try a different browser, or turn on hardware acceleration.</p></div>`
				: `<div class="t-inner"><h2>IT BROKE</h2><p class="t-sub">${String(err && err.message ? err.message : err).replace(/[<>&]/g, "")}</p></div>`
		}
	}
})
