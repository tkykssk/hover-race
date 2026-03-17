/**
 * input.js - キーボード＋ゲームパッド入力管理
 */
export class InputManager {
  constructor() {
    this._keys = new Set();
    this._gamepadIndex = null;

    // タッチ入力状態
    this._touchThrottle = 0;
    this._touchBrake    = 0;
    this._touchSteer    = 0;
    this._touchBoost    = false;

    window.addEventListener('keydown', e => {
      this._keys.add(e.code);
      // ページスクロール防止
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', e => this._keys.delete(e.code));

    window.addEventListener('gamepadconnected', e => {
      this._gamepadIndex = e.gamepad.index;
    });
    window.addEventListener('gamepaddisconnected', () => {
      this._gamepadIndex = null;
    });

    // タッチボタン
    const steerL = document.getElementById('btn-steer-left');
    const steerR = document.getElementById('btn-steer-right');
    const accel  = document.getElementById('btn-throttle');
    const brake  = document.getElementById('btn-brake');
    const boost  = document.getElementById('btn-boost');

    const bindHold = (el, on, off) => {
      if (!el) return;
      const start = e => { e.preventDefault(); on(); };
      const end   = e => { e.preventDefault(); off(); };
      el.addEventListener('pointerdown', start);
      el.addEventListener('pointerup', end);
      el.addEventListener('pointerleave', end);
      el.addEventListener('pointercancel', end);
    };

    bindHold(steerL,
      () => { this._touchSteer = -1; },
      () => { if (this._touchSteer < 0) this._touchSteer = 0; },
    );
    bindHold(steerR,
      () => { this._touchSteer = 1; },
      () => { if (this._touchSteer > 0) this._touchSteer = 0; },
    );
    bindHold(accel,
      () => { this._touchThrottle = 1; },
      () => { this._touchThrottle = 0; },
    );
    bindHold(brake,
      () => { this._touchBrake = 1; },
      () => { this._touchBrake = 0; },
    );
    bindHold(boost,
      () => { this._touchBoost = true; },
      () => { this._touchBoost = false; },
    );
  }

  /** @returns {{ throttle: number, brake: number, steer: number, boost: boolean }} */
  getInputState() {
    let throttle = this._touchThrottle;
    let brake    = this._touchBrake;
    let steer    = this._touchSteer;
    let boost    = this._touchBoost;

    // キーボード
    if (this._keys.has('ArrowUp')   || this._keys.has('KeyW')) throttle = 1;
    if (this._keys.has('ArrowDown') || this._keys.has('KeyS')) brake    = 1;
    // キーボードのステア入力はやや弱めにする（急な切り返しを抑える）
    const KEY_STEER_STRENGTH = 0.35;
    if (this._keys.has('ArrowLeft') || this._keys.has('KeyA')) steer    = -KEY_STEER_STRENGTH;
    if (this._keys.has('ArrowRight')|| this._keys.has('KeyD')) steer    =  KEY_STEER_STRENGTH;
    if (this._keys.has('ShiftLeft') || this._keys.has('ShiftRight') || this._keys.has('Space')) boost = true;

    // ゲームパッド（優先度: キーボードより低い）
    if (this._gamepadIndex !== null) {
      const gp = navigator.getGamepads()[this._gamepadIndex];
      if (gp) {
        const gpThrottle = Math.max(0, gp.axes[5] ?? 0);   // RT
        const gpBrake    = Math.max(0, gp.axes[4] ?? 0);   // LT
        const gpSteer    = this._deadzone(gp.axes[0], 0.12);// 左スティック横

        if (gpThrottle > 0.05) throttle = gpThrottle;
        if (gpBrake    > 0.05) brake    = gpBrake;
        if (Math.abs(gpSteer) > 0) steer = gpSteer;
        if (gp.buttons[0]?.pressed) boost = true; // Aボタン
      }
    }

    return { throttle, brake, steer, boost };
  }

  _deadzone(value, threshold) {
    if (Math.abs(value) < threshold) return 0;
    return (value - Math.sign(value) * threshold) / (1 - threshold);
  }
}
