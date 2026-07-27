// Run with: node leaderboard/worker.test.mjs
import worker from "./worker.js"

// minimal in-memory stand-in for a KV namespace
const makeKV = () => {
	const m = new Map()
	return {
		m,
		async get(k, type) { const v = m.get(k); return v === undefined ? null : (type === "json" ? JSON.parse(v) : v) },
		async put(k, v) { m.set(k, v) },
	}
}
let env = { SCORES: makeKV() }
const call = (method, path, body, ip = "1.2.3.4") =>
	worker.fetch(new Request("https://x" + path, {
		method,
		headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip, Origin: "https://andriynectardesk.github.io" },
		body: body ? JSON.stringify(body) : undefined,
	}), env)

let pass = 0, fail = 0
const check = (name, cond, extra = "") => {
	if (cond) { pass++; console.log("  ok   " + name) }
	else { fail++; console.log("  FAIL " + name + " " + extra) }
}

// --- empty board
let r = await call("GET", "/top")
let d = await r.json()
check("empty board returns []", r.status === 200 && d.entries.length === 0)
check("CORS header present", r.headers.get("Access-Control-Allow-Origin") !== null)

// --- preflight
r = await call("OPTIONS", "/score")
check("OPTIONS preflight 204", r.status === 204)

// --- valid submissions
await call("POST", "/score", { name: "Danylo", score: 12000, wave: 6, kills: 40, combo: 5 })
await call("POST", "/score", { name: "Sasha", score: 30000, wave: 9, kills: 90, combo: 7 }, "5.5.5.5")
await call("POST", "/score", { name: "Max", score: 500, wave: 1, kills: 3, combo: 1 }, "6.6.6.6")
d = await (await call("GET", "/top")).json()
check("three entries stored", d.entries.length === 3, JSON.stringify(d.entries.map(e => e.name)))
check("sorted by score desc", d.entries[0].name === "Sasha" && d.entries[2].name === "Max")

// --- one row per name: lower score does not replace
r = await call("POST", "/score", { name: "Sasha", score: 10, wave: 1, kills: 1, combo: 1 }, "5.5.5.5")
d = await r.json()
check("lower score keeps old row", d.improved === false)
d = await (await call("GET", "/top")).json()
check("still 3 rows after re-submit", d.entries.length === 3)
check("Sasha kept 30000", d.entries.find(e => e.name === "Sasha").score === 30000)

// --- higher score replaces, no duplicate
r = await call("POST", "/score", { name: "Sasha", score: 45000, wave: 12, kills: 120, combo: 8 }, "5.5.5.5")
d = await r.json()
check("higher score improves", d.improved === true && d.rank === 1)
d = await (await call("GET", "/top")).json()
check("no duplicate name", d.entries.filter(e => e.name === "Sasha").length === 1)
check("still 3 rows", d.entries.length === 3)

// --- name case-insensitive dedupe
await call("POST", "/score", { name: "DANYLO", score: 20000, wave: 8, kills: 60, combo: 6 })
d = await (await call("GET", "/top")).json()
check("case-insensitive dedupe", d.entries.filter(e => e.name.toLowerCase() === "danylo").length === 1)

// --- validation
const bad = [
	["negative score", { name: "x", score: -5, wave: 1, kills: 0, combo: 1 }],
	["combo above game max", { name: "x", score: 100, wave: 1, kills: 1, combo: 99 }],
	["implausible score", { name: "x", score: 999999999, wave: 1, kills: 1, combo: 1 }],
	["NaN score", { name: "x", score: "abc", wave: 1, kills: 1, combo: 1 }],
	["wave zero", { name: "x", score: 10, wave: 0, kills: 1, combo: 1 }],
]
for (const [label, body] of bad) {
	const res = await call("POST", "/score", body, "9.9.9.9")
	check("rejects " + label, res.status === 400)
}

// --- name sanitising
await call("POST", "/score", { name: "<script>alert(1)</script>Bob", score: 999, wave: 2, kills: 5, combo: 2 }, "7.7.7.7")
d = await (await call("GET", "/top")).json()
const bob = d.entries.find(e => e.score === 999)
check("name stripped of markup", bob && !bob.name.includes("<") && !bob.name.includes(">"), bob?.name)
check("name length capped at 14", bob.name.length <= 14, bob?.name)

// --- rate limiting
env = { SCORES: makeKV() }
let limited = false
for (let i = 0; i < 20; i++) {
	const res = await call("POST", "/score", { name: "Spam" + i, score: 100 + i, wave: 2, kills: 1, combo: 1 }, "8.8.8.8")
	if (res.status === 429) { limited = true; break }
}
check("rate limits a flood from one IP", limited)

// --- missing binding
const res = await worker.fetch(new Request("https://x/top"), {})
check("clear error when KV unbound", res.status === 500)

// --- unknown route
check("404 on unknown path", (await call("GET", "/nope")).status === 404)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
