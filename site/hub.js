// The hub's weekly prize board.
//
// One request to /joint gives us both the joint standings and each game's
// places, so this stays a single fetch and degrades to a plain message if the
// worker isn't reachable. Nothing here blocks the game links.

import { LEADERBOARD_URL } from "./shared/config.js"

const GAME_ORDER = ["nova", "fish", "city"]

const $ = (id) => document.getElementById(id)

const esc = (s) => String(s).replace(/[<>&]/g, "")
const shout = (s) => esc(s).toUpperCase()

/** "Monday July 27" — the week label a kid can match against a calendar. */
function weekLabel(week) {
	const [y, m, d] = week.split("-").map(Number)
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "UTC",
		weekday: "long",
		month: "long",
		day: "numeric",
	}).format(new Date(Date.UTC(y, m - 1, d)))
}

function renderJoint(standings) {
	const el = $("joint")
	if (!standings.length) {
		el.innerHTML =
			`<div class="board-title">JOINT BOARD</div>` +
			`<div class="board-empty">NOBODY HAS PLAYED YET THIS WEEK</div>`
		return
	}
	const rows = standings
		.map((p, i) => {
			const from = GAME_ORDER.filter((g) => p.perGame && p.perGame[g])
				.map((g) => `${g} ${p.perGame[g].points}`)
				.join(" · ")
			return (
				`<div class="board-row top-${i + 1}">` +
				`<span class="rk">${i + 1}</span>` +
				`<span class="nm">${shout(p.player)}${p.visitor ? ` <span class="vis">VISITOR</span>` : ""}</span>` +
				`<span class="pts">${p.total}</span>` +
				(from ? `<span class="from">${esc(from)}</span>` : "") +
				`</div>`
			)
		})
		.join("")
	el.innerHTML = `<div class="board-title">JOINT BOARD · PRIZE POINTS</div>${rows}`
}

function renderPerGame(perGame) {
	$("per-game").innerHTML = GAME_ORDER.map((id) => {
		const info = perGame[id]
		if (!info) return ""
		const title = `<div class="board-title">${shout(info.label || id)}</div>`
		if (!info.places || !info.places.length) {
			return `<div class="board">${title}<div class="board-empty">NO RUNS YET</div></div>`
		}
		const rows = info.places
			.map(
				(p) =>
					`<div class="board-row top-${p.place}">` +
					`<span class="rk">${p.place}</span>` +
					`<span class="nm">${shout(p.player)}${p.visitor ? ` <span class="vis">VISITOR</span>` : ""}</span>` +
					`<span class="wv">+${p.points}</span>` +
					`<span class="sc">${Number(p.score).toLocaleString()}</span>` +
					`</div>`,
			)
			.join("")
		return `<div class="board">${title}${rows}</div>`
	}).join("")
}

async function load() {
	// Unbuilt games are plain <div class="card soon"> in the markup, not anchors,
	// so there is nothing to disable here — a card becomes clickable only by
	// being made an <a> when its game ships.
	if (!LEADERBOARD_URL) {
		$("week-line").textContent = "scores are kept on each device for now"
		$("joint").innerHTML = ""
		return
	}

	try {
		const ctrl = new AbortController()
		const timer = setTimeout(() => ctrl.abort(), 6000)
		const res = await fetch(`${LEADERBOARD_URL.replace(/\/+$/, "")}/joint`, { signal: ctrl.signal })
		clearTimeout(timer)
		if (!res.ok) throw new Error(`HTTP ${res.status}`)
		const data = await res.json()

		$("week-line").textContent = data.closed
			? `week of ${weekLabel(data.week)} · closed`
			: `week of ${weekLabel(data.week)} · still running`
		renderJoint(data.standings || [])
		renderPerGame(data.perGame || {})
		$("board-state").textContent = data.closed
			? "THIS WEEK IS FINISHED"
			: "MONDAY TO SUNDAY · AMERICA/TORONTO"
	} catch {
		$("week-line").textContent = "can't reach the prize board right now"
		$("joint").innerHTML = `<div class="board-empty">TRY AGAIN IN A MOMENT — THE GAMES STILL WORK</div>`
	}
}

load()
