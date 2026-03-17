/**
 * track.js - Catmull-Rom スプライン + リボンメッシュによるトラック生成
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';

const ROAD_WIDTH  = 27;
const TRACK_SCALE = 5.0;
const SAMPLE_SPACING = 12;

const RAW_POINTS = [
  // 左ストレート（上方向）
  { x: -80, z:   5 }, { x: -80, z:  55 }, { x: -80, z: 105 },
  // トップ ヘアピン（右折）
  { x: -60, z: 145 }, { x: -15, z: 170 }, { x:  35, z: 170 },
  { x:  75, z: 145 },
  // 右ストレート（下方向）
  { x:  90, z: 100 }, { x:  90, z:  50 }, { x:  90, z:   0 },
  // シケイン（S字・ループではない）
  { x: 105, z: -40 }, { x:  75, z: -70 }, { x: 105, z:-100 },
  // ボトム スイープ
  { x:  85, z:-135 }, { x:  45, z:-150 }, { x:   0, z:-140 },
  // リターン ダイアゴナル
  { x: -35, z:-115 }, { x: -60, z: -80 },
  // 左下カーブ（スタートへ復帰）
  { x: -85, z: -55 }, { x: -95, z: -25 },
];

// ========== Catmull-Rom 閉曲線 ==========
function catmullRom(pts, samplesPerSeg) {
  const n = pts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i];
    const p2 = pts[(i + 1) % n],     p3 = pts[(i + 2) % n];
    for (let s = 0; s < samplesPerSeg; s++) {
      const t = s / samplesPerSeg, t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * ((2*p1.x) + (-p0.x+p2.x)*t + (2*p0.x-5*p1.x+4*p2.x-p3.x)*t2 + (-p0.x+3*p1.x-3*p2.x+p3.x)*t3),
        z: 0.5 * ((2*p1.z) + (-p0.z+p2.z)*t + (2*p0.z-5*p1.z+4*p2.z-p3.z)*t2 + (-p0.z+3*p1.z-3*p2.z+p3.z)*t3),
      });
    }
  }
  return out;
}

// 均一アーク長でリサンプル
function resampleUniform(pts, spacing) {
  const n = pts.length;
  const segLens = [];
  let totalLen = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const l = Math.hypot(b.x - a.x, b.z - a.z);
    segLens.push(l);
    totalLen += l;
  }
  const count = Math.round(totalLen / spacing);
  const step = totalLen / count;
  const out = [];
  for (let i = 0; i < count; i++) {
    let target = i * step, walked = 0, si = 0;
    while (si < n - 1 && walked + segLens[si] < target) { walked += segLens[si]; si++; }
    const rem = target - walked;
    const t = segLens[si] > 0 ? rem / segLens[si] : 0;
    const a = pts[si], b = pts[(si + 1) % n];
    out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
  }
  return out;
}

// 各頂点のスムーズ法線（XZ平面の進行方向に対する左右）を計算
function computeNormals(pts) {
  const n = pts.length;
  return pts.map((_, i) => {
    const prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
    const tx = next.x - prev.x, tz = next.z - prev.z;
    const len = Math.hypot(tx, tz) || 1;
    return { nx: -tz / len, nz: tx / len, tx: tx / len, tz: tz / len };
  });
}

// リボンジオメトリ：中心線に沿った平らな帯
function buildRibbonGeo(pts, norms, halfW, y) {
  const n = pts.length;
  const pos = new Float32Array(n * 2 * 3);
  const idx = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i], nm = norms[i];
    const li = i * 6, ri = i * 6 + 3;
    pos[li]     = p.x + nm.nx * halfW;  pos[li + 1] = y; pos[li + 2] = p.z + nm.nz * halfW;
    pos[ri]     = p.x - nm.nx * halfW;  pos[ri + 1] = y; pos[ri + 2] = p.z - nm.nz * halfW;
    const ni = (i + 1) % n;
    const v0 = i * 2, v1 = v0 + 1, v2 = ni * 2, v3 = v2 + 1;
    idx.push(v0, v2, v1, v1, v2, v3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// ========== TrackBuilder ==========
export class TrackBuilder {
  constructor(scene, world, trackMaterial) {
    this.scene = scene;
    this.world = world;
    this.trackMaterial = trackMaterial || null;
    this.waypoints = [];
    this.spawnPoints = [];
    this.spawnHeading = 0;
    this.checkpointManager = new CheckpointManager();
    this.pickupManager = new PickupManager(scene);
  }

  build() {
    const scaled = RAW_POINTS.map(p => ({ x: p.x * TRACK_SCALE, z: p.z * TRACK_SCALE }));
    const dense  = catmullRom(scaled, 10);
    this._cl = resampleUniform(dense, SAMPLE_SPACING);
    this._norms = computeNormals(this._cl);

    this._buildGround();
    this._buildSky();
    this._buildRoad();
    this._buildGuardrails();
    this._buildStartFinishLine();
    this._setupSpawnPoints();
    this._buildEnvironment();
  }

  getWaypoints()  { return this.waypoints; }
  getSpawnPoints(){ return this.spawnPoints; }

  // ===== 地面 =====
  _buildGround() {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(6000, 6000),
      new THREE.MeshLambertMaterial({ color: 0x0a1a0a })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.receiveShadow = true;
    this.scene.add(mesh);

    const body = new CANNON.Body({ mass: 0, material: this.trackMaterial });
    body.addShape(new CANNON.Plane());
    body.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    body.collisionFilterGroup = 1;
    body.collisionFilterMask  = 2;
    this.world.addBody(body);
  }

  // ===== 背景の丘 =====
  _buildSky() {
    const mat = new THREE.MeshLambertMaterial({ color: 0x0a2a0a });
    [{ x:1200,z:0 },{ x:-1200,z:0 },{ x:0,z:1200 },{ x:0,z:-1200 },
     { x:900,z:900 },{ x:-900,z:900 },{ x:900,z:-900 },{ x:-900,z:-900 }]
    .forEach(p => {
      const r = 120 + Math.random() * 100;
      const h = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), mat);
      h.position.set(p.x, -r * 0.7, p.z);
      this.scene.add(h);
    });
  }

  // ===== 道路（リボンメッシュ） =====
  _buildRoad() {
    const cl = this._cl, norms = this._norms;

    // 路面本体（地面より僅かに上げてZ-fighting回避）
    const roadGeo = buildRibbonGeo(cl, norms, ROAD_WIDTH / 2, 0.04);
    const road = new THREE.Mesh(roadGeo, new THREE.MeshLambertMaterial({ color: 0x1a1a2e, side: THREE.DoubleSide }));
    road.receiveShadow = true;
    this.scene.add(road);

    // 中央線
    const lineGeo = buildRibbonGeo(cl, norms, 0.15, 0.06);
    this.scene.add(new THREE.Mesh(lineGeo, new THREE.MeshLambertMaterial({ color: 0x00aaff, side: THREE.DoubleSide })));

    // レーンマーカー（左右）
    const laneOffset = ROAD_WIDTH / 3;
    for (const sign of [-1, 1]) {
      const lanePts = cl.map((p, i) => ({
        x: p.x + norms[i].nx * sign * laneOffset,
        z: p.z + norms[i].nz * sign * laneOffset,
      }));
      const laneNorms = computeNormals(lanePts);
      const laneGeo = buildRibbonGeo(lanePts, laneNorms, 0.06, 0.06);
      this.scene.add(new THREE.Mesh(laneGeo, new THREE.MeshLambertMaterial({ color: 0x005588, side: THREE.DoubleSide })));
    }

    // 縁石（左=赤、右=シアン）
    const kerbW = 0.8;
    for (const side of [-1, 1]) {
      const off = ROAD_WIDTH / 2 + kerbW / 2;
      const kerbPts = cl.map((p, i) => ({
        x: p.x + norms[i].nx * side * off,
        z: p.z + norms[i].nz * side * off,
      }));
      const kerbNorms = computeNormals(kerbPts);
      const kerbGeo = buildRibbonGeo(kerbPts, kerbNorms, kerbW / 2, 0.04);
      const mat = new THREE.MeshLambertMaterial({ color: side === -1 ? 0xff2200 : 0x00eeff, side: THREE.DoubleSide });
      this.scene.add(new THREE.Mesh(kerbGeo, mat));
    }

    // ウェイポイント＆チェックポイント登録
    const wpStep = Math.max(1, Math.floor(cl.length / 80));
    for (let i = 0; i < cl.length; i++) {
      if (i % wpStep === 0) {
        this.waypoints.push(new THREE.Vector3(cl[i].x, 0.5, cl[i].z));
      }
      const nm = norms[i];
      const rad = Math.atan2(nm.tx, nm.tz);
      const next = cl[(i + 1) % cl.length];
      const segLen = Math.hypot(next.x - cl[i].x, next.z - cl[i].z);
      this.checkpointManager.addCheckpoint({ x: cl[i].x, z: cl[i].z, rad, length: segLen, width: ROAD_WIDTH });
    }
  }

  // ===== ガードレール（壁メッシュ＋物理ボックス） =====
  _buildGuardrails() {
    const GH = 1.8, GW = 0.5;
    const cl = this._cl, norms = this._norms;

    for (const side of [-1, 1]) {
      const railOff = ROAD_WIDTH / 2 + 0.8 + GW / 2;
      const railPts = cl.map((p, i) => ({
        x: p.x + norms[i].nx * side * railOff,
        z: p.z + norms[i].nz * side * railOff,
      }));

      // 壁面メッシュ：縦のリボン（上面＋外側面）
      const n = railPts.length;
      const wallPos = [];
      const wallIdx = [];
      for (let i = 0; i < n; i++) {
        const p = railPts[i];
        wallPos.push(p.x, 0.03, p.z);
        wallPos.push(p.x, GH,   p.z);
        const ni = (i + 1) % n;
        const v = i * 2;
        wallIdx.push(v, v + 1, ni * 2);
        wallIdx.push(v + 1, ni * 2 + 1, ni * 2);
      }
      const wallGeo = new THREE.BufferGeometry();
      wallGeo.setAttribute('position', new THREE.Float32BufferAttribute(wallPos, 3));
      wallGeo.setIndex(wallIdx);
      wallGeo.computeVertexNormals();
      const wallMat = new THREE.MeshLambertMaterial({ color: 0x223344, side: THREE.DoubleSide });
      this.scene.add(new THREE.Mesh(wallGeo, wallMat));

      // ネオンストライプ（上端）
      const railNorms = computeNormals(railPts);
      const neonGeo = buildRibbonGeo(railPts, railNorms, GW / 2 + 0.05, GH + 0.03);
      const neonMat = new THREE.MeshBasicMaterial({ color: side === -1 ? 0xff2200 : 0x00eeff, side: THREE.DoubleSide });
      this.scene.add(new THREE.Mesh(neonGeo, neonMat));

      // 物理コリジョン（厚いボックスを高密度配置して壁抜け防止）
      const PHYS_W = 5.0;
      const colStep = Math.max(1, Math.floor(n / 400));
      for (let i = 0; i < n; i += colStep) {
        const a = railPts[i], b = railPts[(i + colStep) % n];
        const dx = b.x - a.x, dz = b.z - a.z;
        const segLen = Math.hypot(dx, dz);
        if (segLen < 0.3) continue;
        const rad = Math.atan2(dx, dz);
        const cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2;
        const body = new CANNON.Body({ mass: 0, material: this.trackMaterial });
        body.addShape(new CANNON.Box(new CANNON.Vec3(PHYS_W / 2, GH / 2, segLen / 2 + 0.5)));
        body.position.set(cx, GH / 2, cz);
        body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), rad);
        body.collisionFilterGroup = 1;
        body.collisionFilterMask  = 2;
        this.world.addBody(body);
      }
    }
  }

  // ===== スタートライン =====
  _buildStartFinishLine() {
    const p = this._cl[0], nm = this._norms[0];
    this._startRad = Math.atan2(nm.tx, nm.tz);
    this._startPos = p;
    const rad = this._startRad;

    const toW = (s, f, y) => ({
      x: p.x + nm.nx * s + nm.tx * f,
      y,
      z: p.z + nm.nz * s + nm.tz * f,
    });

    const line = new THREE.Mesh(
      new THREE.BoxGeometry(ROAD_WIDTH, 0.04, 2),
      new THREE.MeshLambertMaterial({ color: 0xffffff })
    );
    const lp = toW(0, 0, 0.05);
    line.position.set(lp.x, lp.y, lp.z);
    line.rotation.y = rad;
    this.scene.add(line);

    const blackMat = new THREE.MeshLambertMaterial({ color: 0x111111 });
    for (let i = -Math.floor(ROAD_WIDTH / 3); i <= Math.floor(ROAD_WIDTH / 3); i += 2) {
      const sq = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.04, 2), blackMat);
      const sp = toW(i * 0.75, 0, 0.06);
      sq.position.set(sp.x, sp.y, sp.z);
      sq.rotation.y = rad;
      this.scene.add(sq);
    }

    const poleMat = new THREE.MeshLambertMaterial({ color: 0xff4400 });
    for (const s of [-ROAD_WIDTH / 2 - 2, ROAD_WIDTH / 2 + 2]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 9, 8), poleMat);
      const pp = toW(s, 0, 4.5);
      pole.position.set(pp.x, pp.y, pp.z);
      this.scene.add(pole);
    }

    const banner = new THREE.Mesh(
      new THREE.PlaneGeometry(ROAD_WIDTH + 4, 1.5),
      new THREE.MeshBasicMaterial({ color: 0xff4400, side: THREE.DoubleSide })
    );
    const bp = toW(0, 0, 9.5);
    banner.position.set(bp.x, bp.y, bp.z);
    banner.rotation.y = rad;
    this.scene.add(banner);
  }

  // ===== スポーン =====
  _setupSpawnPoints() {
    if (!this._startPos) return;
    const p = this._startPos, nm = this._norms[0];
    const rad = this._startRad;
    this.spawnHeading = rad;
    const toW = (s, f) => ({ x: p.x + nm.nx * s + nm.tx * f, z: p.z + nm.nz * s + nm.tz * f });
    const sp = ROAD_WIDTH * 0.28;
    const p1 = toW(-sp, -18), p2 = toW(0, -18), p3 = toW(sp, -18);
    this.spawnPoints = [
      new THREE.Vector3(p1.x, 0, p1.z),
      new THREE.Vector3(p2.x, 0, p2.z),
      new THREE.Vector3(p3.x, 0, p3.z),
    ];
  }

  // ===== 環境装飾 =====
  _buildEnvironment() {
    const cl = this._cl;
    let cx = 0, cz = 0;
    cl.forEach(p => { cx += p.x; cz += p.z; });
    cx /= cl.length; cz /= cl.length;

    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x2a1a0e });
    const leafMat  = new THREE.MeshLambertMaterial({ color: 0x0e3a0e });
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2;
      const r = 800 + Math.random() * 500;
      const px = cx + Math.cos(a) * r + (Math.random() - 0.5) * 120;
      const pz = cz + Math.sin(a) * r + (Math.random() - 0.5) * 120;
      const h = 6 + Math.random() * 5;
      const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, h * 0.4, 6), trunkMat);
      tr.position.set(px, h * 0.2, pz); tr.castShadow = true; this.scene.add(tr);
      const fo = new THREE.Mesh(new THREE.ConeGeometry(2 + Math.random(), h * 0.7, 7), leafMat);
      fo.position.set(px, h * 0.6 + h * 0.2, pz); fo.castShadow = true; this.scene.add(fo);
    }

    const bbColors = [0xff4400, 0x0044ff, 0x00aa44, 0xffcc00, 0xff00ff, 0x00ffff];
    const norms = this._norms;
    for (let i = 0; i < 10; i++) {
      const idx = Math.floor(cl.length * i / 10);
      const pt = cl[idx], nm = norms[idx];
      const side = (i % 2 === 0) ? 1 : -1;
      const bx = pt.x + nm.nx * side * (ROAD_WIDTH / 2 + 22);
      const bz = pt.z + nm.nz * side * (ROAD_WIDTH / 2 + 22);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 6, 6), new THREE.MeshLambertMaterial({ color: 0x444444 }));
      pole.position.set(bx, 3, bz); this.scene.add(pole);
      const board = new THREE.Mesh(new THREE.BoxGeometry(5, 2.5, 0.12), new THREE.MeshLambertMaterial({ color: bbColors[i % bbColors.length] }));
      board.position.set(bx, 6.5, bz);
      board.rotation.y = -Math.atan2(nm.tx, nm.tz);
      this.scene.add(board);
    }
  }
}

// ========== CheckpointManager ==========
export class CheckpointManager {
  constructor() { this._checkpoints = []; }
  addCheckpoint(d) { this._checkpoints.push(d); }

  init(cars, totalLaps, raceManager) {
    this._cars = cars;
    this._totalLaps = totalLaps;
    this._raceManager = raceManager;
    this._total = this._checkpoints.length;
  }

  update() {
    if (!this._cars) return;
    this._cars.forEach(car => {
      const cp = this._checkpoints[car.checkpointIndex % this._total];
      if (!cp) return;
      const pos = car.getMeshPosition();
      const dx = pos.x - cp.x, dz = pos.z - cp.z;
      const localFwd  =  dx * Math.sin(cp.rad) + dz * Math.cos(cp.rad);
      const localSide = -dx * Math.cos(cp.rad) + dz * Math.sin(cp.rad);
      if (Math.abs(localFwd) < cp.length * 0.5 + 2 && Math.abs(localSide) < cp.width * 0.5) {
        const prev = car.checkpointIndex;
        car.passCheckpoint(car.checkpointIndex % this._total, this._total);
        if (car.checkpointIndex === 0 && prev !== 0 && car.currentLap >= this._totalLaps) {
          this._raceManager.registerFinish(car);
        }
      }
    });
  }
  getTotalCheckpoints() { return this._total; }
}

// ========== PickupManager ==========
export class PickupManager {
  constructor(scene) { this.scene = scene; this._pickups = []; this._active = false; }

  init(cars, waypoints = []) {
    this._cars = cars;
    this._waypoints = waypoints;
    this._pickups.forEach(p => this.scene.remove(p));
    this._pickups = [];
    const wps = waypoints;
    if (wps.length < 8) return;
    const step = Math.max(1, Math.floor(wps.length / 8));
    for (let i = 0; i < 8; i++) {
      const idx = (i * step + Math.floor(step / 2)) % wps.length;
      const orb = this._makeOrb();
      orb.position.set(wps[idx].x, 1, wps[idx].z);
      orb.userData.active = true;
      orb.userData.respawnTimer = 0;
      this.scene.add(orb);
      this._pickups.push(orb);
    }
  }

  startSpawning() { this._active = true; }

  _makeOrb() {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.SphereGeometry(0.45, 12, 12), new THREE.MeshBasicMaterial({ color: 0x00ffff })));
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.65, 0.06, 8, 20), new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true }));
    ring.rotation.x = Math.PI / 2; g.add(ring);
    const sm = new THREE.MeshBasicMaterial({ color: 0xffff00 });
    for (let j = 0; j < 4; j++) {
      const sp = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.5, 4), sm);
      sp.rotation.z = (j / 4) * Math.PI * 2;
      sp.position.y = 0.5 * Math.sin((j / 4) * Math.PI * 2);
      sp.position.x = 0.5 * Math.cos((j / 4) * Math.PI * 2);
      g.add(sp);
    }
    return g;
  }

  update(cars, dt) {
    if (!this._active) return;
    this._pickups.forEach(orb => {
      orb.rotation.y += dt * 2.5;
      orb.position.y = 1 + Math.sin(Date.now() * 0.002) * 0.2;
      if (!orb.userData.active) {
        orb.userData.respawnTimer -= dt;
        if (orb.userData.respawnTimer <= 0) { orb.userData.active = true; orb.visible = true; }
        return;
      }
      cars.forEach(car => {
        if (car.getMeshPosition().distanceTo(orb.position) < 2.5) {
          car.collectBoost(0.4);
          orb.userData.active = false;
          orb.userData.respawnTimer = 8;
          orb.visible = false;
        }
      });
    });
  }
}
