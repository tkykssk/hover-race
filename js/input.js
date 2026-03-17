/**
 * input.js - キーボード＋ゲームパッド＋タッチ入力管理
 *
 * モバイルではtouchstart/touchendを使用（pointer eventsよりも信頼性が高い）
 * タッチ対応デバイスではゲームパッド入力を完全に無視する
 */
export class InputManager {
  constructor() {
    this._keys = new Set();
    this._gamepadIndex = null;

    this._isTouchDevice =
      ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

    // ボタンごとのアクティブ状態（Set<string>）
    this._touchActions = new Set();

    // デバッグ用：最後に返した入力値を外部から参照可能にする
    this._lastInput = { throttle: 0, brake: 0, steer: 0, boost: false };

    window.addEventListener('keydown', e => {
      this._keys.add(e.code);
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', e => this._keys.delete(e.code));

    if (!this._isTouchDevice) {
      window.addEventListener('gamepadconnected', e => {
        this._gamepadIndex = e.gamepad.index;
      });
      window.addEventListener('gamepaddisconnected', () => {
        this._gamepadIndex = null;
      });
    }

    this._setupTouchButtons();

    window.addEventListener('blur', () => this._touchActions.clear());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._touchActions.clear();
    });
  }

  _setupTouchButtons() {
    const mapping = {
      'btn-steer-left':  'steerL',
      'btn-steer-right': 'steerR',
      'btn-throttle':    'throttle',
      'btn-brake':       'brake',
      'btn-boost':       'boost',
    };

    for (const [id, action] of Object.entries(mapping)) {
      const el = document.getElementById(id);
      if (!el) continue;

      // --- Touch events（モバイル向け：targetに紐づくため指が外れてもtouchendが来る） ---
      el.addEventListener('touchstart', e => {
        e.preventDefault();
        this._touchActions.add(action);
      }, { passive: false });

      el.addEventListener('touchend', e => {
        e.preventDefault();
        this._touchActions.delete(action);
      }, { passive: false });

      el.addEventListener('touchcancel', () => {
        this._touchActions.delete(action);
      }, { passive: false });

      // --- Mouse events（デスクトップテスト用） ---
      el.addEventListener('mousedown', e => {
        e.preventDefault();
        this._touchActions.add(action);
        const up = () => {
          this._touchActions.delete(action);
          window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mouseup', up);
      });
    }
  }

  /** @returns {{ throttle: number, brake: number, steer: number, boost: boolean }} */
  getInputState() {
    let throttle = 0, brake = 0, steer = 0, boost = false;

    // --- タッチ/マウスボタン ---
    if (this._touchActions.has('throttle')) throttle = 1;
    if (this._touchActions.has('brake'))    brake = 1;
    if (this._touchActions.has('steerL'))   steer = -1;
    if (this._touchActions.has('steerR'))   steer = 1;
    if (this._touchActions.has('boost'))    boost = true;

    // --- キーボード（タッチと併用可） ---
    if (this._keys.has('ArrowUp')   || this._keys.has('KeyW')) throttle = 1;
    if (this._keys.has('ArrowDown') || this._keys.has('KeyS')) brake    = 1;
    const KEY_STEER = 0.35;
    if (this._keys.has('ArrowLeft') || this._keys.has('KeyA')) steer = -KEY_STEER;
    if (this._keys.has('ArrowRight')|| this._keys.has('KeyD')) steer =  KEY_STEER;
    if (this._keys.has('ShiftLeft') || this._keys.has('ShiftRight') || this._keys.has('Space')) boost = true;

    // --- ゲームパッド（タッチデバイスでは完全無効） ---
    if (!this._isTouchDevice && this._gamepadIndex !== null) {
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

    this._lastInput = { throttle, brake, steer, boost };
    return { throttle, brake, steer, boost };
  }

  _deadzone(value, threshold) {
    if (Math.abs(value) < threshold) return 0;
    return (value - Math.sign(value) * threshold) / (1 - threshold);
  }
}
