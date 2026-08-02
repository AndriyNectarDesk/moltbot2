// The "who's playing" strip on the game-over screen.
//
// Shared by all three games, unlike `quality.js` and friends, for a reason worth
// stating: identity is one thing across the arcade — you say who you are once
// and all three games know — so three copies of this would be three chances for
// the answer to differ. The score client it drives is already shared.
//
// It owns the buttons, the signup form and the PIN field. The game owns the
// submit button, and hears about changes through `onChange`.
//
// The strip is rendered from JS rather than markup because it is no longer a
// fixed list: the three kids, plus whichever friends have signed in on this
// device, plus the guest option, plus a way to sign up. Only the first and third
// of those are known ahead of time.

import { GUEST, ROSTER } from "./leaderboard.js"

const el = (tag, className, text) => {
	const node = document.createElement(tag)
	if (className) node.className = className
	if (text != null) node.textContent = text
	return node
}

/**
 * Keystrokes inside these inputs must not reach the game.
 *
 * Every game listens for keys on the window — WASD, space, arrows — so without
 * this, typing a name spins the car or fires the ship behind the menu, and a
 * space in "sofia b" is a jump. The PIN field in each game already did this; the
 * name field needs it more, because names are mostly letters.
 */
function trapKeys(input, onEnter) {
	input.addEventListener("keydown", (e) => {
		e.stopPropagation()
		if (e.key === "Enter") onEnter()
	})
	input.addEventListener("keyup", (e) => e.stopPropagation())
}

/**
 * @param {object} opts
 * @param {import("./leaderboard.js").Leaderboard} opts.board
 * @param {HTMLElement} opts.row       the .who-row container, emptied and rebuilt
 * @param {HTMLElement} opts.pinWrap   wrapper around the PIN field, hidden for guests
 * @param {HTMLInputElement} opts.pinInput
 * @param {() => void} [opts.onChange] called after the player changes
 */
export function bindIdentity({ board, row, pinWrap, pinInput, onChange = () => {} }) {
	// ---------------------------------------------------------------- signup
	const panel = el("div", "join-panel hidden")
	const nameInput = el("input", "name-input")
	nameInput.type = "text"
	nameInput.maxLength = 14
	nameInput.placeholder = "YOUR NAME"
	nameInput.autocomplete = "off"
	nameInput.spellcheck = false

	const joinPin = el("input", "pin-input")
	joinPin.type = "password"
	joinPin.inputMode = "numeric"
	joinPin.maxLength = 8
	joinPin.placeholder = "PIN"
	joinPin.autocomplete = "off"

	const joinBtn = el("button", "small", "JOIN")
	const joinMsg = el("div", "join-msg")
	const joinHint = el(
		"div",
		"join-hint",
		"Pick a name and a PIN you'll remember — you'll need both to play as you again.",
	)

	const fields = el("div", "join-fields")
	fields.append(nameInput, joinPin, joinBtn)
	panel.append(fields, joinHint)
	row.after(panel)
	// The message lives OUTSIDE the panel: a successful signup closes the panel,
	// and a confirmation that vanishes with the form it confirms is no
	// confirmation at all.
	panel.after(joinMsg)

	const say = (text, bad = false) => {
		joinMsg.textContent = text
		joinMsg.classList.toggle("warn", bad)
	}

	let busy = false
	async function doJoin() {
		if (busy) return
		busy = true
		joinBtn.disabled = true
		say("CHECKING…")

		const res = await board.join(nameInput.value, joinPin.value.trim())

		busy = false
		joinBtn.disabled = false
		if (!res.ok) {
			say(res.error.toUpperCase(), true)
			return
		}
		say(res.created ? `WELCOME, ${res.player.toUpperCase()}` : `PLAYING AS ${res.player.toUpperCase()}`)
		nameInput.value = ""
		joinPin.value = ""
		panel.classList.add("hidden")
		paint()
	}

	joinBtn.onclick = doJoin
	trapKeys(nameInput, () => joinPin.focus())
	trapKeys(joinPin, doJoin)

	// ---------------------------------------------------------------- strip
	function choose(who) {
		if (who !== board.name) board.forgetPin()
		board.setName(who === GUEST ? "" : who)
		panel.classList.add("hidden")
		say("")
		paint()
	}

	function chip(who, label, extra = "") {
		const btn = el("button", `who${extra ? ` ${extra}` : ""}`, label)
		btn.type = "button"
		btn.dataset.who = who
		btn.classList.toggle("on", who === (board.name || GUEST))
		btn.onclick = () => choose(who)
		return btn
	}

	function paint() {
		const known = board.knownPlayers()
		row.replaceChildren(
			...ROSTER.map((id) => chip(id, id.toUpperCase())),
			...known.map((id) => chip(id, id.toUpperCase())),
			chip(GUEST, "GUEST"),
		)

		// Signing up is an action, not a player, so it never carries the `on`
		// state — tapping it opens the form and leaves you as whoever you were.
		const add = el("button", "who add", "+ NEW PLAYER")
		add.type = "button"
		add.onclick = () => {
			const opening = panel.classList.contains("hidden")
			panel.classList.toggle("hidden", !opening)
			if (opening) {
				say("")
				nameInput.focus()
			}
		}
		row.append(add)

		pinWrap.classList.toggle("hidden", !board.hasIdentity)
		// The game's submit button reads this field, not `board.pin`, so leaving it
		// empty after a signup would tell a friend who just typed their PIN to
		// enter their PIN.
		pinInput.value = board.pin
		// Last, and unconditional: the game's submit button says either POST SCORE
		// or SAVE HERE depending on this, and every path that changes who is
		// playing goes through here. Calling it from each of them separately is how
		// one path ends up forgetting.
		onChange()
	}

	paint()

	return { paint, refresh: paint }
}
