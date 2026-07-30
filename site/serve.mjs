#!/usr/bin/env node
// Tiny zero-dependency static server for the whole site.
// The games are plain ES modules with three.js vendored under site/vendor, so
// there's no bundler — they just have to be served over http:// (ES modules and
// importmaps don't work from file://).
//
//   node site/serve.mjs [port]
//
// Serves the hub at / and each game at /nova/, /fish/, /city/.

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
		const path = decodeURIComponent(url.pathname)

		// keep every request inside the site directory
		let target = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ""))
		if (!target.startsWith(ROOT)) {
			res.writeHead(403).end("Forbidden")
			return
		}

		let info = await stat(target)
		if (info.isDirectory()) {
			// GitHub Pages does both of these for us, so without them the site
			// works in production and 404s locally — a trap worth avoiding.
			// The redirect matters most: /nova without the slash would make the
			// document base /, and every ./relative import in the page would miss.
			if (!path.endsWith("/")) {
				res.writeHead(301, { Location: path + "/" }).end()
				return
			}
			target = join(target, "index.html")
			info = await stat(target)
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
	console.log(`\n  NECTAR ARCADE  →  http://${HOST}:${PORT}/\n`)
})
