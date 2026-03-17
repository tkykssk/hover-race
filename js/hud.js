/**
 * hud.js - 2D Canvas HUD（速度計・ラップ・ポジション・ミニマップ・ブーストゲージ）
 */

// roundRect ポリフィル（古いブラウザ対応）
if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r) {
    if (w < 2 * r) r = w / 2;
    if (h < 2 * r) r = h / 2;
    this.beginPath();
    this.moveTo(x + r, y);
    this.arcTo(x + w, y,     x + w, y + h, r);
    this.arcTo(x + w, y + h, x,     y + h, r);
    this.arcTo(x,     y + h, x,     y,     r);
    this.arcTo(x,     y,     x + w, y,     r);
    this.closePath();
    return this;
  };
}

export class HUD {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.resize();
  }

  resize() {
    this.canvas.width  = window.innerWidth;
    this.canvas.height = window.innerHeight;
    this.W = this.canvas.width;
    this.H = this.canvas.height;
  }

  render(state) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.W, this.H);

    if (!state || (state.gameState !== 'RACING' && state.gameState !== 'FINISH')) return;

    this._drawSpeedometer(state.speed ?? 0);
    this._drawLapInfo(state);
    this._drawPosition(state.racePosition ?? 1, state.totalCars ?? 3);
    this._drawBoostBar(state.boostCharge ?? 0);
    this._drawMinimap(state);
    if (state.debugInput) this._drawDebugInput(state);
  }

  get _isPortrait() { return this.W < 700 && this.H > this.W; }

  // ========== 速度計（右下・アーク型） ==========
  _drawSpeedometer(speed) {
    const ctx  = this.ctx;
    const pm   = this._isPortrait;
    const r    = pm ? 44 : 80;
    const cx   = pm ? this.W / 2 : this.W - 110;
    const cy   = pm ? this.H - 260 : this.H - 110;
    const maxSpeed = 270;
    const speedNorm = Math.min(1, speed / maxSpeed);

    const startAngle = Math.PI * 0.75;
    const endAngle   = Math.PI * 2.25;

    // 背景アーク
    ctx.beginPath();
    ctx.arc(cx, cy, r, startAngle, endAngle);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 14;
    ctx.stroke();

    // 速度アーク（グラデーション）
    if (speedNorm > 0) {
      const grad = ctx.createLinearGradient(cx - r, cy, cx + r, cy);
      grad.addColorStop(0,   '#00ff88');
      grad.addColorStop(0.5, '#ffcc00');
      grad.addColorStop(1,   '#ff4400');

      ctx.beginPath();
      ctx.arc(cx, cy, r, startAngle, startAngle + (endAngle - startAngle) * speedNorm);
      ctx.strokeStyle = grad;
      ctx.lineWidth   = 14;
      ctx.stroke();
    }

    // 目盛り
    for (let i = 0; i <= 10; i++) {
      const a = startAngle + (endAngle - startAngle) * (i / 10);
      const r1 = i % 5 === 0 ? r - 18 : r - 12;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r1,      cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a) * (r - 5), cy + Math.sin(a) * (r - 5));
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = i % 5 === 0 ? 2.5 : 1.5;
      ctx.stroke();
    }

    // 速度数値
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 26px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(Math.floor(speed).toString(), cx, cy);
    ctx.font = '11px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText('km/h', cx, cy + 20);

    // 外枠
    ctx.beginPath();
    ctx.arc(cx, cy, r + 8, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // ========== ラップ情報（左上） ==========
  _drawLapInfo(state) {
    const ctx = this.ctx;
    const pm = this._isPortrait;
    const x = pm ? 8 : 20;
    const y = pm ? 8 : 20;
    const pw = pm ? 170 : 230;
    const ph = pm ? 68 : 90;

    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.roundRect(x, y, pw, ph, 10);
    ctx.fill();

    ctx.fillStyle = '#ffcc00';
    ctx.font = pm ? 'bold 11px sans-serif' : 'bold 14px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('LAP', x + 10, y + 10);

    ctx.fillStyle = '#ffffff';
    ctx.font = pm ? 'bold 22px monospace' : 'bold 32px monospace';
    ctx.fillText(`${state.lapCurrent} / ${state.lapTotal}`, x + (pm ? 40 : 55), y + (pm ? 4 : 6));

    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = pm ? '10px monospace' : '13px monospace';
    ctx.fillText(`TIME  ${this._fmtTime(state.lapTime)}`, x + 10, y + (pm ? 36 : 52));

    const best = state.bestLapTime != null
      ? `BEST  ${this._fmtTime(state.bestLapTime)}`
      : 'BEST  --:--.--';
    ctx.fillStyle = 'rgba(255,200,0,0.8)';
    ctx.fillText(best, x + 10, y + (pm ? 50 : 68));
  }

  // ========== 順位（左上・ラップ下） ==========
  _drawPosition(pos, total) {
    const ctx = this.ctx;
    const pm = this._isPortrait;
    const x = pm ? 8 : 20;
    const y = pm ? 84 : 122;

    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.roundRect(x, y, pm ? 100 : 130, pm ? 40 : 56, 10);
    ctx.fill();

    const colors = ['#ffcc00','#cccccc','#c87433','#ffffff'];
    ctx.fillStyle = colors[Math.min(pos - 1, 3)];
    ctx.font = pm ? 'bold 24px monospace' : 'bold 36px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`P${pos}`, x + 10, y + (pm ? 4 : 6));

    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = pm ? '10px sans-serif' : '13px sans-serif';
    ctx.fillText(`/ ${total}台`, x + (pm ? 50 : 72), y + (pm ? 12 : 20));
  }

  // ========== ブーストゲージ（速度計の上） ==========
  _drawBoostBar(charge) {
    const ctx = this.ctx;
    const pm  = this._isPortrait;
    const bw  = pm ? 100 : 160;
    const bh  = 14;
    const bx  = pm ? (this.W - bw) / 2 : this.W - bw - 40;
    const by  = pm ? this.H - 330 : this.H - 205;

    // ラベル
    ctx.fillStyle = '#00ffff';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('BOOST', bx + bw / 2, by - 2);

    // 背景
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 5);
    ctx.fill();

    // バー
    if (charge > 0) {
      const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
      grad.addColorStop(0, '#00ffff');
      grad.addColorStop(1, '#0088ff');
      ctx.fillStyle = charge > 0.2 ? grad : '#ff4400';
      ctx.beginPath();
      ctx.roundRect(bx, by, bw * charge, bh, 5);
      ctx.fill();
    }

    // 枠
    ctx.strokeStyle = 'rgba(0,255,255,0.4)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 5);
    ctx.stroke();
  }

  // ========== ミニマップ（右上） ==========
  _drawMinimap(state) {
    const ctx = this.ctx;
    const pm   = this._isPortrait;
    const size = pm ? 80 : 150;
    const mx   = this.W - size - (pm ? 8 : 20);
    const my   = pm ? 8 : 20;
    const padding = 12;

    // 背景
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.roundRect(mx, my, size, size, 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // ウェイポイントのバウンディングボックスを計算
    const wps = state.waypointPath;
    if (!wps || wps.length === 0) return;

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    wps.forEach(wp => {
      minX = Math.min(minX, wp.x); maxX = Math.max(maxX, wp.x);
      minZ = Math.min(minZ, wp.z); maxZ = Math.max(maxZ, wp.z);
    });
    const rangeX = maxX - minX || 1;
    const rangeZ = maxZ - minZ || 1;
    const scale  = (size - padding * 2) / Math.max(rangeX, rangeZ);

    const toMap = (wx, wz) => ({
      x: mx + padding + (wx - minX) * scale,
      y: my + padding + (wz - minZ) * scale,
    });

    // コース線
    ctx.beginPath();
    wps.forEach((wp, i) => {
      const p = toMap(wp.x, wp.z);
      i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 3;
    ctx.stroke();

    // 車ドット
    state.allCarPositions.forEach(c => {
      const p = toMap(c.x, c.z);
      ctx.beginPath();
      ctx.arc(p.x, p.y, c.isPlayer ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = c.isPlayer
        ? '#ffffff'
        : `#${c.color.toString(16).padStart(6,'0')}`;
      ctx.fill();
      if (c.isPlayer) {
        ctx.strokeStyle = '#ffcc00';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    });
  }

  // ========== デバッグ入力表示 ==========
  _drawDebugInput(state) {
    const ctx = this.ctx;
    const di = state.debugInput;
    const x = this.W / 2;
    const y = 10;

    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.beginPath();
    ctx.roundRect(x - 120, y, 240, 60, 8);
    ctx.fill();

    ctx.fillStyle = di.steer !== 0 ? '#ff4444' : '#44ff44';
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(`STR:${di.steer.toFixed(2)} THR:${di.throttle.toFixed(1)} BRK:${di.brake.toFixed(1)}`, x, y + 6);

    ctx.fillStyle = '#aaaaaa';
    ctx.font = '11px monospace';
    const actions = state.debugTouchActions?.join(',') || 'none';
    ctx.fillText(`touch:[${actions}]`, x, y + 24);
    ctx.fillText(`touchDev:${state.debugIsTouchDevice}`, x, y + 40);
  }

  // ========== ユーティリティ ==========
  _fmtTime(sec) {
    if (sec == null) return '--:--.--';
    const m  = Math.floor(sec / 60);
    const s  = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 100);
    return `${m}:${String(s).padStart(2,'0')}.${String(ms).padStart(2,'0')}`;
  }
}
