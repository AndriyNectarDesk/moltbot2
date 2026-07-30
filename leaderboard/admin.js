// The prize dashboard: one page, server-rendered, no build step.
//
// It lives in the same worker as the game API for one decisive reason — the week
// key and the points maths exist in exactly one place. A dashboard that
// disagreed with the game about which week it is would produce a wrong payout.
//
// Auth is Basic + DASHBOARD_PASSWORD only, deliberately less than the usual
// in-app-users-plus-sessions setup. There is one admin here and there always
// will be, and at n=1 the browser's own credential prompt IS the session layer —
// no cookie code, no logout bugs. If a second read-only viewer is ever needed,
// add the user table then and keep Basic as the master key.

import { GAME_IDS, GAMES, POINTS } from "./games.js"

const esc = (s) =>
	String(s).replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	)

const money = (n) => `$${Number(n).toFixed(2)}`

const when = (ms) =>
	new Intl.DateTimeFormat("en-CA", {
		timeZone: "America/Toronto",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(new Date(ms))

function gameTable(gameId, info) {
	const rows = info.places
		.map(
			(p) => `
			<tr class="${p.place === 1 ? "win" : ""}">
				<td class="pl">${p.place}</td>
				<td class="who">${esc(p.player)}</td>
				<td class="sc">${p.score.toLocaleString("en-CA")}</td>
				<td class="st">${esc(GAMES[gameId].brag(p.stats || {}) || "")}</td>
				<td class="pt">${p.points}</td>
				<td class="fl">${(p.flags || []).map((f) => `<span class="flag">${esc(f)}</span>`).join(" ")}</td>
			</tr>`,
		)
		.join("")

	const note = info.qualifiers === 0
		? `<p class="note">nobody played this week</p>`
		: info.qualifiers < POINTS.minQualifiersForPlaces
			? `<p class="note">only ${info.qualifiers} player — participation point only, no place points awarded</p>`
			: ""

	return `
	<section>
		<h2>${esc(info.label)}</h2>
		${note}
		${
			rows
				? `<table>
			<thead><tr><th>#</th><th>player</th><th>score</th><th></th><th>pts</th><th>flags</th></tr></thead>
			<tbody>${rows}</tbody>
		</table>`
				: ""
		}
	</section>`
}

export function renderAdmin({ week, proposal, closed, closedAt, ended, payouts }) {
	const jointRows = proposal.joint
		.map(
			(p, i) => `
		<tr class="${i === 0 ? "win" : ""}">
			<td class="pl">${i + 1}</td>
			<td class="who">${esc(p.player)}</td>
			<td class="pt big">${p.total}</td>
			<td class="brk">${GAME_IDS.map((g) => (p.perGame[g] ? `${g} ${p.perGame[g].points}` : "")).filter(Boolean).join(" &middot; ")}</td>
		</tr>`,
		)
		.join("")

	const paid = payouts.length
		? `<ul class="paid">${payouts
				.map((p) => `<li>${esc(p.player)} — ${money(p.amount)}${p.reason ? ` <em>${esc(p.reason)}</em>` : ""} <span class="dim">${when(p.at)}</span></li>`)
				.join("")}</ul>`
		: `<p class="note">nothing paid for this week yet</p>`

	return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Prize board — ${esc(week)}</title>
<style>
	:root { color-scheme: dark; --line: #2a2440; --dim: #8a86a8; --hot: #ff7a1a; --cy: #31e6ff; }
	body { margin: 0; padding: 20px; background: #0a0814; color: #eee;
		font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; }
	.wrap { max-width: 860px; margin: 0 auto; }
	h1 { font-size: 19px; letter-spacing: 2px; margin: 0 0 2px; }
	h2 { font-size: 13px; letter-spacing: 3px; color: var(--cy); margin: 24px 0 8px; text-transform: uppercase; }
	.sub { color: var(--dim); font-size: 13px; margin: 0 0 18px; }
	table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
	th { text-align: left; font-size: 10px; letter-spacing: 2px; color: var(--dim);
		text-transform: uppercase; border-bottom: 1px solid var(--line); padding: 4px 6px; font-weight: 400; }
	td { padding: 6px; border-bottom: 1px solid var(--line); }
	tr.win .who, tr.win .pt { color: var(--hot); font-weight: 700; }
	.pl, .st { color: var(--dim); font-size: 12px; }
	.sc, .pt { text-align: right; }
	.big { font-size: 17px; font-weight: 700; }
	.brk { color: var(--dim); font-size: 12px; }
	.flag { display: inline-block; background: #48210c; color: #ffb347; border: 1px solid #7a3d12;
		border-radius: 3px; padding: 0 5px; font-size: 11px; }
	.note { color: var(--dim); font-size: 12px; font-style: italic; margin: 4px 0; }
	.dim { color: var(--dim); font-size: 12px; }
	.bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 22px 0 0;
		padding-top: 16px; border-top: 1px solid var(--line); }
	button { font: inherit; font-size: 13px; padding: 8px 16px; border-radius: 4px; cursor: pointer;
		border: 1px solid var(--line); background: #171233; color: #eee; }
	button.go { background: var(--hot); color: #150a02; border-color: transparent; font-weight: 700; }
	.state { padding: 8px 12px; border-radius: 4px; font-size: 13px; margin-bottom: 16px; }
	.open { background: #12203a; color: #9fd0ff; }
	.shut { background: #1d1330; color: #d3b6ff; }
	input { font: inherit; font-size: 13px; padding: 7px 9px; border-radius: 4px;
		border: 1px solid var(--line); background: #0f0c1e; color: #eee; }
	code { background: #171233; padding: 1px 5px; border-radius: 3px; font-size: 12px; }
	ul.paid { margin: 6px 0; padding-left: 18px; }
	.warn { color: #ffb347; font-size: 12px; }
</style>
</head><body><div class="wrap">

<h1>PRIZE BOARD</h1>
<p class="sub">week of ${esc(week)} &middot; Monday to Sunday, America/Toronto</p>

<div class="state ${closed ? "shut" : "open"}">
	${
		closed
			? `Closed ${esc(when(closedAt))}. Standings are frozen and public at <code>/week/${esc(week)}</code>. New scores for this week are rejected.`
			: ended
				? `This week has ended and is ready to close.`
				: `Still running. Scores can still change.`
	}
</div>

<h2>Joint board</h2>
${
	proposal.jointTied
		? `<p class="warn">Top two are level on points and on every tiebreak — split it by hand.</p>`
		: ""
}
${jointRows ? `<table><thead><tr><th>#</th><th>player</th><th>pts</th><th>from</th></tr></thead><tbody>${jointRows}</tbody></table>` : `<p class="note">no qualifying runs yet this week</p>`}

${GAME_IDS.map((id) => gameTable(id, proposal.perGame[id])).join("")}

<h2>Paid out</h2>
${paid}

<div class="bar">
	${
		closed
			? `<button onclick="close_(true)">Re-close (overwrites)</button>`
			: `<button class="go" onclick="close_(${ended ? "false" : "true"})">${ended ? "Close this week" : "Close early"}</button>`
	}
	<input id="p" placeholder="player" size="9" />
	<input id="a" placeholder="amount" size="6" />
	<input id="r" placeholder="reason" size="16" />
	<button onclick="pay()">Record payout</button>
	<a class="dim" href="/admin/history">history</a>
</div>
<p class="note">Closing freezes the week. Recording a payout only writes it down — you pay the cash.</p>

<script>
	const week = ${JSON.stringify(week)}
	async function close_(force) {
		if (!confirm("Freeze week " + week + "? Scores for it stop counting after this.")) return
		const r = await fetch("/admin/close?week=" + week + (force ? "&force=1" : ""), { method: "POST" })
		const d = await r.json()
		alert(r.ok ? "Closed. Winner: " + (d.proposal.jointWinner || "nobody") : "Failed: " + d.error)
		if (r.ok) location.reload()
	}
	async function pay() {
		const player = document.getElementById("p").value.trim()
		const amount = document.getElementById("a").value.trim()
		if (!player || !amount) return alert("player and amount required")
		const r = await fetch("/admin/payout", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ week, player, amount: Number(amount), reason: document.getElementById("r").value }),
		})
		const d = await r.json()
		alert(r.ok ? "Recorded." : "Failed: " + d.error)
		if (r.ok) location.reload()
	}
</script>
</div></body></html>`
}
