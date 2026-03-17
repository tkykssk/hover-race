/**
 * main.js - ゲームループ・ステートマシン・モジュール統括
 */
import * as THREE from 'three';
import { InputManager } from './input.js';
import { PhysicsWorld } from './physics.js';
import { ChibiCar, CAR_CONFIGS } from './car.js';
import { TrackBuilder } from './track.js';
import { AIDriver } from './ai.js';
import { HUD } from './hud.js';

// ========== ゲームステート ==========
export const GameState = {
  MENU: 'MENU',
  CAR_SELECT: 'CAR_SELECT',
  COUNTDOWN: 'COUNTDOWN',
  RACING: 'RACING',
  FINISH: 'FINISH',
  RESULTS: 'RESULTS',
};

// ========== グローバル変数 ==========
let renderer, scene, camera;
let physicsWorld;
let input;
let hud;
let trackBuilder;
let playerCar;
let aiDrivers = [];
let allCars = [];
let raceManager;
let currentState = GameState.MENU;
let lastTime = 0;
let fixedAccumulator = 0;
const FIXED_DT = 1 / 120;
let selectedCarIndex = 0;
const TOTAL_LAPS = 3;

// カウントダウン用
let countdownValue = 0;
let countdownTimer = 0;
let countdownPhase = 'counting'; // 'counting' | 'go'

// ========== 初期化 ==========
function initThreeJS() {
  const gameCanvas = document.getElementById('game-canvas');
  // 深度精度を改善して遠景と近景のZファイティングを抑える
  renderer = new THREE.WebGLRenderer({
    canvas: gameCanvas,
    antialias: true,
    logarithmicDepthBuffer: true,
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050a18);
  scene.fog = new THREE.Fog(0x050a18, 400, 2500);

  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.5, 3000);
  camera.position.set(0, 5, -10);

  // ライティング（F-ZERO 風：暗めのアンビエント＋青白いサン）
  const ambientLight = new THREE.AmbientLight(0x223366, 0.8);
  scene.add(ambientLight);

  // 補助カラーライト（サイドから）
  const blueLight = new THREE.PointLight(0x0044ff, 0.5, 200);
  blueLight.position.set(-80, 40, 0);
  scene.add(blueLight);

  const dirLight = new THREE.DirectionalLight(0xaaccff, 1.1);
  dirLight.position.set(50, 100, 50);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width  = 2048;
  dirLight.shadow.mapSize.height = 2048;
  dirLight.shadow.camera.near = 0.5;
  dirLight.shadow.camera.far  = 3000;
  dirLight.shadow.camera.left   = -1500;
  dirLight.shadow.camera.right  =  1500;
  dirLight.shadow.camera.top    =  1500;
  dirLight.shadow.camera.bottom = -1500;
  scene.add(dirLight);

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    hud?.resize();
  });
}

// カメラ追従（スプリングアーム）
const camOffset = new THREE.Vector3(0, 4.0, -10);
const camTargetPos = new THREE.Vector3();
const camCurrentPos = new THREE.Vector3();
function updateCamera(dt) {
  if (!playerCar) return;
  const carPos = playerCar.getMeshPosition();
  const carQuat = playerCar.getMeshQuaternion();

  const offset = camOffset.clone().applyQuaternion(carQuat);
  camTargetPos.copy(carPos).add(offset);

  const lerpSpeed = 1 - Math.pow(0.01, dt);
  camCurrentPos.lerp(camTargetPos, lerpSpeed);
  camera.position.copy(camCurrentPos);

  const lookAt = carPos.clone().add(new THREE.Vector3(0, 1, 0));
  camera.lookAt(lookAt);
}

// ========== レース管理 ==========
class RaceManager {
  constructor(cars, totalLaps) {
    this.cars = cars;
    this.totalLaps = totalLaps;
    this.startTime = null;
    this.finished = [];
    this.raceEnded = false;
  }

  start() {
    this.startTime = performance.now();
  }

  getElapsedTime() {
    if (!this.startTime) return 0;
    return (performance.now() - this.startTime) / 1000;
  }

  // 順位計算（ラップ数 + チェックポイント通過数 + ゴールからの距離で近似）
  computePositions(waypoints) {
    const scores = this.cars.map(car => {
      const cp = car.checkpointIndex;
      const lap = car.currentLap;
      // ウェイポイントまでの距離（小さいほど進んでいる）
      const nextWp = waypoints[cp % waypoints.length];
      const dist = car.getMeshPosition().distanceTo(nextWp);
      return { car, score: lap * 10000 + cp * 100 - dist * 0.01 };
    });
    scores.sort((a, b) => b.score - a.score);
    scores.forEach((s, i) => { s.car.racePosition = i + 1; });
    return scores;
  }

  registerFinish(car) {
    if (!this.finished.find(f => f.car === car)) {
      this.finished.push({
        car,
        time: this.getElapsedTime(),
        name: car.config.name + (car.isPlayer ? '（あなた）' : ''),
      });
      if (this.finished.length >= this.cars.length) {
        this.raceEnded = true;
      }
    }
  }

  formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 100);
    return `${m}:${String(s).padStart(2,'0')}.${String(ms).padStart(2,'0')}`;
  }
}

// ========== ゲームセットアップ ==========
function setupRace() {
  // 既存の車を削除
  allCars.forEach(c => {
    scene.remove(c.mesh);
    if (c.hoverVehicle) c.removeFromPhysics();
  });
  allCars = [];
  aiDrivers = [];

  // 物理ワールドをリセット
  physicsWorld.reset();

  // トラックは最初の一度だけ構築（物理ボディも含め使い回す）
  if (!trackBuilder) {
    trackBuilder = new TrackBuilder(scene, physicsWorld.world, physicsWorld.trackMaterial);
    trackBuilder.build();
  }
  // チェックポイント・ピックアップをリセット
  trackBuilder.checkpointManager._cars = null;
  trackBuilder.pickupManager._active = false;

  const spawnPoints = trackBuilder.getSpawnPoints();
  const waypoints   = trackBuilder.getWaypoints();
  const heading     = trackBuilder.spawnHeading ?? 0;

  // プレイヤーカー
  const pConfig = CAR_CONFIGS[selectedCarIndex];
  playerCar = new ChibiCar(pConfig, physicsWorld.world, scene, true);
  playerCar.initPhysics(physicsWorld);
  playerCar.setPosition(spawnPoints[0], heading);
  allCars.push(playerCar);

  // AI カー（2台）
  const aiConfigs = [
    CAR_CONFIGS[(selectedCarIndex + 1) % CAR_CONFIGS.length],
    CAR_CONFIGS[(selectedCarIndex + 2) % CAR_CONFIGS.length],
  ];
  aiConfigs.forEach((cfg, i) => {
    const aiCar = new ChibiCar(cfg, physicsWorld.world, scene, false);
    aiCar.initPhysics(physicsWorld);
    aiCar.setPosition(spawnPoints[i + 1], heading);
    allCars.push(aiCar);
    aiDrivers.push(new AIDriver(aiCar, waypoints));
  });

  raceManager = new RaceManager(allCars, TOTAL_LAPS);
  trackBuilder.checkpointManager.init(allCars, TOTAL_LAPS, raceManager);
  trackBuilder.pickupManager.init(allCars, waypoints);

  const headingQuat = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0), heading
  );
  camCurrentPos.copy(spawnPoints[0]).add(camOffset.clone().applyQuaternion(headingQuat));
  camera.position.copy(camCurrentPos);
  camera.lookAt(spawnPoints[0].x, 1, spawnPoints[0].z);
}

// ========== カウントダウン ==========
function startCountdown() {
  setState(GameState.COUNTDOWN);
  countdownValue = 3;
  countdownTimer = 0;
  countdownPhase = 'counting';
  showCountdownScreen('3');
}

function updateCountdown(dt) {
  countdownTimer += dt;
  const interval = countdownPhase === 'go' ? 0.7 : 1.0;

  if (countdownTimer >= interval) {
    countdownTimer = 0;
    if (countdownPhase === 'go') {
      hideScreen('screen-countdown');
      setState(GameState.RACING);
      raceManager.start();
      trackBuilder.pickupManager.startSpawning();
      return;
    }
    countdownValue--;
    if (countdownValue <= 0) {
      countdownPhase = 'go';
      showCountdownScreen('GO!');
    } else {
      showCountdownScreen(String(countdownValue));
    }
  }
}

// ========== メインゲームループ ==========
function gameLoop(timestamp) {
  requestAnimationFrame(gameLoop);

  const dt = Math.min((timestamp - lastTime) / 1000, 0.1);
  lastTime = timestamp;

  if (currentState === GameState.COUNTDOWN) {
    updateCountdown(dt);
    renderer.render(scene, camera);
    return;
  }

  if (currentState !== GameState.RACING && currentState !== GameState.FINISH) {
    renderer.render(scene, camera);
    return;
  }

  // 入力取得
  const inputState = input.getInputState();

  // プレイヤーカー更新
  if (currentState === GameState.RACING) {
    playerCar.update(inputState, dt);
  } else {
    playerCar.update({ throttle: 0, brake: 1, steer: 0, boost: false }, dt);
  }

  // AI 更新
  const raceState = buildRaceState();
  aiDrivers.forEach(ai => ai.update(dt, raceState));

  // 物理ステップ（固定タイムステップ）
  fixedAccumulator += dt;
  while (fixedAccumulator >= FIXED_DT) {
    physicsWorld.step(FIXED_DT);
    fixedAccumulator -= FIXED_DT;
  }

  // メッシュ同期（dtを渡してビジュアル側ヨー角のクールタイム制御に利用）
  allCars.forEach(car => car.syncMeshToPhysics(dt));

  // チェックポイント更新
  trackBuilder.checkpointManager.update();

  // ピックアップ更新
  trackBuilder.pickupManager.update(allCars, dt);

  // 順位計算
  raceManager.computePositions(trackBuilder.getWaypoints());

  // カメラ更新
  updateCamera(dt);

  // レース終了チェック
  if (raceManager.raceEnded && currentState === GameState.RACING) {
    setState(GameState.FINISH);
    setTimeout(() => showResults(), 2000);
  }

  // HUD 更新
  const speed = playerCar.getSpeed();
  hud.render({
    speed,
    lapCurrent: Math.min(playerCar.currentLap + 1, TOTAL_LAPS),
    lapTotal: TOTAL_LAPS,
    lapTime: raceManager.getElapsedTime(),
    bestLapTime: playerCar.bestLapTime,
    racePosition: playerCar.racePosition,
    totalCars: allCars.length,
    boostCharge: playerCar.boostCharge,
    allCarPositions: allCars.map(c => ({
      x: c.getMeshPosition().x,
      z: c.getMeshPosition().z,
      isPlayer: c.isPlayer,
      color: c.config.color,
    })),
    waypointPath: trackBuilder.getWaypoints(),
    gameState: currentState,
    debugInput: input._lastInput,
    debugTouchActions: [...input._touchActions],
    debugIsTouchDevice: input._isTouchDevice,
  });

  renderer.render(scene, camera);
}

function buildRaceState() {
  return {
    playerLapDistance: playerCar.currentLap * 1000 + playerCar.checkpointIndex * 10,
    allCars: allCars,
  };
}

// ========== ステート管理 ==========
function setState(newState) {
  currentState = newState;
}

// ========== UI 操作 ==========
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
}

function hideScreen(id) {
  document.getElementById(id)?.classList.remove('active');
}

function showCountdownScreen(text) {
  const el = document.getElementById('countdown-number');
  el.textContent = text;
  el.style.color  = text === 'GO!' ? '#00ff88' : '#ffffff';
  // アニメーションリセット
  el.style.animation = 'none';
  el.offsetHeight; // reflow
  el.style.animation = '';
  showScreen('screen-countdown');
}

function showResults() {
  setState(GameState.RESULTS);

  // 全車をフィニッシュ登録（タイムアウト対応）
  allCars.forEach(car => {
    if (!raceManager.finished.find(f => f.car === car)) {
      raceManager.registerFinish(car);
    }
  });

  const list = document.getElementById('results-list');
  list.innerHTML = '';
  const medals = ['🥇','🥈','🥉','4位'];

  raceManager.finished.forEach((entry, i) => {
    const div = document.createElement('div');
    div.className = `result-item rank-${i+1}${entry.car.isPlayer ? ' player' : ''}`;
    div.innerHTML = `
      <span class="rank-badge">${medals[i] ?? (i+1)+'位'}</span>
      <span class="result-name">${entry.name}</span>
      <span class="result-time">${raceManager.formatTime(entry.time)}</span>
    `;
    list.appendChild(div);
  });

  // 結果タイトル
  const playerRank = raceManager.finished.findIndex(f => f.car.isPlayer) + 1;
  const titleEl = document.getElementById('results-title');
  titleEl.textContent = playerRank === 1 ? '🏆 優勝！' : `${playerRank}位 フィニッシュ`;

  showScreen('screen-results');
}

// ========== 車選択画面 ==========
function buildCarSelectUI() {
  const list = document.getElementById('car-list');
  list.innerHTML = '';
  CAR_CONFIGS.forEach((cfg, i) => {
    const card = document.createElement('div');
    card.className = 'car-card' + (i === selectedCarIndex ? ' selected' : '');
    card.innerHTML = `
      <div class="car-color-dot" style="background:#${cfg.color.toString(16).padStart(6,'0')}"></div>
      <div class="car-name">${cfg.name}</div>
      <div class="car-stat"><span>スピード</span><span class="bar" style="width:${cfg.speed*10}%"></span></div>
      <div class="car-stat"><span>加速</span><span class="bar" style="width:${cfg.accel*10}%"></span></div>
      <div class="car-stat"><span>ハンドル</span><span class="bar" style="width:${cfg.handling*10}%"></span></div>
    `;
    card.addEventListener('click', () => {
      selectedCarIndex = i;
      document.querySelectorAll('.car-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      document.getElementById('btn-race').disabled = false;
    });
    list.appendChild(card);
  });
  // デフォルト選択有効
  document.getElementById('btn-race').disabled = false;
}

// ========== イベントリスナー ==========
function setupUIEvents() {
  document.getElementById('btn-start').addEventListener('click', () => {
    buildCarSelectUI();
    showScreen('screen-car-select');
    setState(GameState.CAR_SELECT);
  });

  document.getElementById('btn-back-menu').addEventListener('click', () => {
    showScreen('screen-menu');
    setState(GameState.MENU);
  });

  document.getElementById('btn-race').addEventListener('click', () => {
    hideScreen('screen-car-select');
    setupRace();
    startCountdown();
  });

  document.getElementById('btn-retry').addEventListener('click', () => {
    hideScreen('screen-results');
    setupRace();
    startCountdown();
  });

  document.getElementById('btn-menu').addEventListener('click', () => {
    showScreen('screen-menu');
    setState(GameState.MENU);
  });
}

// ========== エントリポイント ==========
async function main() {
  initThreeJS();

  physicsWorld = new PhysicsWorld();

  input = new InputManager();

  const hudCanvas = document.getElementById('hud-canvas');
  hud = new HUD(hudCanvas);
  hud.resize();

  setupUIEvents();
  showScreen('screen-menu');

  lastTime = performance.now();
  requestAnimationFrame(gameLoop);
}

main().catch(console.error);
