// areas3d.js — an EXPERIMENTAL 3D walk-through of one area, for the Areas page.
//
// Every cooler of the area becomes a row of pallet racking, rows side by side
// with a walkway between them, built from the same layout the flat rack view
// draws (areas.html buildLayout()). Swarmbox has no floor plan, so where a row
// stands is invented — rows go in code order, 1-A next to 1-B — and only the
// racking inside each row comes from the bin codes.
//
// three.js is loaded from a CDN (the importmap in areas.html), so this view
// needs internet access; the page says so if the import fails. Everything that
// repeats — pallets, uprights, beams — is one InstancedMesh each, so JF's 1,700
// bins are a handful of draw calls rather than thousands.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Sizes in metres, roughly a real pallet rack: a 1.2m pallet slot, a level
// every 1.7m, rows 7m apart (rack, walkway, rack).
const SPOT_W = 1.3;
const LEVEL_H = 1.7;
const DEPTH = 1.3;
const ROW_GAP = 7;
const PALLET = { w: SPOT_W * 0.82, h: 1.15, d: DEPTH * 0.86 };
const BASE_H = 0.14; // the wooden pallet under the load
const BG = '#0f172a';

let S = null;

const levelIndex = (L) => L.charCodeAt(0) - 65;

export function build(el, { layout, onPick }) {
  dispose();
  const width = el.clientWidth || 800;
  const height = Math.round(Math.max(380, Math.min(window.innerHeight * 0.68, 620)));

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.touchAction = 'none';
  el.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.Fog(BG, 45, 160);
  const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 600);

  scene.add(new THREE.HemisphereLight('#e2e8f0', '#1e293b', 1.15));
  const sun = new THREE.DirectionalLight('#ffffff', 1.1);
  sun.position.set(30, 60, 20);
  scene.add(sun);

  // ── Lay the rows out ───────────────────────────────────────────────────────
  const rows = [];      // { name, z, x0, x1, top }
  const pallets = [];   // { x, y, z, l }
  const uprights = [];  // { x, z, h }
  const beams = [];     // { x, y, z, w }
  layout.aisles.forEach((a, r) => {
    const z = r * ROW_GAP;
    const levels = levelIndex(a.top) + 1;
    const rackH = levels * LEVEL_H + 0.25;
    let x = 0;
    for (const b of a.bayList) {
      const start = Math.min(1, b.lo);
      const w = (b.hi - start + 1) * SPOT_W;
      for (const zz of [z - DEPTH / 2, z + DEPTH / 2]) {
        uprights.push({ x, z: zz, h: rackH });
        // Level A stands on the floor; every level above it sits on a beam.
        for (let L = 1; L < levels; L++) beams.push({ x: x + w / 2, y: L * LEVEL_H, z: zz, w });
      }
      for (const [key, l] of b.at) {
        const L = levelIndex(key[0]);
        const s = Number(key.slice(1));
        pallets.push({ x: x + (s - start + 0.5) * SPOT_W, y: L * LEVEL_H + (L ? 0.1 : 0), z, l });
      }
      x += w;
    }
    for (const zz of [z - DEPTH / 2, z + DEPTH / 2]) uprights.push({ x, z: zz, h: rackH });
    rows.push({ name: a.name, z, x0: 0, x1: x, top: rackH });
  });
  const longest = Math.max(10, ...rows.map((r) => r.x1));
  const depth = Math.max(ROW_GAP, rows.length * ROW_GAP);

  // ── The floor, with a yellow safety line down every walkway ───────────────
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(longest + 30, depth + 30),
    new THREE.MeshStandardMaterial({ color: '#1e293b', roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(longest / 2, 0, depth / 2 - ROW_GAP / 2);
  scene.add(floor);
  const lineMat = new THREE.MeshBasicMaterial({ color: '#facc15' });
  for (let r = 0; r < rows.length; r++) {
    for (const off of [DEPTH / 2 + 0.6, ROW_GAP - DEPTH / 2 - 0.6]) {
      if (r === rows.length - 1 && off > ROW_GAP / 2) continue;
      const line = new THREE.Mesh(new THREE.PlaneGeometry(rows[r].x1 + 2, 0.1), lineMat);
      line.rotation.x = -Math.PI / 2;
      line.position.set(rows[r].x1 / 2, 0.01, rows[r].z + off);
      scene.add(line);
    }
  }

  // ── Steel, beams and pallets, one instanced mesh each ─────────────────────
  const m = new THREE.Matrix4();
  const steel = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 1, 0.1),
    new THREE.MeshStandardMaterial({ color: '#64748b', metalness: 0.4, roughness: 0.5 }), uprights.length);
  uprights.forEach((u, i) => {
    m.makeScale(1, u.h, 1).setPosition(u.x, u.h / 2, u.z);
    steel.setMatrixAt(i, m);
  });
  scene.add(steel);

  const beamMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.12, 0.08),
    new THREE.MeshStandardMaterial({ color: '#2563eb', metalness: 0.3, roughness: 0.5 }), Math.max(1, beams.length));
  beams.forEach((b, i) => {
    m.makeScale(b.w, 1, 1).setPosition(b.x, b.y, b.z);
    beamMesh.setMatrixAt(i, m);
  });
  beamMesh.count = beams.length;
  scene.add(beamMesh);

  const n = Math.max(1, pallets.length);
  const wood = new THREE.InstancedMesh(new THREE.BoxGeometry(PALLET.w, BASE_H, PALLET.d),
    new THREE.MeshStandardMaterial({ color: '#8a5a2b', roughness: 0.9 }), n);
  const loads = new THREE.InstancedMesh(new THREE.BoxGeometry(PALLET.w, PALLET.h, PALLET.d),
    new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.65 }), n);
  pallets.forEach((p, i) => {
    m.makeTranslation(p.x, p.y + BASE_H / 2, p.z);
    wood.setMatrixAt(i, m);
    m.makeTranslation(p.x, p.y + BASE_H + PALLET.h / 2, p.z);
    loads.setMatrixAt(i, m);
    loads.setColorAt(i, new THREE.Color('#94a3b8'));
  });
  wood.count = loads.count = pallets.length;
  scene.add(wood, loads);

  // ── A name over the end of every row ──────────────────────────────────────
  for (const r of rows) {
    const sprite = label(`Cooler ${r.name}`);
    sprite.position.set(-1.2, r.top + 0.9, r.z);
    scene.add(sprite);
  }

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI / 2 - 0.03; // never look up from under the floor
  controls.minDistance = 1.5;
  controls.maxDistance = 220;

  S = { el, renderer, scene, camera, controls, rows, pallets, loads, onPick, raf: 0, tween: null, keys: new Set() };
  focus(rows.length ? rows[0].name : null, true);

  // A tap picks a pallet; a drag only looks around.
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1), camera);
    const hit = ray.intersectObject(loads)[0];
    if (hit && hit.instanceId != null && S.onPick) S.onPick(S.pallets[hit.instanceId].l.code);
  });

  // W A S D walk: forward and back along the way you are looking, sideways
  // across it, staying at the same height — standing in the aisle, not flying.
  S.onKey = (e) => {
    if (e.target.closest && e.target.closest('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    if (!['w', 'a', 's', 'd'].includes(k)) return;
    if (e.type === 'keydown') S.keys.add(k); else S.keys.delete(k);
    e.preventDefault();
  };
  window.addEventListener('keydown', S.onKey);
  window.addEventListener('keyup', S.onKey);

  S.resize = new ResizeObserver(() => {
    const w = el.clientWidth;
    if (!w) return;
    renderer.setSize(w, height);
    camera.aspect = w / height;
    camera.updateProjectionMatrix();
  });
  S.resize.observe(el);

  let last = performance.now();
  const tick = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (S.tween) stepTween(now);
    if (S.keys.size) walk(dt);
    controls.update();
    renderer.render(scene, camera);
    S.raf = requestAnimationFrame(tick);
  };
  S.raf = requestAnimationFrame(tick);
}

function walk(dt) {
  const { camera, controls, keys } = S;
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  fwd.y = 0;
  fwd.normalize();
  const side = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
  const step = new THREE.Vector3();
  if (keys.has('w')) step.add(fwd);
  if (keys.has('s')) step.sub(fwd);
  if (keys.has('d')) step.add(side);
  if (keys.has('a')) step.sub(side);
  if (!step.lengthSq()) return;
  step.normalize().multiplyScalar(5 * dt); // a brisk walk, 5 m/s
  camera.position.add(step);
  controls.target.add(step);
  S.tween = null;
}

function label(text) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(15,23,42,.85)';
  g.fillRect(0, 0, 512, 128);
  g.fillStyle = '#e2e8f0';
  g.font = 'bold 64px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 256, 66);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  sprite.scale.set(4.4, 1.1, 1);
  return sprite;
}

// Recolour without rebuilding: the colour mode, a search, or a picked pallet.
export function paint({ colourOf, matches, q, pick }) {
  if (!S) return;
  const bg = new THREE.Color(BG);
  const c = new THREE.Color();
  S.pallets.forEach((p, i) => {
    c.set(colourOf(p.l));
    if (p.l.code === pick) c.set('#ffffff');
    else if (q && !matches(p.l, q)) c.lerp(bg, 0.82);
    S.loads.setColorAt(i, c);
  });
  if (S.loads.instanceColor) S.loads.instanceColor.needsUpdate = true;
}

// Walk the camera to stand at the start of a cooler, looking down it.
export function focus(name, instant) {
  if (!S) return;
  const r = S.rows.find((x) => x.name === name);
  if (!r) return;
  const walkZ = r.z + ROW_GAP / 2;
  const to = { pos: new THREE.Vector3(-4, 2.6, walkZ + 1.5), target: new THREE.Vector3(Math.min(r.x1, 14), 1.6, r.z) };
  if (instant) {
    S.camera.position.copy(to.pos);
    S.controls.target.copy(to.target);
    return;
  }
  S.tween = { t0: performance.now(), from: { pos: S.camera.position.clone(), target: S.controls.target.clone() }, to };
}

// Walk to stand in the walkway in front of one pallet, looking at it — where a
// search sends you, so the match is in view rather than somewhere down the row.
export function look(code) {
  if (!S) return;
  const p = S.pallets.find((x) => x.l.code === code);
  if (!p) return;
  const eye = p.y + 1.6;
  const to = { pos: new THREE.Vector3(p.x - 2.5, Math.max(1.7, eye), p.z + ROW_GAP / 2 + 0.8),
    target: new THREE.Vector3(p.x, p.y + 0.7, p.z) };
  S.tween = { t0: performance.now(), from: { pos: S.camera.position.clone(), target: S.controls.target.clone() }, to };
}

function stepTween(now) {
  const t = Math.min(1, (now - S.tween.t0) / 700);
  const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
  S.camera.position.lerpVectors(S.tween.from.pos, S.tween.to.pos, e);
  S.controls.target.lerpVectors(S.tween.from.target, S.tween.to.target, e);
  if (t >= 1) S.tween = null;
}

export function dispose() {
  if (!S) return;
  cancelAnimationFrame(S.raf);
  window.removeEventListener('keydown', S.onKey);
  window.removeEventListener('keyup', S.onKey);
  if (S.resize) S.resize.disconnect();
  S.controls.dispose();
  S.scene.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
  });
  S.renderer.dispose();
  S.renderer.domElement.remove();
  S = null;
}

export const active = () => !!S;
