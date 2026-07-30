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
// per game
const scoresKey = (game) => `play.scores.${game}`

// the keys the site used when Nova was the only game here
const LEGACY_NAME_KEY = "nectarnova.name"
const LEGACY_SCORES_KEY = "nectarnova.scores"

const MAX_LOCAL = 20
const TIMEOUT_MS = 6000

/** Who may appear on the shared board. Anyone else plays as a guest. */
export const ROSTER = ["danylo", "mike", "sofia"]

export const GUEST = "guest"

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
			if (old !== null) localStorage.setItem(NAME_KEY, old)
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
	return String(raw || "")
		.replace(/[^\p{L}\p{N} _\-.]/gu, "")
		.trim()
		.slice(0, 14)
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

	/** Is a remote board configured at all? (Not "did the last call reach it".) */
	get shared() {
		return Boolean(this.url)
	}

	/** A roster player can post to the shared board; a guest is local-only. */
	get isRostered() {
		return ROSTER.includes(this.name)
	}

	get canPost() {
		return this.shared && this.isRostered && Boolean(this.pin)
	}

	setName(name) {
		const clean = ROSTER.includes(String(name).toLowerCase())
			? String(name).toLowerCase()
			: cleanName(name)
		this.name = clean
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
	 */
	async submit({ score, stats = {}, durationMs }) {
		const entry = {
			player: this.name || GUEST,
			score: Math.max(0, Math.round(score)),
			stats,
			at: Date.now(),
		}
		const localRank = this._saveLocal({ ...entry })

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
