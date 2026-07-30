// The car, as geometry. Split from car.js so the handling stays testable without
// a WebGL context — same split as the fishing game's fish/fishmesh.
//
// Primitives only. The three cars differ in silhouette as well as colour, because
// "the van" reading as a van is what makes choosing one feel like a choice.

import * as THREE from "three"
import { CARS } from "./car.js"

/** Rough silhouettes per car, in metres. */
const SHAPE = {
	scout: { len: 4.1, wide: 1.9, low: 0.62, cabin: 0.62, cabinAt: -0.1, nose: 0.5 },
	van: { len: 5.2, wide: 2.15, low: 0.8, cabin: 1.1, cabinAt: -0.5, nose: 0.3 },
	drifter: { len: 4.5, wide: 2.0, low: 0.48, cabin: 0.46, cabinAt: -0.25, nose: 0.7 },
}

export function buildCarMesh(id) {
	const spec = CARS[id] || CARS.scout
	const s = SHAPE[id] || SHAPE.scout
	const g = new THREE.Group()

	const bodyMat = new THREE.MeshStandardMaterial({
		color: spec.body,
		roughness: 0.34,
		metalness: 0.6,
		flatShading: true,
	})
	const trimMat = new THREE.MeshStandardMaterial({ color: spec.trim, roughness: 0.5 })
	const glassMat = new THREE.MeshStandardMaterial({
		color: 0x101828,
		roughness: 0.12,
		metalness: 0.85,
	})
	const tyreMat = new THREE.MeshStandardMaterial({ color: 0x14151b, roughness: 0.95 })
	const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff3d0 })
	const tailMat = new THREE.MeshBasicMaterial({ color: 0xff3a4a })

	// main body
	const body = new THREE.Mesh(new THREE.BoxGeometry(s.wide, s.low, s.len), bodyMat)
	body.castShadow = true
	g.add(body)

	// a sloped nose, so it has a front
	const nose = new THREE.Mesh(
		new THREE.BoxGeometry(s.wide * 0.94, s.low * 0.55, s.nose),
		bodyMat,
	)
	nose.position.set(0, -s.low * 0.16, -s.len / 2 - s.nose / 2 + 0.05)
	g.add(nose)

	// cabin
	const cabin = new THREE.Mesh(
		new THREE.BoxGeometry(s.wide * 0.82, s.cabin, s.len * 0.42),
		glassMat,
	)
	cabin.position.set(0, s.low / 2 + s.cabin / 2 - 0.04, s.cabinAt)
	cabin.castShadow = true
	g.add(cabin)

	// roof
	const roof = new THREE.Mesh(
		new THREE.BoxGeometry(s.wide * 0.78, 0.08, s.len * 0.36),
		bodyMat,
	)
	roof.position.set(0, s.low / 2 + s.cabin, s.cabinAt)
	g.add(roof)

	// a stripe down the middle, in the trim colour
	const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.03, s.len * 0.96), trimMat)
	stripe.position.y = s.low / 2 + 0.005
	g.add(stripe)

	// lights
	for (const side of [-1, 1]) {
		const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, 0.1), lampMat)
		head.position.set(side * s.wide * 0.3, -s.low * 0.05, -s.len / 2 - s.nose + 0.06)
		g.add(head)
		const tail = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.08), tailMat)
		tail.position.set(side * s.wide * 0.32, s.low * 0.1, s.len / 2 + 0.02)
		g.add(tail)
	}

	// wheels — the front pair steer, all four spin
	const wheelGeo = new THREE.CylinderGeometry(0.44, 0.44, 0.3, 12)
	wheelGeo.rotateZ(Math.PI / 2)
	const spin = []
	const steerWheels = []
	for (const fz of [-1, 1]) {
		for (const side of [-1, 1]) {
			// A holder that yaws (steering) containing a wheel that pitches (rolling),
			// so the two rotations don't fight each other.
			const holder = new THREE.Group()
			holder.position.set(side * (s.wide / 2 - 0.06), -s.low / 2 - 0.05, fz * s.len * 0.32)
			const wheel = new THREE.Mesh(wheelGeo, tyreMat)
			wheel.castShadow = true
			const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.32, 8), trimMat)
			hub.rotation.z = Math.PI / 2
			wheel.add(hub)
			holder.add(wheel)
			g.add(holder)
			spin.push(wheel)
			if (fz < 0) steerWheels.push(holder)
		}
	}

	g.userData.spin = spin
	g.userData.steerWheels = steerWheels
	return g
}
