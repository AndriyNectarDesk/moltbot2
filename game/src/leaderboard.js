// Score board with a pluggable backend.
//
// With LEADERBOARD_URL configured it talks to the worker in ../leaderboard and
// everyone shares one table. Without it — or whenever the network is down — it
// falls back to a table stored on this device, so the feature never breaks the
// game, it just gets smaller.

import { LEADERBOARD_URL } from "../config.js"

const NAME_KEY = "nectarnova.name"
const SCORES_KEY = "nectarnova.scores"
const MAX_LOCAL = 20
const TIMEOUT_MS = 6000

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

/** Names go on a shared board, so keep them short and printable. */
export function cleanName(raw) {
	return String(raw || "")
		.replace(/[^\p{L}\p{N} _\-.]/gu, "")
		.trim()
		.slice(0, 14)
}

export class Leaderboard {
	constructor(url = LEADERBOARD_URL) {
		this.url = (url || "").replace(/\/+$/, "")
		this.lastError = null
		this.name = readStore(NAME_KEY, "") || ""
	}

	get shared() {
		return Boolean(this.url)
	}

	setName(name) {
		this.name = cleanName(name)
		writeStore(NAME_KEY, this.name)
		return this.name
	}

	// ------------------------------------------------------------ local table
	localEntries() {
		const rows = readStore(SCORES_KEY, [])
		return Array.isArray(rows) ? rows : []
	}

	_saveLocal(entry) {
		const rows = this.localEntries()
		rows.push(entry)
		rows.sort((a, b) => b.score - a.score)
		writeStore(SCORES_KEY, rows.slice(0, MAX_LOCAL))
		return rows.findIndex((r) => r === entry) + 1
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
			if (!res.ok) throw new Error(`HTTP ${res.status}`)
			return await res.json()
		} finally {
			clearTimeout(timer)
		}
	}

	/**
	 * Top scores. Always resolves — a dead backend degrades to the local table
	 * rather than throwing into the render loop.
	 */
	async top(limit = 10) {
		if (this.shared) {
			try {
				const data = await this._fetch(`/top?limit=${limit}`)
				this.lastError = null
				return { entries: data.entries || [], shared: true }
			} catch (err) {
				this.lastError = err.message || String(err)
			}
		}
		return { entries: this.localEntries().slice(0, limit), shared: false }
	}

	/** Submit a run. Always stored locally; also pushed to the board if shared. */
	async submit({ score, wave, kills, combo }) {
		const entry = {
			name: this.name || "ANON",
			score: Math.max(0, Math.round(score)),
			wave: Math.max(1, Math.round(wave)),
			kills: Math.max(0, Math.round(kills)),
			combo: Math.max(1, Math.round(combo)),
			at: Date.now(),
		}
		const localRank = this._saveLocal({ ...entry })

		if (this.shared) {
			try {
				const data = await this._fetch("/score", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(entry),
				})
				this.lastError = null
				return { ok: true, shared: true, rank: data.rank, entries: data.entries || [] }
			} catch (err) {
				this.lastError = err.message || String(err)
			}
		}
		return { ok: true, shared: false, rank: localRank, entries: this.localEntries() }
	}
}
