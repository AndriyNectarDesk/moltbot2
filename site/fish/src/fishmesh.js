// The fish, as geometry. Split from fish.js so the rules in that file stay
// importable without a WebGL context — the fight maths is the part worth testing,
// and a test runner has no three.js.

import * as THREE from "three"
import { clamp, lerp } from "../../shared/util.js"
import { SPECIES } from "./fish.js"

/**
 * A fish out of primitives: tapered body, cone snout, tail and two fins.
 * Length scales with weight so a 12kg sturgeon is visibly a different animal
 * from a 200g sunfish.
 */
export function makeFishMesh(id, grams) {
	const s = SPECIES[id]
	const [lo, hi] = s.grams
	const t = clamp((grams - lo) / Math.max(1, hi - lo), 0, 1)
	// Rough length in metres, from a hand-wavy 18cm sunfish to a 1.5m sturgeon.
	const len = lerp(0.18, 1.5, clamp((Math.log(grams) - Math.log(90)) / (Math.log(17000) - Math.log(90)), 0, 1))
	const girth = len * lerp(0.2, 0.3, t)

	const g = new THREE.Group()
	const bodyMat = new THREE.MeshStandardMaterial({
		color: s.colour,
		roughness: 0.42,
		metalness: 0.28,
		flatShading: true,
	})
	const bellyMat = new THREE.MeshStandardMaterial({ color: s.belly, roughness: 0.5 })

	const body = new THREE.Mesh(new THREE.BoxGeometry(girth, girth * 1.25, len * 0.66), bodyMat)
	g.add(body)

	const belly = new THREE.Mesh(new THREE.BoxGeometry(girth * 0.8, girth * 0.4, len * 0.6), bellyMat)
	belly.position.y = -girth * 0.5
	g.add(belly)

	const snout = new THREE.Mesh(new THREE.ConeGeometry(girth * 0.5, len * 0.34, 5), bodyMat)
	snout.rotation.x = Math.PI / 2
	snout.position.z = len * 0.48
	g.add(snout)

	const tail = new THREE.Mesh(new THREE.ConeGeometry(girth * 0.72, len * 0.3, 4), bodyMat)
	tail.rotation.x = -Math.PI / 2
	tail.position.z = -len * 0.46
	g.add(tail)

	const finGeo = new THREE.PlaneGeometry(len * 0.24, girth * 0.9)
	for (const side of [-1, 1]) {
		const fin = new THREE.Mesh(finGeo, bodyMat)
		fin.position.set(side * girth * 0.5, -girth * 0.1, len * 0.05)
		fin.rotation.y = side * 0.5
		g.add(fin)
	}
	const dorsal = new THREE.Mesh(new THREE.PlaneGeometry(len * 0.3, girth * 0.7), bodyMat)
	dorsal.position.y = girth * 0.7
	g.add(dorsal)

	const eyeMat = new THREE.MeshStandardMaterial({ color: 0x14110c, roughness: 0.2 })
	for (const side of [-1, 1]) {
		const eye = new THREE.Mesh(new THREE.SphereGeometry(girth * 0.11, 6, 5), eyeMat)
		eye.position.set(side * girth * 0.42, girth * 0.28, len * 0.34)
		g.add(eye)
	}

	g.userData.len = len
	return g
}

