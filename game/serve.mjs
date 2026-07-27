#!/usr/bin/env node
// Tiny zero-dependency static server for the game.
// The game is plain ES modules with three.js vendored under game/vendor, so it
// needs no bundler — it just has to be served over http:// (ES modules and
// importmaps don't work from file://).
//
//   node game/serve.mjs [port]

import { createServer } from "node:http"
import { readFile, stat } from "node:fs/promises"
import { extname, join, normalize, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)))
const PORT = Number(process.argv[2] || process.env.PORT || 5180)
const HOST = process.env.HOST || "127.0.0.1"

const TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
}

const server = createServer(async (req, res) => {
	try {
		const url = new URL(req.url, `http://${req.headers.host}`)
		let path = decodeURIComponent(url.pathname)
		if (path === "/") path = "/index.html"

		// keep every request inside the game directory
		const target = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ""))
		if (!target.startsWith(ROOT)) {
			res.writeHead(403).end("Forbidden")
			return
		}

		const info = await stat(target)
		if (info.isDirectory()) {
			res.writeHead(404).end("Not found")
			return
		}

		const body = await readFile(target)
		res.writeHead(200, {
			"Content-Type": TYPES[extname(target).toLowerCase()] || "application/octet-stream",
			"Content-Length": body.length,
			"Cache-Control": "no-cache",
		})
		res.end(body)
	} catch {
		res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found")
	}
})

server.listen(PORT, HOST, () => {
	console.log(`\n  DANYLO: NECTAR NOVA  →  http://${HOST}:${PORT}/\n`)
})
