// The hub's weekly prize board, with history.
//
// One request to /joint gives both the joint standings and each game's places.
// The current week is whatever the SERVER says it is — the client never
// computes "this week", it only steps backwards from the answer, so there is
// no timezone maths here at all (see hub-weeks.js).
//
// Three fetch paths, deliberately isolated from each other:
//   - the current week (the original path): failure degrades to "can't reach
//     the prize board", games stay playable;
//   - paging to another week: failure says so in the week line and leaves the
//     last-rendered board standing — it must never blank a board that was
//     already on screen;
//   - the champion strip: failure of any kind just hides the strip.

import { LEADERBOARD_URL } from "./shared/config.js"
import { HISTORY_WEEKS, clampWeek, nextWeekKey, prevWeekKey } from "./hub-weeks.js"

const GAME_ORDER = ["nova", "fish", "city"]

const $ = (id) => document.getElementById(id)

const esc = (s) => String(s).replace(/[<>&]/g, "")
const shout = (s) => esc(s).toUpperCase()

const BASE = (LEADERBOARD_URL || "").replace(/\/+$/, "")

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

/** Fetch JSON with the house 6s timeout. Throws on non-OK with .status. */
async function getJson(path) {
	const ctrl = new AbortController()
	const timer = setTimeout(() => ctrl.abort(), 6000)
	try {
		const res = await fetch(`${BASE}${path}`, { signal: ctrl.signal })
		if (!res.ok) {
			const err = new Error(`HTTP ${res.status}`)
			err.status = res.status
			throw err
		}
		return await res.json()
	} finally {
		clearTimeout(timer)
	}
}

const badge = (p) => (p.visitor ? ` <span class="vis">VISITOR</span>` : "")

function renderJoint(standings, winner, isCurrent) {
	const el = $("joint")
	if (!standings.length) {
		el.innerHTML =
			`<div class="board-title">JOINT BOARD</div>` +
			`<div class="board-empty">${isCurrent ? "NOBODY HAS PLAYED YET THIS WEEK" : "NOBODY PLAYED THIS WEEK"}</div>`
		return
	}
	const rows = standings
		.map((p, i) => {
			const from = GAME_ORDER.filter((g) => p.perGame && p.perGame[g])
				.map((g) => `${g} ${p.perGame[g].points}`)
				.join(" · ")
			return (
				`<div class="board-row top-${i + 1}${winner && p.player === winner ? " won" : ""}">` +
				`<span class="rk">${i + 1}</span>` +
				`<span class="nm">${shout(p.player)}${badge(p)}</span>` +
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
					`<span class="nm">${shout(p.player)}${badge(p)}</span>` +
					`<span class="wv">+${p.points}</span>` +
					`<span class="sc">${Number(p.score).toLocaleString()}</span>` +
					`</div>`,
			)
			.join("")
		return `<div class="board">${title}${rows}</div>`
	}).join("")
}

// ------------------------------------------------------------------- state

let currentWeek = null // named by the server, never computed here
let cursor = null
let rendered = null // the week actually ON SCREEN, which is not always the cursor
let generation = 0 // a stale response from fast clicking must not render

function floorWeek() {
	let k = currentWeek
	for (let i = 0; i < HISTORY_WEEKS; i++) k = prevWeekKey(k)
	return k
}

function paintNav() {
	$("wk-older").disabled = cursor <= floorWeek()
	$("wk-newer").disabled = cursor >= currentWeek
	$("prize-title").textContent =
		cursor === currentWeek ? "THIS WEEK" : `WEEK OF ${weekLabel(cursor).toUpperCase()}`
}

/**
 * Render one week. `verdict` is the frozen snapshot's word on a closed week —
 * {jointWinner, jointTied} — and is the ONLY source the banner trusts for
 * "who won": re-deriving it client-side could disagree with the record a
 * payout was based on (scoring.js freezes the tie flag for exactly this).
 */
function renderWeek(data, verdict) {
	const isCurrent = cursor === currentWeek
	renderJoint(data.standings || [], verdict && !verdict.jointTied ? verdict.jointWinner : null, isCurrent)
	renderPerGame(data.perGame || {})

	if (isCurrent) {
		$("week-line").textContent = data.closed
			? `week of ${weekLabel(data.week)} · closed`
			: `week of ${weekLabel(data.week)} · still running`
		// Closing usually happens on the Sunday evening, so the current week can
		// already have a winner — saying only "FINISHED" would hide it for the
		// rest of the day the prize was actually decided.
		$("board-state").textContent = !data.closed
			? "MONDAY TO SUNDAY · AMERICA/TORONTO"
			: verdict
				? verdict.jointTied
					? "FINISHED — DEAD TIE, SPLIT BY HAND"
					: `FINISHED — WINNER: ${shout(verdict.jointWinner || "")}`
				: "THIS WEEK IS FINISHED"
	} else if (data.closed) {
		$("week-line").textContent = `week of ${weekLabel(data.week)}`
		$("board-state").textContent = verdict
			? verdict.jointTied
				? "CLOSED — DEAD TIE, SPLIT BY HAND"
				: `CLOSED — WINNER: ${shout(verdict.jointWinner || "")}`
			: "CLOSED"
	} else {
		$("week-line").textContent = `week of ${weekLabel(data.week)}`
		$("board-state").textContent = "WEEK NEVER CLOSED — STANDINGS AS THEY ENDED · NO OFFICIAL WINNER"
	}
}

/**
 * Show a week. A failed page-turn leaves the board that is already up — and
 * puts the heading and the URL BACK to that board's week, because a heading
 * naming one week over a board showing another is worse than the failure it
 * is reporting.
 */
async function showWeek(week) {
	cursor = week
	const gen = ++generation
	paintNav()
	setHash(week)
	try {
		const data = await getJson(`/joint?week=${week}`)
		let verdict = null
		if (data.closed) {
			// The snapshot carries jointWinner/jointTied; /joint's rows carry the
			// visitor badges. Two fetches, each doing the one thing only it can.
			try {
				verdict = await getJson(`/week/${week}`)
			} catch {
				verdict = null // banner says CLOSED without naming a winner
			}
		}
		if (gen !== generation) return // a newer click already rendered
		rendered = week
		renderWeek(data, verdict)
	} catch {
		if (gen !== generation) return
		if (rendered) {
			cursor = rendered
			paintNav()
			setHash(rendered)
		}
		$("week-line").textContent = "can't load that week right now — try again"
	}
}

/** Shareable: #2026-07-27 opens on that week. Cleared on the current week. */
function setHash(week) {
	history.replaceState(null, "", week === currentWeek ? location.pathname + location.search : `#${week}`)
}

/**
 * "LAST WEEK: MIKE · 23 PTS" under the heading. Additive only: any failure
 * hides the strip and touches nothing else.
 */
async function paintChampion() {
	const el = $("champion")
	try {
		const prev = prevWeekKey(currentWeek)
		let snap = null
		try {
			snap = await getJson(`/week/${prev}`)
		} catch (err) {
			// 404 just means the week was never closed; anything else, give up.
			if (err.status !== 404) {
				el.classList.add("hidden")
				return
			}
		}
		if (snap) {
			const top = snap.standings && snap.standings[0]
			if (snap.jointTied) {
				el.innerHTML = `LAST WEEK: <b>DEAD TIE</b> — SPLIT BY HAND`
			} else if (top) {
				// The snapshot carries no visitor field — it is frozen from the
				// standings, not the public projection — so the badge comes from
				// /joint, which recomputes it. ARCADE.md requires the mark on every
				// surface that names a winner on a payout week, and this strip is
				// the most prominent name on the front page.
				let marked = ""
				try {
					const pub = await getJson(`/joint?week=${prev}`)
					const row = (pub.standings || []).find((r) => r.player === (snap.jointWinner || top.player))
					marked = row ? badge(row) : ""
				} catch {
					marked = ""
				}
				el.innerHTML = `LAST WEEK'S CHAMPION: <b>${shout(snap.jointWinner || top.player)}</b>${marked} · ${top.total} PTS`
			}
			el.classList.toggle("hidden", !top && !snap.jointTied)
			return
		}
		const data = await getJson(`/joint?week=${prev}`)
		const lead = data.standings && data.standings[0]
		if (lead) {
			el.innerHTML = `LAST WEEK: UNDECIDED — <b>${shout(lead.player)}</b>${badge(lead)} LEADS · NOT CLOSED YET`
			el.classList.remove("hidden")
		} else {
			el.classList.add("hidden")
		}
	} catch {
		el.classList.add("hidden")
	}
}

// ------------------------------------------------------------------- boot

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
		const data = await getJson("/joint")
		currentWeek = data.week
		cursor = currentWeek

		$("wk-older").onclick = () => {
			if (cursor > floorWeek()) showWeek(prevWeekKey(cursor))
		}
		$("wk-newer").onclick = () => {
			if (cursor >= currentWeek) return
			const next = nextWeekKey(cursor)
			showWeek(next >= currentWeek ? currentWeek : next)
		}

		paintChampion()

		// Render the week we already have BEFORE paging anywhere. A shared link
		// whose fetch then fails leaves a real board on screen with an honest
		// message, instead of a heading over nothing — and it gives showWeek's
		// revert branch something to revert to.
		rendered = currentWeek
		renderWeek(data, null)
		paintNav()

		// A shared link like #2026-07-27 opens on that week, clamped and
		// validated; garbage silently means the current week.
		const asked = clampWeek(decodeURIComponent(location.hash.slice(1)), currentWeek)
		if (asked !== currentWeek) await showWeek(asked)
	} catch {
		$("week-line").textContent = "can't reach the prize board right now"
		$("joint").innerHTML = `<div class="board-empty">TRY AGAIN IN A MOMENT — THE GAMES STILL WORK</div>`
	}
}

load()
