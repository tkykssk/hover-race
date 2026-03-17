/**
 * physics.js - ホバー物理（重力ゼロ + Y位置ロック + ヨー直接制御）
 */
import * as CANNON from 'cannon-es';

export class PhysicsWorld {
  constructor() {
    this._init();
  }

  _init() {
    this.world = new CANNON.World();
    this.world.gravity.set(0, 0, 0);
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.solver.iterations = 12;
    this.world.allowSleep = false;

    this.trackMaterial = new CANNON.Material('track');
    this.carMaterial   = new CANNON.Material('car');

    const carCar = new CANNON.ContactMaterial(this.carMaterial, this.carMaterial, {
      friction: 0.0, restitution: 0.5,
    });
    const trackCar = new CANNON.ContactMaterial(this.trackMaterial, this.carMaterial, {
      friction: 0.1, restitution: 0.03,
    });
    this.world.addContactMaterial(carCar);
    this.world.addContactMaterial(trackCar);
    this.world.defaultContactMaterial.friction    = 0.0;
    this.world.defaultContactMaterial.restitution = 0.3;
  }

  step(dt) { this.world.step(dt); }

  reset() {
    const toRemove = this.world.bodies.filter(b => b.mass > 0);
    toRemove.forEach(b => this.world.removeBody(b));
  }

  createHoverVehicle(position, carConfig) {
    return new HoverVehicle(this.world, position, carConfig, this.carMaterial);
  }
}

// ========== HoverVehicle ==========
export class HoverVehicle {
  constructor(world, position, config, carMaterial) {
    this.world  = world;
    this.config = config;

    this.HOVER_H = 0.55;

    const shape = new CANNON.Box(new CANNON.Vec3(0.85, 0.12, 1.4));
    this.body = new CANNON.Body({
      mass: 80,
      linearDamping: 0.15,
      angularDamping: 1.0,
    });
    this.body.addShape(shape);
    this.body.position.set(position.x, this.HOVER_H, position.z);
    this.body.material = carMaterial;
    this.body.collisionFilterGroup = 2;
    this.body.collisionFilterMask  = 1 | 2;
    world.addBody(this.body);

    // ヨー角は自前で管理（物理衝突で勝手に回転しない）
    this._yaw        = 0;
    this._boostTimer = 0;
    this._lastSteer  = 0;
    this.speed       = 0;
    this.isDrifting  = false;
  }

  applyForces(inputState) {
    const body   = this.body;
    const config = this.config;
    const DT     = 1 / 60;

    // === Y位置・速度を強制固定 ===
    body.position.y  = this.HOVER_H;
    body.velocity.y  = 0;
    body.force.y     = 0;

    // === 速度計算 ===
    const vx = body.velocity.x, vz = body.velocity.z;
    this.speed = Math.sqrt(vx * vx + vz * vz);

    const boost    = inputState.boost && this._boostTimer > 0;
    const maxSpeed = config.maxSpeed * (boost ? 1.55 : 1.0);

    // === ステアリング（ヨー直接制御）===
    const speedNorm = Math.min(1, this.speed / Math.max(1, maxSpeed * 0.5));
    // 物理上は入力をそのまま反映し、キーを離したら即座にヨー加速度がゼロになるようにする
    const steer    = inputState.steer;
    const turnRate = config.maxSteer * steer * (0.3 + speedNorm * 0.7);
    this._yaw -= turnRate * 3.0 * DT;
    // 視覚的なバンキング用に、最後に使ったステア値を保持
    this._lastSteer = steer;

    // クォータニオンを直接設定（物理衝突の影響を受けない）
    const halfY = this._yaw * 0.5;
    body.quaternion.set(0, Math.sin(halfY), 0, Math.cos(halfY));
    body.angularVelocity.set(0, 0, 0);

    // === 前方・側方ベクトル ===
    const cy = Math.cos(this._yaw), sy = Math.sin(this._yaw);
    const fwdX = sy, fwdZ = cy;
    const sideX = cy, sideZ = -sy;

    // === エンジンスラスト ===
    if (inputState.throttle > 0 && this.speed < maxSpeed) {
      const ratio = this.speed / (maxSpeed * 1.2);
      const force = inputState.throttle * config.engineForce * (1 - ratio * 0.85);
      body.applyForce(new CANNON.Vec3(fwdX * force, 0, fwdZ * force), body.position);
    }

    // === ブレーキ ===
    if (inputState.brake > 0) {
      const f = -70 * inputState.brake;
      body.applyForce(new CANNON.Vec3(vx * f, 0, vz * f), body.position);
    }

    // === 横滑り抑制 ===
    const sideVel   = sideX * vx + sideZ * vz;
    const grip      = config.handling / 10;
    const sideForce = -sideVel * (50 + grip * 80);
    body.applyForce(new CANNON.Vec3(sideX * sideForce, 0, sideZ * sideForce), body.position);

    this.isDrifting = Math.abs(sideVel) > 4.0 && this.speed > 6;

    // === 空気抵抗 ===
    const drag = 4 + this.speed * 0.08;
    body.applyForce(new CANNON.Vec3(-vx * drag, 0, -vz * drag), body.position);

    // ブーストタイマー
    if (this._boostTimer > 0) this._boostTimer -= DT;

    // 速度ハードキャップ（壁抜け防止用だが、最高速1.5倍に合わせて上限も引き上げ）
    const MAX_VEL = 180;
    const curVel = Math.sqrt(body.velocity.x ** 2 + body.velocity.z ** 2);
    if (curVel > MAX_VEL) {
      const s = MAX_VEL / curVel;
      body.velocity.x *= s;
      body.velocity.z *= s;
    }
  }

  activateBoost(duration = 2.5) { this._boostTimer = duration; }
  removeFromWorld() { this.world.removeBody(this.body); }
  getSpeedKmh() { return this.speed * 3.6; }

  resetState() {
    this._yaw = 0;
    this._boostTimer = 0;
    this.speed = 0;
    this.body.velocity.set(0, 0, 0);
    this.body.angularVelocity.set(0, 0, 0);
    this.body.quaternion.set(0, 0, 0, 1);
    this.body.position.y = this.HOVER_H;
  }
}
