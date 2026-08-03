// MIKE: QUIET WATER — bootstrap, the fishing loop, and the three-minute run.
//
// One run is a fixed three minutes on the dock. That is a deliberate choice: a
// timed run makes scores comparable, which is what the weekly board needs, and
// it stops a session from sprawling into an evening.
//
// The loop is cast → read the water → hook → fight → land, and each step is a
// separate skill. Casting rewards watching the surface, hooking rewards learning
// each species' rhythm, and the fight rewards restraint. The fight is where the
// ceiling is; see fish.js for the rule it turns on.

import * as THREE from "three"
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js"
import { RenderPass } from "three/addons/postprocessing/RenderPass.js"
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js"
import { OutputPass } from "three/addons/postprocessing/OutputPass.js"

import { clamp, damp, lerp, rand } from "../../shared/util.js"
import { Leaderboard } from "../../shared/leaderboard.js"
import { bindIdentity } from "../../shared/identity.js"
import { Audio } from "./audio.js"
import { CAST_MAX, CAST_MIN, Lake, SPOT_KINDS } from "./lake.js"
import { Bite, Fight, SPECIES, catchScore, rollGrams, rollSpecies } from "./fish.js"
import { makeFishMesh } from "./fishmesh.js"
import { ROD_BASE, Rod } from "./rod.js"
import { HUD } from "./hud.js"
import { Pointer } from "./pointer.js"
import { FX } from "./fx.js"
import { Quality } from "./quality.js"

const $ = (id) => document.getElementById(id)

const RUN_SECONDS = 180
/** Consecutive landings each add this to the multiplier, up to FLOW_MAX. */
const FLOW_STEP = 0.5
const FLOW_MAX = 3

const RANKS = [
	[0, "DAY TRIPPER"],
	[400, "WEEKENDER"],
	[1500, "ROD HAND"],
	[4000, "LAKE REGULAR"],
	[8000, "OLD HAND"],
	[16000, "LAKE KEEPER"],
	[30000, "QUIET WATER"],
]

class Game {
	constructor() {
		this.state = "menu" // menu | playing | paused | over
		this.phase = "idle" // idle | charge | flight | wait | tell | fight | settle
		this.time = 0
		this.timeLeft = RUN_SECONDS
		this.options = { audio: true, bloom: true, shake: true }

		this.canvas = $("scene")
		this._initRenderer()

		this.audio = new Audio()
		this.pointer = new Pointer(this.canvas)
		// The input scheme is already touch-native; this just switches on the
		// shared touch CSS (overscroll-behavior none, so a reeling drag can't
		// trigger pull-to-refresh).
		if (this.pointer.isTouch) document.body.classList.add("touch")
		this.hud = new HUD()
		this.board = new Leaderboard("fish")

		this.lake = new Lake(this.scene)
		this.fx = new FX(this.scene)
		this.rod = new Rod(this.scene, this.lake)
		this.rod.setView(this.camera, innerHeight)

		this._buildAim()

		this.quality = new Quality(this)
		this.quality.onChange = (tier, fromAuto) => this._onQualityChange(tier, fromAuto)
		this.quality.set(this.quality.detectInitialTier())
		this.quality.apply()

		// Scratch vectors — nothing in the loop allocates.
		this._v = new THREE.Vector3()
		this._target = new THREE.Vector3()
		this._landing = new THREE.Vector3()
		this._ray = new THREE.Raycaster()
		this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
		this._camAim = new THREE.Vector3()

		this.hookedMesh = null

		this.resetRun()
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
		this.renderer.toneMappingExposure = 1.06

		this.scene = new THREE.Scene()
		this.camera = new THREE.PerspectiveCamera(58, 1, 0.1, 500)
		this.camera.position.set(0.3, 2.35, -1.0)

		this.composer = new EffectComposer(this.renderer)
		this.composer.addPass(new RenderPass(this.scene, this.camera))
		// Just enough bloom to make the sun on the water crests glitter.
		this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.75, 0.86)
		this.composer.addPass(this.bloom)
		this.composer.addPass(new OutputPass())
	}

	_resize() {
		// Never divide by a zero viewport. A hidden iframe or a not-yet-laid-out
		// container reports 0x0, which makes the aspect NaN, poisons the
		// projection matrix, and leaves every raycast returning nothing — and
		// since this only re-runs on a resize event, the game would stay broken
		// rather than recovering.
		const w = Math.max(1, innerWidth)
		const h = Math.max(1, innerHeight)
		this.camera.aspect = w / h
		this.camera.updateProjectionMatrix()
		this.renderer.setSize(w, h, false)
		this.composer.setSize(w, h)
		// The line ribbon's screen-space width floor needs the render height.
		this.rod.setView(this.camera, h * this.renderer.getPixelRatio())
		// composer.setSize resizes the bloom to the full viewport, so the preset's
		// bloomScale has to be re-applied after it — otherwise the five-mip chain
		// runs at 100% on every tier that has bloom on, which is roughly 4x the
		// pixel work the preset table claims to be asking for.
		if (this.bloom) {
			const s = this.quality ? this.quality.preset.bloomScale : 0.5
			this.bloom.setSize(Math.max(64, w * s), Math.max(64, h * s))
		}
	}

	/** The reticle: where you are pointing, and where the cast would actually land. */
	_buildAim() {
		const ringGeo = new THREE.RingGeometry(0.5, 0.62, 28)
		ringGeo.rotateX(-Math.PI / 2)
		this.aimTarget = new THREE.Mesh(
			ringGeo,
			new THREE.MeshBasicMaterial({
				color: 0xe8e2cc,
				transparent: true,
				opacity: 0.28,
				depthWrite: false,
			}),
		)
		const landGeo = new THREE.RingGeometry(0.28, 0.46, 24)
		landGeo.rotateX(-Math.PI / 2)
		this.aimLanding = new THREE.Mesh(
			landGeo,
			new THREE.MeshBasicMaterial({
				color: 0xf2cf85,
				transparent: true,
				opacity: 0.85,
				depthWrite: false,
			}),
		)
		this.aimTarget.visible = false
		this.aimLanding.visible = false
		this.scene.add(this.aimTarget, this.aimLanding)
	}

	_bindUI() {
		$("btn-play").onclick = () => this.start()
		$("btn-again").onclick = () => this.start()
		$("btn-resume").onclick = () => this.resume()
		$("btn-quit").onclick = () => this.toMenu()
		// Every screen that can trap you needs a way out; the game-over screen used
		// to offer nothing but "play again".
		$("btn-menu-after").onclick = () => this.toMenu()

		const pauseBtn = $("btn-pause")
		if (pauseBtn) pauseBtn.onclick = () => (this.state === "playing" ? this.pause() : this.resume())

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

		// Pausing when the tab goes away matters more here than in a shooter: the
		// run clock is the score, so a backgrounded tab must not burn it.
		document.addEventListener("visibilitychange", () => {
			if (document.hidden && this.state === "playing") this.pause()
		})

		const checkOrientation = () => {
			if (!this.pointer.isTouch) return
			const portrait = innerHeight > innerWidth
			$("rotate").classList.toggle("hidden", !portrait)
			if (portrait && this.state === "playing") this.pause()
		}
		addEventListener("resize", checkOrientation)
		addEventListener("orientationchange", () => setTimeout(checkOrientation, 250))
		checkOrientation()

		this._bindSubmit()
	}

	// ------------------------------------------------------------ leaderboard

	/** Same roster-then-PIN flow as the shooter, so the arcade behaves consistently. */
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
				// Whoever is playing has changed, so the last submission's outcome no
				// longer applies. Without this, a friend who taps SAVE HERE and THEN
				// signs up is left holding a disabled button that reads POST SCORE,
				// and that run can never reach the board — the exact first-run
				// experience of the person this signup form exists for.
				this._submitted = false
				submitBtn.disabled = false
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

			// Claimed before the await, not after. Changing who is playing re-arms
			// this button on purpose (a guest who saved and then signed up must be
			// able to post that run), and that can happen while a submission is
			// still in flight — so the second click has to already know the run is
			// on the local table, or it appends a duplicate under the new name.
			const alreadySaved = this._localSaved
			this._localSaved = true

			const res = await this.board.submit({
				score: this.score,
				stats: {
					landed: this.landed,
					heaviest: this.heaviest,
					species: Object.keys(this.caught).length,
					// Best multiplier reached, ×10 so it stays an integer.
					flow: Math.round(this.bestFlow * 10),
				},
				durationMs: RUN_SECONDS * 1000,
				skipLocal: alreadySaved,
			})

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
	}

	_renderBoard(el, entries, { shared, highlightAt = null, title }) {
		if (!el) return
		const head = `<div class="board-title">${title}${shared ? "" : " · THIS DEVICE"}</div>`
		if (!entries.length) {
			el.innerHTML = `${head}<div class="board-empty">NO CATCHES YET — BE THE FIRST</div>`
			return
		}
		const rows = entries
			.map((e, i) => {
				const you = highlightAt === i + 1 ? " you" : ""
				const name = String(e.player || "ANON").replace(/[<>&]/g, "")
				const heaviest = e.stats && e.stats.heaviest
				const brag = heaviest ? `${(heaviest / 1000).toFixed(1)}kg` : ""
				return (
					`<div class="board-row top-${i + 1}${you}">` +
					`<span class="rk">${i + 1}</span>` +
					`<span class="nm">${name.toUpperCase()}${e.visitor ? ` <span class="vis">VISITOR</span>` : ""}</span>` +
					`<span class="wv">${brag}</span>` +
					`<span class="sc">${Number(e.score).toLocaleString()}</span>` +
					`</div>`
				)
			})
			.join("")
		el.innerHTML = head + rows
	}

	async refreshTitleBoard() {
		const { entries, shared } = await this.board.top(5)
		this._renderBoard($("title-board"), entries, { shared, title: "BEST THIS WEEK" })
	}

	_onQualityChange(tier, fromAuto) {
		if (fromAuto) this.hud.toast(`GRAPHICS → ${this.quality.preset.label}`)
		const sel = $("opt-quality")
		if (sel && fromAuto) sel.value = "auto"
	}

	// ------------------------------------------------------------ run flow

	resetRun() {
		this.timeLeft = RUN_SECONDS
		this.score = 0
		this.landed = 0
		this.heaviest = 0
		this.streak = 0
		this.flow = 1
		this.bestFlow = 1
		this.caught = {}
		this.bite = null
		this.fight = null
		this.phase = "idle"
		this._settleT = 0
		this._biteAt = 0
		this._spotQuality = 0
		this._spotKind = "open"
		this.rod.reelIn()
		this._clearHooked()
		this.lake.reset()
		this.hud.reset()
		this.hud.setTally(this.caught)
	}

	start() {
		this.audio.init()
		this.audio.resume()
		this.audio.setEnabled(this.options.audio)
		this.resetRun()
		this.state = "playing"
		$("title").classList.add("hidden")
		$("gameover").classList.add("hidden")
		$("pause").classList.add("hidden")
		this.hud.show(true)
		this.audio.startMusic()
		this.hud.toast("THREE MINUTES — GOOD LUCK", "good")
	}

	pause() {
		if (this.state !== "playing") return
		this.state = "paused"
		$("pause").classList.remove("hidden")
		this.audio.stopMusic()
	}

	resume() {
		if (this.state !== "paused") return
		this.state = "playing"
		$("pause").classList.add("hidden")
		this.audio.startMusic()
	}

	toMenu() {
		this.state = "menu"
		$("pause").classList.add("hidden")
		$("gameover").classList.add("hidden")
		$("title").classList.remove("hidden")
		this.hud.show(false)
		this.audio.stopMusic()
		this.resetRun()
		this.refreshTitleBoard()
	}

	runOver() {
		this.state = "over"
		this.audio.stopMusic()
		this.audio.runOver()
		// A fish still on the line at the whistle is lost — landing it is the
		// achievement, not hooking it.
		if (this.fight) this._lose("time", { quiet: true })
		// Put the fishing loop fully back to rest. `_lose({quiet})` deliberately
		// leaves `phase` alone, so without this the run ends on phase "fight" with
		// no fight object: the rod's per-frame update is gated off that phase, so
		// it would sit visibly bent with nothing on the line for as long as the
		// game-over screen is up, and any future path back to "playing" that
		// skipped resetRun would dereference a null fight.
		this.phase = "idle"
		this.bite = null
		this._warned = false
		this._took = false
		this.rod.reelIn()
		this.hud.hidePower()
		this.hud.hidePrompt()
		this.hud.setSpot(null)
		this.aimTarget.visible = false
		this.aimLanding.visible = false
		this._clearHooked()
		this.hud.show(false)

		$("go-score").textContent = this.score.toLocaleString()
		$("go-landed").textContent = this.landed
		$("go-heaviest").textContent =
			this.heaviest >= 1000 ? `${(this.heaviest / 1000).toFixed(2)}kg` : `${this.heaviest}g`
		$("go-species").textContent = `${Object.keys(this.caught).length}/${Object.keys(SPECIES).length}`
		$("go-flow").textContent = `${this.bestFlow.toFixed(1)}×`
		let rank = RANKS[0][1]
		for (const [min, name] of RANKS) if (this.score >= min) rank = name
		$("go-rank").textContent = rank
		$("go-title").textContent = this.landed === 0 ? "NOT A NIBBLE" : "LINES IN"
		$("gameover").classList.remove("hidden")

		$("go-pin").value = this.board.pin
		$("go-submit-msg").textContent = ""
		$("go-submit-msg").classList.remove("warn")
		$("btn-submit").disabled = false
		// Repaints the name strip and sets the submit button to match who is
		// playing — a friend may have signed up since the last run.
		this._identity.refresh()
		this._submitted = false
		this._localSaved = false

		this.board
			.top(8)
			.then(({ entries, shared }) =>
				this._renderBoard($("go-board"), entries, { shared, title: "BEST THIS WEEK" }),
			)
	}

	// ------------------------------------------------------------ aiming

	/**
	 * Where the player is pointing, and where a cast at the current charge would
	 * actually land.
	 *
	 * Aim is free but range is not: you point wherever you like, and the wind-up
	 * decides how far down that line the float reaches. Showing both rings makes
	 * that legible without a word of explanation.
	 */
	_aim() {
		this._ray.setFromCamera({ x: this.pointer.nx, y: this.pointer.ny }, this.camera)
		const hit = this._ray.ray.intersectPlane(this._plane, this._v)
		if (!hit) return false

		// Keep it out over the water in front of the dock.
		let x = this._v.x
		let z = Math.min(this._v.z, -CAST_MIN * 0.4)
		// Measured from where the angler stands, not from the rod tip. The tip
		// moves as the rod bends and loads, which would make the reachable ring
		// breathe in and out while you aim — and it put the near edge of the ring
		// past the dock shadow, so that spot could never be cast to at all.
		const from = ROD_BASE
		let dx = x - from.x
		let dz = z - from.z
		let dist = Math.hypot(dx, dz)
		if (dist < 0.001) return false
		const capped = Math.min(dist, CAST_MAX + 3)
		this._target.set(from.x + (dx / dist) * capped, 0, from.z + (dz / dist) * capped)

		const reach = Rod.reachFor(this.rod.charge, CAST_MIN, CAST_MAX)
		const land = Math.min(capped, reach)
		this._landing.set(from.x + (dx / dist) * land, 0, from.z + (dz / dist) * land)
		return true
	}

	// ------------------------------------------------------------ fishing loop

	_beginWait() {
		const spot = this.lake.spotAt(this.rod.bobber.x, this.rod.bobber.z)
		this._spotQuality = spot.quality
		this._spotKind = spot.kind
		// Good water bites fast. Open water is slow enough to be worth leaving.
		this._biteAt = lerp(rand(4.5, 8.5), rand(0.9, 2.2), spot.quality)
		this._waitT = 0
		this.phase = "wait"
		this.hud.toast(SPOT_KINDS[spot.kind].label, spot.quality >= 0.55 ? "good" : "")
	}

	_beginBite() {
		const id = rollSpecies(this._spotQuality)
		const grams = rollGrams(id, this._spotQuality)
		this.bite = new Bite(id, grams, this._spotQuality)
		this.phase = "tell"
		this._took = false
		this.audio.nibble(SPECIES[id].tell.sink)
	}

	_hook() {
		const bite = this.bite
		this.bite = null
		const lineOut = Math.hypot(this.rod.bobber.x - ROD_BASE.x, this.rod.bobber.z - ROD_BASE.z)
		this.fight = new Fight(bite.id, bite.grams, Math.max(6, lineOut))
		this.fight.angle = Math.atan2(this.rod.bobber.x, -this.rod.bobber.z)
		this.phase = "fight"
		this.audio.hook()
		this.hud.showFight(bite.id)
		this.hud.hidePrompt()
		this.lake.spawnRing(this.rod.bobber.x, this.rod.bobber.z, { transient: true })

		this.hookedMesh = makeFishMesh(bite.id, bite.grams)
		this.hookedMesh.visible = false
		this.scene.add(this.hookedMesh)
	}

	_spook(reason) {
		this.bite = null
		this.phase = "settle"
		this._settleT = 0.7
		this.audio.spook()
		this.hud.toast(reason === "early" ? "TOO SOON — IT SPOOKED" : "MISSED IT", "bad")
		this._breakFlow()
	}

	_land() {
		const f = this.fight
		const gained = catchScore(f.id, f.grams, this.flow)
		this.score += gained
		this.landed++
		this.streak++
		this.flow = Math.min(FLOW_MAX, 1 + this.streak * FLOW_STEP)
		this.bestFlow = Math.max(this.bestFlow, this.flow)
		this.heaviest = Math.max(this.heaviest, f.grams)
		this.caught[f.id] = (this.caught[f.id] || 0) + 1

		this.hud.setFlow(this.flow)
		this.hud.setTally(this.caught)
		this.hud.catchCard(f.id, f.grams, gained)
		this.audio.landed(SPECIES[f.id].rare)
		this.fx.ringBurst(this.rod.bobber.clone(), 0xcfe6dc, 1.1)

		this.fight = null
		this.phase = "settle"
		this._settleT = 1.1
		this.hud.hideFight()
		this._clearHooked()
	}

	_lose(reason, { quiet = false } = {}) {
		const f = this.fight
		if (f && !quiet) {
			this.fx.ringBurst(this.rod.bobber.clone(), 0xb9c4bd, 0.8)
			this.lake.spawnRing(this.rod.bobber.x, this.rod.bobber.z, { transient: true })
			if (reason === "snapped") {
				this.audio.snap()
				this.hud.toast("LINE SNAPPED", "bad")
			} else {
				this.audio.spook()
				this.hud.toast("IT SPOOLED YOU", "bad")
			}
		}
		this.fight = null
		this._breakFlow()
		this.hud.hideFight()
		this._clearHooked()
		if (!quiet) {
			this.phase = "settle"
			this._settleT = 0.9
		}
	}

	_breakFlow() {
		this.streak = 0
		this.flow = 1
		this.hud.setFlow(1)
	}

	_clearHooked() {
		if (!this.hookedMesh) return
		this.scene.remove(this.hookedMesh)
		// scene.remove frees nothing on the GPU — three.js only releases buffers
		// and programs from the geometry's and material's dispose events. A fish is
		// built fresh per hook, so without this a three-minute run orphans well
		// over a hundred geometries, and a session of back-to-back runs without a
		// reload climbs until it stutters. Which then gets blamed on the water.
		this.hookedMesh.traverse((o) => {
			if (o.geometry) o.geometry.dispose()
			if (o.material) {
				for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose()
			}
		})
		this.hookedMesh = null
	}

	_updateFishing(dt) {
		const p = this.pointer

		switch (this.phase) {
			case "idle": {
				this._aim()
				this.aimTarget.visible = true
				this.aimLanding.visible = true
				this.hud.setSpot(SPOT_KINDS[this.lake.spotAt(this._landing.x, this._landing.z).kind].label)
				this.hud.prompt("HOLD TO CAST", p.isTouch ? "TAP + HOLD" : "CLICK / SPACE")
				if (p.pressed) {
					this.rod.beginCharge()
					this.phase = "charge"
				}
				break
			}

			case "charge": {
				this.rod.chargeUp(dt)
				this._aim()
				this.hud.setPower(this.rod.charge, Rod.reachFor(this.rod.charge, CAST_MIN, CAST_MAX))
				this.hud.setSpot(SPOT_KINDS[this.lake.spotAt(this._landing.x, this._landing.z).kind].label)
				this.hud.prompt("LET GO TO CAST", "")
				if (!p.down) {
					this.audio.cast(this.rod.charge)
					this.rod.release(this._landing)
					this.hud.hidePower()
					this.hud.hidePrompt()
					this.aimTarget.visible = false
					this.aimLanding.visible = false
					this.phase = "flight"
				}
				break
			}

			case "flight": {
				if (!this.rod.cast) {
					this.audio.splash()
					this.fx.ringBurst(this.rod.bobber.clone(), 0xdaeae2, 0.7)
					this.lake.spawnRing(this.rod.bobber.x, this.rod.bobber.z, { transient: true })
					this._beginWait()
				}
				break
			}

			case "wait": {
				this._waitT += dt
				this.hud.prompt("WATCH THE FLOAT", "")
				// Reeling in early is always allowed — leaving dead water is a real
				// decision, not something to be locked out of.
				if (p.pressed) {
					this.rod.reelIn()
					this.phase = "idle"
					break
				}
				if (this._waitT >= this._biteAt) this._beginBite()
				break
			}

			case "tell": {
				const bite = this.bite
				bite.update(dt)
				this.rod.sink = bite.bobberSink()
				if (bite.phase === "window") {
					// One cue the moment it takes, not one per frame — same shape as
					// the fight's _warned. The float going under is a few pixels on a
					// phone; this is the sound that carries the strike moment.
					if (!this._took) {
						this._took = true
						this.audio.take()
					}
					this.hud.prompt("NOW — SET THE HOOK", "")
				} else this.hud.prompt("WAIT FOR IT", "")

				if (p.pressed) {
					if (bite.canHook) this._hook()
					// A strike after the window closes is LATE — telling that player
					// "TOO SOON" coaches them to wait even longer, the exact inversion
					// of the correction they need.
					else this._spook(bite.phase === "gone" ? "late" : "early")
					break
				}
				if (bite.expired) {
					this.rod.sink = 0
					this._spook("late")
				}
				break
			}

			case "fight": {
				const f = this.fight
				const reeling = p.down
				f.update(dt, reeling)

				// Drag the float around so the fight is visible on the water, not
				// only in the meter.
				const dist = Math.max(1.5, f.line)
				const bx = ROD_BASE.x + Math.sin(f.angle) * dist
				const bz = ROD_BASE.z - Math.cos(f.angle) * dist
				this._camAim.set(bx, 0, bz)
				this.rod.sink = 0.12 + f.tension * 0.3
				this.rod.update(dt, { tension: f.tension, pullDir: this._camAim, reeling })

				if (f.surged) {
					this.audio.surge()
					this.fx.ringBurst(this.rod.bobber.clone(), 0xc8dcd4, 0.5)
				}
				// One cue per telegraph, not one per frame.
				if (f.warning && !this._warned) {
					this._warned = true
					this.audio.brace()
				} else if (!f.warning) {
					this._warned = false
				}

				this.hud.setFight(f.tension, f.progress, f.danger, f.warning)
				this.hud.prompt(
					f.warning
						? "IT'S ABOUT TO GO — LET GO NOW"
						: f.running
							? "RIDE IT OUT"
							: "REEL IN THE LULL",
					f.warning || f.running ? "" : "HOLD",
				)

				if (this.hookedMesh) {
					// Just under the surface, closer as it comes in and tilting as it
					// fights, so the size of what you have on is readable.
					const m = this.hookedMesh
					m.visible = f.progress > 0.35
					m.position.set(
						this.rod.bobber.x,
						-0.28 - (1 - f.progress) * 0.5 + Math.sin(this.time * 6) * 0.04,
						this.rod.bobber.z - 0.4,
					)
					m.rotation.y = f.angle + Math.PI + Math.sin(this.time * 4) * 0.35
					m.rotation.z = Math.sin(this.time * 7) * 0.25
				}

				if (f.result === "landed") this._land()
				else if (f.result) this._lose(f.result)
				break
			}

			case "settle": {
				this._settleT -= dt
				this.hud.hidePrompt()
				if (this._settleT <= 0) {
					this.rod.reelIn()
					this.phase = "idle"
				}
				break
			}
		}

		// The reticle rings sit on the moving surface.
		if (this.aimTarget.visible) {
			this.aimTarget.position.set(
				this._target.x,
				0.05 + this.lake.heightAt(this._target.x, this._target.z),
				this._target.z,
			)
			this.aimLanding.position.set(
				this._landing.x,
				0.06 + this.lake.heightAt(this._landing.x, this._landing.z),
				this._landing.z,
			)
			const q = this.lake.spotAt(this._landing.x, this._landing.z).quality
			// The landing ring warms up over better water — a nudge, not a solution.
			this.aimLanding.material.color.setHSL(lerp(0.1, 0.42, q), 0.7, 0.62)
		}
	}

	_updateCamera(dt) {
		// Fixed on the dock with a slow drift, leaning a little towards whatever
		// is happening. A calm game does not want a camera with opinions.
		const target =
			this.phase === "fight" && this.fight
				? this._camAim
				: this.phase === "idle" || this.phase === "charge"
					? this._landing
					: this.rod.bobber

		const t = this.time
		this.camera.position.x = damp(this.camera.position.x, 0.3 + Math.sin(t * 0.21) * 0.12, 0.02, dt)
		this.camera.position.y = damp(this.camera.position.y, 2.35 + Math.sin(t * 0.31) * 0.05, 0.02, dt)
		this.camera.position.z = damp(this.camera.position.z, -1.0, 0.02, dt)

		this._v.set(
			clamp(target.x * 0.35, -7, 7),
			0.35 + Math.sin(t * 0.25) * 0.05,
			clamp(target.z * 0.55, -22, -6),
		)
		this._lookAt = this._lookAt || new THREE.Vector3(0, 0.35, -14)
		this._lookAt.lerp(this._v, 1 - Math.pow(0.0025, dt))
		this.camera.lookAt(this._lookAt)
	}

	// ------------------------------------------------------------ loop

	_loop() {
		requestAnimationFrame(this._loop)
		const dt = Math.min(this.clock.getDelta(), 0.05)
		this.time += dt

		if (this.state === "playing") {
			this.timeLeft -= dt
			this.hud.setClock(this.timeLeft)
			this._updateFishing(dt)
			this.hud.setScore(this.score, dt)
			// Music lifts a little as the clock runs down.
			this.audio.setIntensity(1 - this.timeLeft / RUN_SECONDS)
			if (this.timeLeft <= 0) this.runOver()
		} else {
			// Menus still show a living lake behind them.
			this._aim()
		}

		this.lake.update(dt)
		this.fx.update(dt)
		// The fight branch updates the rod itself, with the fish's pull.
		if (this.phase !== "fight") {
			this.rod.update(dt, { tension: this.rod.charge * 0.3, reeling: false })
		}
		this._updateCamera(dt)

		this.composer.render()
		this.quality.sample()
		if (this._perfT === undefined || this.time - this._perfT > 0.4) {
			this._perfT = this.time
			const fps = $("perf-fps")
			if (fps) fps.textContent = String(this.quality.fps)
			const tier = $("perf-tier")
			if (tier) tier.textContent = this.quality.preset.label
		}
		this.pointer.endFrame()
	}
}

// Same intentional debug surface as the shooter: a kid poking at devtools is a
// feature of this codebase, not a leak.
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
				? `<div class="t-inner"><h2>NO WEBGL2</h2><p class="t-sub">This lake needs WebGL2. Try a different browser, or turn on hardware acceleration.</p></div>`
				: `<div class="t-inner"><h2>IT BROKE</h2><p class="t-sub">${String(err && err.message ? err.message : err).replace(/[<>&]/g, "")}</p></div>`
		}
	}
})
