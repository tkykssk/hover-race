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
  }

  // ========== 速度計（右下・アーク型） ==========
  _drawSpeedometer(speed) {
    const ctx  = this.ctx;
    const cx   = this.W - 110;
    const cy   = this.H - 110;
    const r    = 80;
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
    const x = 20, y = 20;

    // 背景パネル
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.roundRect(x, y, 230, 90, 10);
    ctx.fill();

    // ラップ
    ctx.fillStyle = '#ffcc00';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('LAP', x + 12, y + 12);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 32px monospace';
    ctx.fillText(`${state.lapCurrent} / ${state.lapTotal}`, x + 55, y + 6);

    // タイム
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '13px monospace';
    ctx.fillText(`TIME  ${this._fmtTime(state.lapTime)}`, x + 12, y + 52);

    const best = state.bestLapTime != null
      ? `BEST  ${this._fmtTime(state.bestLapTime)}`
      : 'BEST  --:--.--';
    ctx.fillStyle = 'rgba(255,200,0,0.8)';
    ctx.fillText(best, x + 12, y + 68);
  }

  // ========== 順位（左上・ラップ下） ==========
  _drawPosition(pos, total) {
    const ctx = this.ctx;
    const x = 20, y = 122;

    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.roundRect(x, y, 130, 56, 10);
    ctx.fill();

    const colors = ['#ffcc00','#cccccc','#c87433','#ffffff'];
    ctx.fillStyle = colors[Math.min(pos - 1, 3)];
    ctx.font = 'bold 36px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`P${pos}`, x + 12, y + 6);

    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '13px sans-serif';
    ctx.fillText(`/ ${total}台`, x + 72, y + 20);
  }

  // ========== ブーストゲージ（速度計の上） ==========
  _drawBoostBar(charge) {
    const ctx = this.ctx;
    const bw  = 160, bh = 18;
    const bx  = this.W - bw - 40;
    const by  = this.H - 205;

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
    const size  = 150;
    const mx = this.W - size - 20;
    const my = 20;
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

  // ========== ユーティリティ ==========
  _fmtTime(sec) {
    if (sec == null) return '--:--.--';
    const m  = Math.floor(sec / 60);
    const s  = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 100);
    return `${m}:${String(s).padStart(2,'0')}.${String(ms).padStart(2,'0')}`;
  }
}
