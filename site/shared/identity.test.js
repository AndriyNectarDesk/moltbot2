// @vitest-environment happy-dom
//
// The name strip on the game-over screen.
//
// This module had no tests at all when it shipped, which is how it shipped with
// a latched submit button that silently lost the first run of the exact player
// it was written for — a friend who taps SAVE HERE and then signs up. The three
// games each wire it identically, so what is exercised here is what all three do.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { bindIdentity } from "./identity.js"
import { Leaderboard } from "./leaderboard.js"

function installStorage() {
	const store = new Map()
	globalThis.localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
		clear: () => store.clear(),
	}
	return store
}

/** The part of each game's game-over screen this module drives. */
function mountScreen() {
	document.body.innerHTML = `
		<div id="go-submit">
			<div class="who-row"></div>
			<div class="name-row">
				<span id="go-pin-wrap" class="hidden"><input id="go-pin" type="password" /></span>
				<button id="btn-submit" class="small">POST SCORE</button>
			</div>
			<div id="go-submit-msg"></div>
		</div>`
	return {
		row: document.querySelector(".who-row"),
		pinWrap: document.getElementById("go-pin-wrap"),
		pinInput: document.getElementById("go-pin"),
		submit: document.getElementById("btn-submit"),
		msg: document.getElementById("go-submit-msg"),
	}
}

/** What each game passes as onChange, verbatim. */
const gameOnChange = (board, dom, game) => () => {
	dom.msg.textContent = ""
	dom.msg.classList.remove("warn")
	dom.submit.textContent = board.hasIdentity ? "POST SCORE" : "SAVE HERE"
	game._submitted = false
	dom.submit.disabled = false
}

const chips = () => [...document.querySelectorAll(".who-row .who")].map((b) => b.textContent)
const chipNamed = (label) => [...document.querySelectorAll(".who-row .who")].find((b) => b.textContent === label)
const selected = () =>
	[...document.querySelectorAll(".who-row .who")].filter((b) => b.classList.contains("on")).map((b) => b.textContent)

const okJoin = (body) => vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body })

let dom
let board
let game

function bind() {
	dom = mountScreen()
	board = new Leaderboard("nova", "https://board.test")
	game = { _submitted: false }
	return bindIdentity({
		board,
		row: dom.row,
		pinWrap: dom.pinWrap,
		pinInput: dom.pinInput,
		onChange: gameOnChange(board, dom, game),
	})
}

beforeEach(() => {
	installStorage()
	vi.restoreAllMocks()
})

describe("the strip", () => {
	it("offers the three kids, a guest, and a way to sign up", () => {
		bind()
		expect(chips()).toEqual(["DANYLO", "MIKE", "SOFIA", "GUEST", "+ NEW PLAYER"])
		expect(selected()).toEqual(["GUEST"])
		expect(dom.submit.textContent).toBe("SAVE HERE")
		expect(dom.pinWrap.classList.contains("hidden")).toBe(true)
	})

	it("asks for a PIN once somebody is playing, and drops it when they change", () => {
		bind()
		chipNamed("DANYLO").click()
		expect(dom.pinWrap.classList.contains("hidden")).toBe(false)
		expect(dom.submit.textContent).toBe("POST SCORE")

		dom.pinInput.value = "1111"
		board.setPin("1111")
		chipNamed("MIKE").click()
		// Mike must not inherit the PIN Danylo just typed.
		expect(board.pin).toBe("")
		expect(dom.pinInput.value).toBe("")
	})

	it("does not treat signing up as a player you could be", () => {
		bind()
		chipNamed("DANYLO").click()
		chipNamed("+ NEW PLAYER").click()
		expect(selected()).toEqual(["DANYLO"])
		expect(board.name).toBe("danylo")
	})

	it("opens and closes the signup form", () => {
		bind()
		const panel = document.querySelector(".join-panel")
		expect(panel.classList.contains("hidden")).toBe(true)
		chipNamed("+ NEW PLAYER").click()
		expect(panel.classList.contains("hidden")).toBe(false)
		chipNamed("+ NEW PLAYER").click()
		expect(panel.classList.contains("hidden")).toBe(true)
	})
})

describe("signing up", () => {
	const fillAndJoin = async (name, pin) => {
		chipNamed("+ NEW PLAYER").click()
		document.querySelector(".name-input").value = name
		document.querySelector(".join-panel .pin-input").value = pin
		;[...document.querySelectorAll(".join-panel button")].find((b) => b.textContent === "JOIN").click()
		await vi.waitFor(() => expect(document.querySelector(".join-msg").textContent).not.toBe("CHECKING…"))
	}

	it("adds a button for the new name and selects it", async () => {
		globalThis.fetch = okJoin({ ok: true, player: "zoe", created: true })
		bind()
		await fillAndJoin("Zoe", "4242")

		expect(chips()).toEqual(["DANYLO", "MIKE", "SOFIA", "ZOE", "GUEST", "+ NEW PLAYER"])
		expect(selected()).toEqual(["ZOE"])
		expect(dom.submit.textContent).toBe("POST SCORE")
		expect(document.querySelector(".join-panel").classList.contains("hidden")).toBe(true)
	})

	// The submit handler reads the input, not board.pin, so an empty field here
	// tells a friend who just typed their PIN to enter their PIN.
	it("carries the PIN into the field the game actually reads", async () => {
		globalThis.fetch = okJoin({ ok: true, player: "zoe", created: true })
		bind()
		await fillAndJoin("zoe", "4242")
		expect(dom.pinInput.value).toBe("4242")
		expect(dom.pinWrap.classList.contains("hidden")).toBe(false)
	})

	// The confirmation used to live inside the panel, which the same code path
	// hides — a confirmation that vanishes with the form it confirms.
	it("says who you are now, somewhere still visible", async () => {
		globalThis.fetch = okJoin({ ok: true, player: "zoe", created: true })
		bind()
		await fillAndJoin("zoe", "4242")
		const msg = document.querySelector(".join-msg")
		expect(msg.textContent).toMatch(/ZOE/)
		expect(msg.closest(".join-panel")).toBeNull()
	})

	it("shows the server's reason and changes nothing when it fails", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 403,
			json: async () => ({ error: "that name is taken" }),
		})
		bind()
		chipNamed("DANYLO").click()
		await fillAndJoin("zoe", "4242")

		const msg = document.querySelector(".join-msg")
		expect(msg.textContent).toMatch(/TAKEN/)
		expect(msg.classList.contains("warn")).toBe(true)
		expect(board.name).toBe("danylo")
		expect(chips()).not.toContain("ZOE")
		// the form stays open, holding what was typed, so it can be corrected
		expect(document.querySelector(".join-panel").classList.contains("hidden")).toBe(false)
		expect(document.querySelector(".name-input").value).toBe("zoe")
	})

	it("refuses an impossible name without asking the server", async () => {
		globalThis.fetch = vi.fn()
		bind()
		await fillAndJoin("z", "4242")
		expect(globalThis.fetch).not.toHaveBeenCalled()
		expect(document.querySelector(".join-msg").classList.contains("warn")).toBe(true)
	})

	it("remembers a friend so their next visit is one tap and a PIN", async () => {
		globalThis.fetch = okJoin({ ok: true, player: "zoe", created: true })
		bind()
		await fillAndJoin("zoe", "4242")

		// A different game, opened later on the same device.
		bind()
		expect(chips()).toContain("ZOE")
		chipNamed("ZOE").click()
		expect(board.name).toBe("zoe")
		expect(dom.pinWrap.classList.contains("hidden")).toBe(false)
	})
})

describe("keystrokes stay out of the game", () => {
	// Every game listens for keys on the window — WASD, space, arrows. Without
	// this, typing a name drives the car behind the menu and a space in "sofia b"
	// is a jump.
	for (const field of [".name-input", ".join-panel .pin-input"]) {
		it(`does not leak from ${field}`, () => {
			bind()
			chipNamed("+ NEW PLAYER").click()
			const heard = []
			window.addEventListener("keydown", (e) => heard.push(e.key))
			window.addEventListener("keyup", (e) => heard.push(e.key))

			const input = document.querySelector(field)
			for (const type of ["keydown", "keyup"]) {
				input.dispatchEvent(new window.KeyboardEvent(type, { key: "w", bubbles: true }))
			}
			expect(heard).toEqual([])
		})
	}

	it("moves on to the PIN when you press Enter in the name", () => {
		bind()
		chipNamed("+ NEW PLAYER").click()
		const name = document.querySelector(".name-input")
		const pin = document.querySelector(".join-panel .pin-input")
		name.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
		expect(document.activeElement).toBe(pin)
	})
})

describe("the run in hand is never stranded", () => {
	/** What the games do on submit: guest saves locally, and latches the button. */
	const tapSubmit = () => {
		game._submitted = true
		dom.submit.disabled = true
		dom.submit.textContent = "SAVED"
	}

	// The exact first-run experience of the player this whole feature is for: they
	// tap the only button offered, then notice the signup, and the run they just
	// played can never reach the board — the button reads POST SCORE and is dead.
	it("re-arms the submit button when a guest signs up after saving", async () => {
		globalThis.fetch = okJoin({ ok: true, player: "zoe", created: true })
		bind()
		tapSubmit()

		chipNamed("+ NEW PLAYER").click()
		document.querySelector(".name-input").value = "zoe"
		document.querySelector(".join-panel .pin-input").value = "4242"
		;[...document.querySelectorAll(".join-panel button")].find((b) => b.textContent === "JOIN").click()
		await vi.waitFor(() => expect(chips()).toContain("ZOE"))

		expect(dom.submit.textContent).toBe("POST SCORE")
		expect(dom.submit.disabled).toBe(false)
		expect(game._submitted).toBe(false)
	})

	it("re-arms it when they pick a different name instead", () => {
		bind()
		tapSubmit()
		chipNamed("DANYLO").click()
		expect(dom.submit.disabled).toBe(false)
		expect(game._submitted).toBe(false)
	})

	// The two tests above drive `gameOnChange` in this file, which is a COPY of
	// what the games pass. That copy passing proves nothing about the games — so
	// check the three real ones say it too. Triplicated wiring is exactly where
	// one of three quietly gets left behind.
	it("is wired that way in all three games, not just in this file", async () => {
		const { readFile } = await import("node:fs/promises")
		for (const game of ["nova", "fish", "city"]) {
			// Resolved from the repo root, not import.meta.url — under a DOM
			// environment that is a http://localhost URL, not a file path.
			const src = await readFile(`site/${game}/src/main.js`, "utf8")
			const start = src.indexOf("bindIdentity({")
			expect(start, `${game} calls bindIdentity`).toBeGreaterThan(-1)
			const call = src.slice(start, src.indexOf("\n\t\t})", start))
			const onChange = call.slice(call.indexOf("onChange:"))
			expect(onChange, `${game} onChange`).not.toBe("")
			expect(onChange, `${game} onChange`).toMatch(/this\._submitted = false/)
			expect(onChange, `${game} onChange`).toMatch(/submitBtn\.disabled = false/)
			expect(onChange, `${game} onChange`).toMatch(/hasIdentity \? "POST SCORE" : "SAVE HERE"/)
		}
	})
})
