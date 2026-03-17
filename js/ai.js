/**
 * ai.js - AI ドライバー（Pure Pursuit + ラバーバンド）
 */
import * as THREE from 'three';

const DIFFICULTY_PROFILES = {
  // 壁に当たりにくいように、全体的に最高速とラバーバンドを少し抑えめにする
  easy:   { waypointRadius: 7,  maxSpeedMult: 0.65, rubberBandFactor: 0.25 },
  medium: { waypointRadius: 5,  maxSpeedMult: 0.80, rubberBandFactor: 0.4  },
  hard:   { waypointRadius: 3.5,maxSpeedMult: 0.95, rubberBandFactor: 0.6  },
};

export class AIDriver {
  constructor(car, waypoints, difficultyKey = 'medium') {
    this.car       = car;
    this.waypoints = waypoints;
    this.difficulty = DIFFICULTY_PROFILES[difficultyKey] ?? DIFFICULTY_PROFILES.medium;
    this._wpIndex   = 0;
    this._lapDist   = 0;
  }

  update(dt, raceState) {
    if (!this.car.hoverVehicle) return;

    const carPos    = this.car.getMeshPosition();
    const carFwd    = this.car.getForwardVector();
    // 1つ先のウェイポイントも少しだけ先読みして曲がり始めを早める
    const target      = this.waypoints[this._wpIndex];
    const nextIndex   = (this._wpIndex + 3) % this.waypoints.length;
    const nextTarget  = this.waypoints[nextIndex] ?? target;
    if (!target) return;

    // ウェイポイントへのベクトル
    const blendedTarget = target.clone().lerp(nextTarget, 0.35);
    const toTarget = blendedTarget.clone().sub(carPos);
    toTarget.y = 0;
    const dist = toTarget.length();

    // ウェイポイント更新
    if (dist < this.difficulty.waypointRadius) {
      this._wpIndex = (this._wpIndex + 1) % this.waypoints.length;
      this._lapDist++;
    }

    // ステアリング（Pure Pursuit）
    const targetDir = toTarget.normalize();
    const cross     = new THREE.Vector3().crossVectors(carFwd, targetDir);
    const dot       = carFwd.dot(targetDir);
    let steer     = Math.sign(cross.y) * Math.min(1.0, Math.abs(cross.y) * 2.2 + (1 - dot) * 0.5);

    // ===== コース中心線からのずれを補正するステアリング =====
    // 現在のウェイポイントと次のウェイポイントを結ぶ線分を「中心線」として扱う
    const curCenter = target;
    const nextCenter = this.waypoints[(this._wpIndex + 1) % this.waypoints.length] ?? target;
    const segDir = nextCenter.clone().sub(curCenter);
    segDir.y = 0;
    const segLen = segDir.length();
    if (segLen > 0.001) {
      const segDirN = segDir.clone().multiplyScalar(1 / segLen);
      // 車の位置をこの線分に射影し、その最近点を求める
      const toCarFromSegStart = carPos.clone().sub(curCenter);
      toCarFromSegStart.y = 0;
      let proj = toCarFromSegStart.dot(segDirN);
      proj = THREE.MathUtils.clamp(proj, 0, segLen);
      const closest = curCenter.clone().add(segDirN.clone().multiplyScalar(proj));

      const lateralVec = carPos.clone().sub(closest);
      lateralVec.y = 0;
      const latLen = lateralVec.length();
      if (latLen > 0.001) {
        // 線分の左側/右側を判定する法線ベクトル
        const segNormal = new THREE.Vector3(-segDirN.z, 0, segDirN.x);
        const sideSign = Math.sign(lateralVec.dot(segNormal)) || 0;
        const lateralError = sideSign * latLen;
        // 中心線から離れすぎたら内側に戻るようにステア補正
        const CENTER_GAIN = 0.03; // 値を上げると強く中心に戻ろうとする
        const centerSteer = THREE.MathUtils.clamp(-lateralError * CENTER_GAIN, -0.6, 0.6);
        steer += centerSteer;
      }
    }

    // 角度に応じてコーナー減速
    const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
    const cornerSlowdown = Math.max(0.3, 1.0 - angle / Math.PI * 2.0);

    // ラバーバンド
    const playerLapDist = raceState.playerLapDistance;
    const myLapDist     = this.car.currentLap * 1000 + this._lapDist * 10;
    const gap           = playerLapDist - myLapDist;
    const rubberBand    = Math.max(0.5, Math.min(1.2, 1.0 + gap * this.difficulty.rubberBandFactor * 0.001));

    // AI の現在速度に応じて、舵角とスピード上限を調整
    const speedKmh   = this.car.getSpeed();
    const speedNorm  = Math.min(1, speedKmh / 220);

    // 速度が高いほどステアを抑えてふらつきを低減
    const steerGain  = 0.6 + (1 - speedNorm) * 0.4;
    steer *= steerGain;

    const throttleMult = cornerSlowdown * rubberBand * this.difficulty.maxSpeedMult;
    const throttleBase = Math.max(0, Math.min(1, throttleMult));

    // きついコーナー＋高速時は積極的にブレーキ
    let brake = 0;
    if (angle > 0.9 && speedKmh > 140) {
      brake = Math.min(0.8, (angle - 0.9) * 0.9 + (speedKmh - 140) * 0.01);
    } else if (angle > 1.2) {
      brake = 0.4;
    }

    const throttle     = brake > 0 ? throttleBase * 0.6 : throttleBase;

    // 障害物回避（他の車との衝突を粗く回避）
    const avoidSteer = this._computeAvoidance(carPos);

    this.car.update({
      throttle,
      brake,
      steer: Math.max(-1, Math.min(1, steer + avoidSteer)),
      boost: false,
    }, dt);
  }

  _computeAvoidance(carPos) {
    if (!this.car._physicsWorld) return 0;
    // 他の車が3ユニット以内に来たら横にずれる
    let avoidX = 0;
    const bodies = this.car._physicsWorld.world.bodies;
    bodies.forEach(body => {
      if (body === this.car.chassisBody || body.mass === 0) return;
      const dx = body.position.x - carPos.x;
      const dz = body.position.z - carPos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < 3.0 && dist > 0.1) {
        // 左右のどちらに避けるか
        const side = (dx * this.car.getForwardVector().z - dz * this.car.getForwardVector().x);
        avoidX += Math.sign(side) * (1 - dist / 3.0) * 0.5;
      }
    });
    return Math.max(-0.5, Math.min(0.5, avoidX));
  }
}
