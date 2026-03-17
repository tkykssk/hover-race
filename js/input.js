/**
 * input.js - キーボード＋ゲームパッド＋タッチ入力管理
 */
export class InputManager {
  constructor() {
    this._keys = new Set();
    this._gamepadIndex = null;
    this._touchMode = false;

    // タッチ入力状態（ポインタIDで管理）
    this._activePointers = new Map();

    window.addEventListener('keydown', e => {
      this._keys.add(e.code);
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', e => this._keys.delete(e.code));

    window.addEventListener('gamepadconnected', e => {
      if (!this._touchMode) this._gamepadIndex = e.gamepad.index;
    });
    window.addEventListener('gamepaddisconnected', () => {
      this._gamepadIndex = null;
    });

    this._setupTouchButtons();
  }

  _setupTouchButtons() {
    const buttons = {
      'btn-steer-left':  'steerL',
      'btn-steer-right': 'steerR',
      'btn-throttle':    'throttle',
      'btn-brake':       'brake',
      'btn-boost':       'boost',
    };

    for (const [id, action] of Object.entries(buttons)) {
      const el = document.getElementById(id);
      if (!el) continue;

      el.addEventListener('pointerdown', e => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        this._touchMode = true;
        this._activePointers.set(e.pointerId, action);
      });

      const release = e => {
        e.preventDefault();
        this._activePointers.delete(e.pointerId);
      };
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
      el.addEventListener('lostpointercapture', release);
    }
  }

  /** @returns {{ throttle: number, brake: number, steer: number, boost: boolean }} */
  getInputState() {
    let throttle = 0, brake = 0, steer = 0, boost = false;

    // --- タッチ ---
    for (const action of this._activePointers.values()) {
      if (action === 'throttle') throttle = 1;
      if (action === 'brake')    brake = 1;
      if (action === 'steerL')   steer = -1;
      if (action === 'steerR')   steer = 1;
      if (action === 'boost')    boost = true;
    }

    // --- キーボード（タッチと併用可） ---
    if (this._keys.has('ArrowUp')   || this._keys.has('KeyW')) throttle = 1;
    if (this._keys.has('ArrowDown') || this._keys.has('KeyS')) brake    = 1;
    const KEY_STEER_STRENGTH = 0.35;
    if (this._keys.has('ArrowLeft') || this._keys.has('KeyA')) steer = -KEY_STEER_STRENGTH;
    if (this._keys.has('ArrowRight')|| this._keys.has('KeyD')) steer =  KEY_STEER_STRENGTH;
    if (this._keys.has('ShiftLeft') || this._keys.has('ShiftRight') || this._keys.has('Space')) boost = true;

    // --- ゲームパッド（タッチモード中は無視） ---
    if (!this._touchMode && this._gamepadIndex !== null) {
      const gp = navigator.getGamepads()[this._gamepadIndex];
      if (gp) {
        const gpThrottle = Math.max(0, gp.axes[5] ?? 0);
        const gpBrake    = Math.max(0, gp.axes[4] ?? 0);
        const gpSteer    = this._deadzone(gp.axes[0], 0.15);
        if (gpThrottle > 0.05) throttle = gpThrottle;
        if (gpBrake    > 0.05) brake    = gpBrake;
        if (Math.abs(gpSteer) > 0) steer = gpSteer;
        if (gp.buttons[0]?.pressed) boost = true;
      }
    }

    return { throttle, brake, steer, boost };
  }

  _deadzone(value, threshold) {
    if (Math.abs(value) < threshold) return 0;
    return (value - Math.sign(value) * threshold) / (1 - threshold);
  }
}
