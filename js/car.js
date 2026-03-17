/**
 * car.js - F-ZERO風ホバーマシン（バンキング付き）
 */
import * as THREE from 'three';

export const CAR_CONFIGS = [
  {
    name: 'ブルーファルコン',
    color: 0x1155ff, accentColor: 0x88ccff, glowColor: 0x00aaff,
    speed: 9, accel: 8, handling: 8,
    maxSpeed: 63, engineForce: 3150, maxSteer: 0.32, type: 'falcon',
  },
  {
    name: 'ファイアスティング',
    color: 0xdd2200, accentColor: 0xffaa00, glowColor: 0xff4400,
    speed: 10, accel: 6, handling: 6,
    maxSpeed: 77, engineForce: 3600, maxSteer: 0.25, type: 'sting',
  },
  {
    name: 'ゴールデンフォックス',
    color: 0xddaa00, accentColor: 0xffffaa, glowColor: 0xffee00,
    speed: 8, accel: 10, handling: 10,
    maxSpeed: 57, engineForce: 2700, maxSteer: 0.40, type: 'fox',
  },
  {
    name: 'ワイルドグース',
    color: 0x116622, accentColor: 0x88ffaa, glowColor: 0x00ff88,
    speed: 7, accel: 7, handling: 6,
    maxSpeed: 54, engineForce: 4050, maxSteer: 0.24, type: 'goose',
  },
];

export class ChibiCar {
  constructor(config, world, scene, isPlayer) {
    this.config   = config;
    this.scene    = scene;
    this.isPlayer = isPlayer;

    this.currentLap      = 0;
    this.checkpointIndex = 0;
    this.racePosition    = 1;
    this.bestLapTime     = null;
    this._lapStartTime   = null;
    this.boostCharge     = 0;
    this._boostActive    = false;
    this._bankAngle      = 0;
    this._glowPhase      = Math.random() * Math.PI * 2;
    // 物理ボディの向きとは別に、ビジュアル用のヨー角を持たせてクールタイム付きで追従させる
    this._visualYaw      = 0;

    this._buildMesh();
    scene.add(this.mesh);
  }

  initPhysics(physicsWorld) {
    this.hoverVehicle  = physicsWorld.createHoverVehicle(
      { x: 0, y: 0, z: 0 }, this.config
    );
    this.chassisBody   = this.hoverVehicle.body;
    this._physicsWorld = physicsWorld;
  }

  removeFromPhysics() {
    if (this.hoverVehicle) this.hoverVehicle.removeFromWorld();
  }

  _buildMesh() {
    // meshRoot → physics 同期（ヨーのみ）
    // meshBody → バンキング（傾き）適用
    this.meshRoot = new THREE.Group();
    this.meshBody = buildFZeroMesh(this.config);
    this.meshRoot.add(this.meshBody);
    this.mesh = this.meshRoot;

    this._glowMeshes = [];
    this.meshBody.traverse(c => {
      if (c.userData?.isGlow) this._glowMeshes.push(c);
    });
  }

  update(inputState, dt) {
    if (!this.hoverVehicle) return;

    let effectiveInput = { ...inputState };
    if (this._boostActive) {
      effectiveInput.boost = true;
      this.boostCharge = Math.max(0, this.boostCharge - dt * 0.5);
      if (this.boostCharge <= 0) { this._boostActive = false; this.boostCharge = 0; }
    } else if (inputState.boost && this.boostCharge > 0.05) {
      this._boostActive = true;
      this.hoverVehicle.activateBoost(2.5);
    } else {
      effectiveInput.boost = false;
    }

    this.hoverVehicle.applyForces(effectiveInput);
  }

  syncMeshToPhysics(dt) {
    if (!this.chassisBody) return;

    const p = this.chassisBody.position;
    const q = this.chassisBody.quaternion;
    this.meshRoot.position.set(p.x, p.y, p.z);

    // 物理上のヨー角
    const physQuat = new THREE.Quaternion(q.x, q.y, q.z, q.w);
    const euler    = new THREE.Euler().setFromQuaternion(physQuat, 'YXZ');
    const physYaw  = euler.y;

    // 初回は一気に追従
    if (this._visualYaw === 0 && (physYaw !== 0)) {
      this._visualYaw = physYaw;
    } else {
      // ビジュアル側のヨー角は最大回頭速度を持って徐々に追従させる
      const MAX_YAW_RATE = 3.5; // 1秒あたりの最大ヨー変化量（ラジアン）
      const maxDelta = MAX_YAW_RATE * (dt || 0.016);
      let diff = physYaw - this._visualYaw;
      // [-PI, PI] に正規化
      while (diff > Math.PI)  diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const clamped = Math.max(-maxDelta, Math.min(maxDelta, diff));
      this._visualYaw += clamped;
    }

    this.meshRoot.rotation.set(0, this._visualYaw, 0);

    // バンキング（視覚的な傾き）
    const steer     = this.hoverVehicle._lastSteer ?? 0;
    const speedNorm = Math.min(1, this.hoverVehicle.speed / 12);
    const targetBank = -steer * speedNorm * 0.2;
    this._bankAngle  = this._bankAngle * 0.88 + targetBank * 0.12;
    this.meshBody.rotation.z = this._bankAngle;

    // ホバーボブ（上下微振動）
    const bob = Math.sin(Date.now() * 0.0025 + this._glowPhase) * 0.04;
    this.meshBody.position.y = bob;

    // グロー点滅
    this._glowPhase += 0.07;
    const g = 0.55 + Math.sin(this._glowPhase) * 0.45;
    const boost = this._boostActive;
    this._glowMeshes.forEach(m => {
      if (m.material?.emissiveIntensity !== undefined) {
        m.material.emissiveIntensity = boost ? 2.5 : g;
        m.material.opacity = boost ? 1.0 : 0.6 + g * 0.3;
      }
    });
  }

  setPosition(pos, heading = 0) {
    if (!this.chassisBody) return;
    const hv = this.hoverVehicle;
    const h = hv ? hv.HOVER_H : 0.55;

    this.chassisBody.velocity.set(0, 0, 0);
    this.chassisBody.angularVelocity.set(0, 0, 0);
    this.chassisBody.position.set(pos.x, h, pos.z);

    const halfY = heading * 0.5;
    this.chassisBody.quaternion.set(0, Math.sin(halfY), 0, Math.cos(halfY));

    this.meshRoot.position.set(pos.x, h, pos.z);
    this.meshRoot.quaternion.setFromAxisAngle(
      new THREE.Vector3(0, 1, 0), heading
    );

    if (hv) {
      hv._yaw = heading;
      hv._boostTimer = 0;
      hv.speed = 0;
      hv._lastSteer = 0;
    }
    this._visualYaw = heading;
    this._bankAngle = 0;
    this._boostActive = false;
    this.boostCharge = 0;
  }

  getMeshPosition()  { return this.meshRoot.position.clone(); }
  getMeshQuaternion(){ return this.meshRoot.quaternion.clone(); }
  getForwardVector() {
    // 進行方向のロジック（AIや物理系の計算）には、ビジュアル用ではなく物理ボディの向きを使う
    if (this.chassisBody) {
      const q = this.chassisBody.quaternion;
      const quat = new THREE.Quaternion(q.x, q.y, q.z, q.w);
      return new THREE.Vector3(0, 0, 1).applyQuaternion(quat).normalize();
    }
    return new THREE.Vector3(0, 0, 1).applyQuaternion(this.meshRoot.quaternion).normalize();
  }
  getSpeed() { return this.hoverVehicle ? this.hoverVehicle.getSpeedKmh() : 0; }

  collectBoost(amount = 0.5) {
    this.boostCharge = Math.min(1, this.boostCharge + amount);
    this.hoverVehicle?.activateBoost(2.5);
    this._boostActive = true;
  }

  passCheckpoint(index, total) {
    if (index === this.checkpointIndex) {
      this.checkpointIndex++;
      if (this.checkpointIndex >= total) { this.checkpointIndex = 0; this.completeLap(); }
    }
  }

  completeLap() {
    this.currentLap++;
    const now = performance.now() / 1000;
    if (this._lapStartTime !== null) {
      const t = now - this._lapStartTime;
      if (this.bestLapTime === null || t < this.bestLapTime) this.bestLapTime = t;
    }
    this._lapStartTime = now;
  }
}

// ========== F-ZERO風メッシュ生成 ==========
export function buildFZeroMesh(config) {
  const g = new THREE.Group();
  const body   = new THREE.MeshLambertMaterial({ color: config.color });
  const accent = new THREE.MeshLambertMaterial({ color: config.accentColor });
  const dark   = new THREE.MeshLambertMaterial({ color: 0x111122 });
  const chrome = new THREE.MeshLambertMaterial({ color: 0xddddee });
  const glass  = new THREE.MeshBasicMaterial({ color: 0x88ddff, transparent: true, opacity: 0.6 });
  const glow   = new THREE.MeshStandardMaterial({
    color: config.glowColor, emissive: config.glowColor,
    emissiveIntensity: 1.0, transparent: true, opacity: 0.85,
  });

  // メインハル
  const hull = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.22, 2.8), body);
  hull.castShadow = true;
  g.add(hull);

  // ノーズ
  const nose1 = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.15, 0.8), accent);
  nose1.position.set(0, 0, 1.8); g.add(nose1);
  const nose2 = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.1, 0.5), accent);
  nose2.position.set(0, 0, 2.3); g.add(nose2);

  // コックピット
  const cockpit = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.28, 0.9), body);
  cockpit.position.set(0, 0.25, 0.1); cockpit.castShadow = true; g.add(cockpit);

  // キャノピー
  const canopy = new THREE.Mesh(
    new THREE.SphereGeometry(0.37, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.5),
    glass
  );
  canopy.position.set(0, 0.27, 0.1); g.add(canopy);

  // 目
  const wMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const bMat = new THREE.MeshBasicMaterial({ color: 0x001133 });
  [-0.35, 0.35].forEach(x => {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), wMat);
    eye.position.set(x, 0.04, 1.52); g.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 8), bMat);
    pupil.position.set(x, 0.04, 1.6); g.add(pupil);
  });

  // サイドウイング＋エンジン
  [-1, 1].forEach(s => {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.08, 1.6), body);
    wing.position.set(s * 1.25, -0.02, -0.1); g.add(wing);
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.09, 1.5), accent);
    tip.position.set(s * 1.72, -0.02, -0.1); g.add(tip);
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.28, 0.8, 10), body);
    pod.rotation.x = Math.PI / 2;
    pod.position.set(s * 1.1, -0.08, -1.3); pod.castShadow = true; g.add(pod);
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.16, 0.14, 10), glow);
    nozzle.rotation.x = Math.PI / 2;
    nozzle.position.set(s * 1.1, -0.08, -1.78);
    nozzle.userData.isGlow = true; g.add(nozzle);
  });

  // リアフィン
  const fin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.32, 0.18), body);
  fin.position.set(0, 0.17, -1.38); g.add(fin);

  // アンダーグロー（ホバーエフェクト）
  const under = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2.2), glow.clone());
  under.rotation.x = Math.PI / 2;
  // 路面メッシュとほぼ同じ高さだとZファイティングが出やすいので、少しだけ離す
  under.position.set(0, -0.18, 0);
  under.userData.isGlow = true; g.add(under);

  // 4コーナーホバーライト
  [[-0.65,-1.0],[-0.65,1.0],[0.65,-1.0],[0.65,1.0]].forEach(([x,z]) => {
    const lt = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 6), glow.clone());
    lt.position.set(x, -0.13, z);
    lt.userData.isGlow = true; g.add(lt);
  });

  // フロントバンパー
  const bumper = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.17, 0.12), accent);
  bumper.position.set(0, 0, 1.46); g.add(bumper);

  _addTypeSpecificParts(g, config, body, accent, chrome);
  return g;
}

function _addTypeSpecificParts(g, config, body, accent, chrome) {
  switch (config.type) {
    case 'falcon': {
      const spine = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.26, 2.5), accent);
      spine.position.set(0, 0.22, -0.1); g.add(spine); break;
    }
    case 'sting': {
      const shark = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.52, 0.95), accent);
      shark.position.set(0, 0.4, -0.5); g.add(shark);
      const ext = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.08, 0.55), accent);
      ext.position.set(0, 0, 2.75); g.add(ext); break;
    }
    case 'fox': {
      [-0.85, 0.55].forEach(z => {
        const w = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.06, 0.24), accent);
        w.position.set(0, 0.14, z); g.add(w);
      }); break;
    }
    case 'goose': {
      const armor = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.09, 2.8), accent);
      armor.position.set(0, -0.1, 0); g.add(armor);
      [-1, 1].forEach(s => {
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.22, 2.6), chrome);
        b.position.set(s * 0.94, 0, 0); g.add(b);
      }); break;
    }
  }
}
