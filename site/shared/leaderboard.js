// Score board client, shared by every game on the site.
//
// With LEADERBOARD_URL configured it talks to the worker in /leaderboard and
// everyone shares one weekly table per game. Without it — or whenever the
// network is down — it falls back to a table stored on this device, so the
// feature never breaks the game, it just gets smaller.
//
// Two things are namespaced on purpose. All three games are served from ONE
// origin, so a single set of storage keys would have them trampling each other:
// scores are per-game, while the player identity is shared (you say who you are
// once, for the whole arcade).

import { LEADERBOARD_URL } from "./config.js"

// shared across games
const NAME_KEY = "play.name"
const PIN_KEY = "play.pin"
// Names that have signed in on THIS device, so a friend who visits twice gets a
// button instead of the signup form. Never the source of truth about who exists
// — the worker is — just a convenience for a shared family laptop.
const KNOWN_KEY = "play.players"
// per game
const scoresKey = (game) => `play.scores.${game}`

// the keys the site used when Nova was the only game here
const LEGACY_NAME_KEY = "nectarnova.name"
const LEGACY_SCORES_KEY = "nectarnova.scores"

const MAX_LOCAL = 20
const TIMEOUT_MS = 6000

/**
 * The three kids. Their PINs live in a server secret, so these names always
 * exist and can never be claimed by anyone else — which is why they get fixed
 * buttons while everybody else has to type a name.
 *
 * This is no longer the list of who may post. Anyone can sign up from the
 * game-over screen and compete for the same prize; see `join`.
 */
export const ROSTER = ["danylo", "mike", "sofia"]

export const GUEST = "guest"

/** Matches the rules the worker enforces in leaderboard/players.js. */
export const NAME_MIN = 2
export const NAME_MAX = 14
export const RESERVED = ["guest", "anon", "admin", "player", "nobody", "you"]

/** localStorage throws in private mode and inside some embedded webviews. */
function readStore(key, fallback) {
	try {
		const raw = localStorage.getItem(key)
		return raw ? JSON.parse(raw) : fallback
	} catch {
		return fallback
	}
}

function writeStore(key, value) {
	try {
		localStorage.setItem(key, JSON.stringify(value))
		return true
	} catch {
		return false
	}
}

/**
 * Carry over the pre-arcade keys, once.
 *
 * Without this, the day the site gains two more games Danylo's saved name and
 * his personal best both reset to zero — which is exactly the signal that tells
 * a kid an update broke his game. Idempotent, and it never overwrites a newer
 * value. Cheap insurance; delete it in a month.
 */
function migrateLegacy(game) {
	try {
		if (localStorage.getItem(NAME_KEY) === null) {
			const old = localStorage.getItem(LEGACY_NAME_KEY)
			if (old !== null) {
				// Lowercase on the way in. v1 stored whatever was typed, so the one
				// kid who actually has legacy state has "Danylo" — which matches no
				// roster id, so he'd land on the game-over screen with nothing
				// selected, no PIN prompt and local-only saving. The shim exists to
				// protect exactly that player.
				let name = old
				try {
					const parsed = JSON.parse(old)
					if (typeof parsed === "string" && ROSTER.includes(parsed.toLowerCase())) {
						name = JSON.stringify(parsed.toLowerCase())
					}
				} catch {
					// not JSON; carry it over untouched and let them pick again
				}
				localStorage.setItem(NAME_KEY, name)
			}
		}
		if (game === "nova" && localStorage.getItem(scoresKey("nova")) === null) {
			const old = localStorage.getItem(LEGACY_SCORES_KEY)
			if (old !== null) localStorage.setItem(scoresKey("nova"), old)
		}
	} catch {
		// no storage, nothing to carry over
	}
}

/** Names go on a shared board, so keep them short and printable. */
export function cleanName(raw) {
	return String(raw ?? "")
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N} _\-.]/gu, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, NAME_MAX)
}

/**
 * The id a name becomes, or "" if it can't be one.
 *
 * A copy of the worker's rule, kept here so the signup form can say "too short"
 * while you type instead of after a round trip. The worker still decides — this
 * copy is allowed to be wrong, and the only cost of that is a nicer error
 * arriving a moment later.
 *
 * Lowercase because the board is keyed on this string, so ZOE and zoe have to be
 * one player. A letter is required because an all-digit name reads as a score.
 */
export function normalizeName(raw) {
	// Not text, not a name — String({}) would otherwise become "object object".
	if (typeof raw !== "string") return ""
	const name = cleanName(raw).toLowerCase().slice(0, NAME_MAX).trim()
	if (name.length < NAME_MIN) return ""
	if (!/\p{L}/u.test(name)) return ""
	return name
}

/** Why this PIN won't do, or null. Digits only — every phone keypad has those. */
export function pinProblem(pin) {
	return /^\d{4,8}$/.test(String(pin ?? "")) ? null : "PIN must be 4 to 8 digits"
}

export class Leaderboard {
	/**
	 * @param {string} game  the game id the worker knows this game by
	 */
	constructor(game, url = LEADERBOARD_URL) {
		this.game = game
		this.url = (url || "").replace(/\/+$/, "")
		this.lastError = null

		migrateLegacy(game)
		this.name = readStore(NAME_KEY, "") || ""
		this.pin = readStore(PIN_KEY, "") || ""
	}

	/**
	 * Names that have signed in on this device and aren't one of the kids.
	 *
	 * Rendered as extra buttons next to the three, so the friend who came last
	 * Saturday taps their name and types their PIN rather than signing up twice
	 * and finding the name already taken.
	 */
	knownPlayers() {
		const rows = readStore(KNOWN_KEY, [])
		if (!Array.isArray(rows)) return []
		return rows.filter((n) => typeof n === "string" && n && !ROSTER.includes(n))
	}

	_remember(name) {
		if (!name || ROSTER.includes(name)) return
		const rows = this.knownPlayers()
		if (rows.includes(name)) return
		rows.push(name)
		// Oldest first, newest last, and bounded — a shared laptop at a party
		// should not grow an unbounded row of buttons.
		writeStore(KNOWN_KEY, rows.slice(-8))
	}

	forgetPlayer(name) {
		writeStore(KNOWN_KEY, this.knownPlayers().filter((n) => n !== name))
	}

	/** Is a remote board configured at all? (Not "did the last call reach it".) */
	get shared() {
		return Boolean(this.url)
	}

	/** One of the three kids, whose PIN lives in the server secret. */
	get isRostered() {
		return ROSTER.includes(this.name)
	}

	/**
	 * Playing as somebody rather than as a guest.
	 *
	 * This is the gate the game-over screen asks about, and it used to be
	 * `isRostered` — which is why a friend could only ever save locally. Whether
	 * the name is genuinely registered is the worker's call, made when the score
	 * is posted; guessing here would only mean two places to be wrong.
	 */
	get hasIdentity() {
		return Boolean(this.name)
	}

	get canPost() {
		return this.shared && this.hasIdentity && Boolean(this.pin)
	}

	setName(name) {
		this.name = normalizeName(name)
		writeStore(NAME_KEY, this.name)
		return this.name
	}

	/** Remembered per device, so it's asked for once and then never again. */
	setPin(pin) {
		this.pin = String(pin || "").trim()
		writeStore(PIN_KEY, this.pin)
		return this.pin
	}

	forgetPin() {
		this.pin = ""
		writeStore(PIN_KEY, "")
	}

	// ------------------------------------------------------------ signing in

	/**
	 * Claim a name, or sign back in to one you already own.
	 *
	 * Deliberately one call for both. From the player's side there is no
	 * difference — you type your name and your PIN — and a friend on a new device
	 * would otherwise have to know which of two buttons applied to them.
	 *
	 * On success this device is that player until somebody taps another name.
	 * Failure changes nothing: the previous identity is left exactly as it was,
	 * so a mistyped PIN can't quietly turn a signed-in kid into a guest.
	 *
	 * Returns `{ ok, player, created, error }`.
	 */
	async join(name, pin) {
		const player = normalizeName(name)
		if (!player) {
			return { ok: false, error: `pick a name: ${NAME_MIN}–${NAME_MAX} characters, at least one letter` }
		}
		if (RESERVED.includes(player)) return { ok: false, error: "that name is reserved — pick another" }
		const badPin = pinProblem(pin)
		if (badPin) return { ok: false, error: badPin }

		if (!this.shared) {
			// No board configured at all: there is nothing to register with, but the
			// name is still worth keeping so the local table isn't full of "guest".
			this.setName(player)
			this.setPin(String(pin))
			this._remember(player)
			return { ok: true, player, created: false, shared: false }
		}

		let data
		try {
			data = await this._fetch("/join", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ player, pin: String(pin) }),
			})
			this.lastError = null
		} catch (err) {
			this.lastError = err.message || String(err)
			return {
				ok: false,
				status: err.status || 0,
				error: err.detail || err.message || "could not reach the board",
			}
		}

		this.setName(data.player || player)
		this.setPin(String(pin))
		this._remember(this.name)
		return { ok: true, player: this.name, created: Boolean(data.created), shared: true }
	}

	// ------------------------------------------------------------ local table
	localEntries() {
		const rows = readStore(scoresKey(this.game), [])
		return Array.isArray(rows) ? rows : []
	}

	_saveLocal(entry) {
		const rows = this.localEntries()
		rows.push(entry)
		rows.sort((a, b) => b.score - a.score)
		const kept = rows.slice(0, MAX_LOCAL)
		writeStore(scoresKey(this.game), kept)
		// Rank within what actually got kept, so a run that fell off the end
		// doesn't claim 21st place on a 20-row table.
		const rank = kept.findIndex((r) => r === entry) + 1
		return rank || null
	}

	personalBest() {
		const rows = this.localEntries()
		return rows.length ? rows[0].score : 0
	}

	/** Where a score already in the local table sits, for a retry that must not re-save. */
	_rankOf(score) {
		const i = this.localEntries().findIndex((r) => r.score === score)
		return i === -1 ? null : i + 1
	}

	// ------------------------------------------------------------ network
	async _fetch(path, options = {}) {
		// Never let a hanging request stall the UI.
		const ctrl = new AbortController()
		const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
		try {
			const res = await fetch(this.url + path, { ...options, signal: ctrl.signal })
			if (!res.ok) {
				// Carry the status and the server's own message. v1 threw a bare
				// "HTTP 403" here, so a rejected PIN was indistinguishable from the
				// network being down and the player was told the board was
				// unreachable — which sent them looking for the wrong problem.
				let detail = ""
				try {
					detail = (await res.json()).error || ""
				} catch {
					// non-JSON error body; the status is all we have
				}
				const err = new Error(detail || `HTTP ${res.status}`)
				err.status = res.status
				err.detail = detail
				throw err
			}
			return await res.json()
		} finally {
			clearTimeout(timer)
		}
	}

	/**
	 * Top scores for this week. Always resolves — a dead backend degrades to the
	 * local table rather than throwing into the render loop.
	 */
	async top(limit = 10) {
		if (this.shared) {
			try {
				const data = await this._fetch(`/g/${this.game}/top?limit=${limit}`)
				this.lastError = null
				return { entries: data.entries || [], shared: true, week: data.week }
			} catch (err) {
				this.lastError = err.message || String(err)
			}
		}
		return { entries: this.localEntries().slice(0, limit), shared: false }
	}

	/**
	 * Submit a run.
	 *
	 * Always saved locally first, so a run is never lost to a network blip. Then
	 * posted to the shared board if this device is signed in as a roster player.
	 *
	 * Returns `{ ok, shared, rank, points, entries, error, status }`. Unlike v1,
	 * `ok` actually means something: false when the shared board refused the
	 * submission, with `error` carrying the reason so the game can say "WRONG
	 * PIN" instead of blaming the network.
	 *
	 * Pass `skipLocal` when re-submitting a run that was already saved — a retry
	 * after a wrong PIN would otherwise append a second copy of the same run and
	 * fill the local table with duplicates of it.
	 */
	async submit({ score, stats = {}, durationMs, skipLocal = false }) {
		const entry = {
			player: this.name || GUEST,
			score: Math.max(0, Math.round(score)),
			stats,
			at: Date.now(),
		}
		const localRank = skipLocal ? this._rankOf(entry.score) : this._saveLocal({ ...entry })

		if (this.canPost) {
			try {
				const data = await this._fetch(`/g/${this.game}/score`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						player: this.name,
						pin: this.pin,
						score: entry.score,
						stats,
						...(Number.isFinite(durationMs) ? { durationMs: Math.round(durationMs) } : {}),
					}),
				})
				this.lastError = null
				return {
					ok: true,
					shared: true,
					rank: data.rank,
					points: data.points,
					week: data.week,
					improved: data.improved,
					entries: data.entries || [],
				}
			} catch (err) {
				this.lastError = err.message || String(err)
				return {
					ok: false,
					shared: false,
					status: err.status || 0,
					error: err.detail || err.message || "could not reach the board",
					rank: localRank,
					entries: this.localEntries(),
				}
			}
		}

		// Guest, or no PIN yet: a perfectly good local run, just not on the board.
		return { ok: true, shared: false, rank: localRank, entries: this.localEntries() }
	}
}
