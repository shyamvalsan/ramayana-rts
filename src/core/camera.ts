import {
  CAMERA_PAN_SPEED,
  CAMERA_EDGE_PAN_MARGIN,
  ISO_Y_SCALE,
  MAP_W,
  MAP_H,
} from '@/config/constants';
import { clamp } from '@/util/math';
import type { Vec2 } from '@/core/types';

export class Camera {
  x = 0;
  y = 0;
  viewW = 800;
  viewH = 600;
  zoom = 1;
  // Velocity smoothing for pan: we accelerate toward the desired direction
  // and decelerate when the input drops. Prevents jitter when nudging the
  // mouse near the edge zone.
  private vx = 0;
  private vy = 0;

  resize(w: number, h: number) {
    this.viewW = w;
    this.viewH = h;
    this.clamp();
  }

  centerOn(target: Vec2) {
    this.x = target.x - this.viewW / 2;
    this.y = target.y - this.viewH / (2 * ISO_Y_SCALE);
    this.clamp();
  }

  pan(dx: number, dy: number) {
    this.x += dx;
    this.y += dy;
    this.clamp();
  }

  update(
    dt: number,
    keys: Set<string>,
    mouseX: number,
    mouseY: number,
    edgePan: boolean,
  ) {
    // Target velocity from inputs (px/sec, not yet multiplied by dt).
    let tvx = 0, tvy = 0;
    if (keys.has('arrowleft') || keys.has('a')) tvx -= CAMERA_PAN_SPEED;
    if (keys.has('arrowright') || keys.has('d')) tvx += CAMERA_PAN_SPEED;
    if (keys.has('arrowup') || keys.has('w')) tvy -= CAMERA_PAN_SPEED;
    if (keys.has('arrowdown') || keys.has('s')) tvy += CAMERA_PAN_SPEED;
    if (edgePan) {
      // Edge-pan based on mouse position relative to the canvas. We let the
      // mouse extend outside the canvas (negative or > viewW/viewH) so that
      // dragging the cursor over a UI bar or to the window edge still pans —
      // and pans FASTER the further out you push. This matches AoE's feel
      // where shoving the cursor at the edge of the screen scrolls quickly.
      const m = CAMERA_EDGE_PAN_MARGIN;
      // Skip if the mouse is far outside the canvas (e.g. another monitor).
      const outOfRange = mouseX < -200 || mouseX > this.viewW + 200 || mouseY < -200 || mouseY > this.viewH + 200;
      if (!outOfRange) {
        if (mouseX < m)             tvx -= CAMERA_PAN_SPEED * Math.min(1.5, (m - mouseX) / m);
        else if (mouseX > this.viewW - m) tvx += CAMERA_PAN_SPEED * Math.min(1.5, (mouseX - (this.viewW - m)) / m);
        if (mouseY < m)             tvy -= CAMERA_PAN_SPEED * Math.min(1.5, (m - mouseY) / m);
        else if (mouseY > this.viewH - m) tvy += CAMERA_PAN_SPEED * Math.min(1.5, (mouseY - (this.viewH - m)) / m);
      }
    }
    // Lerp current velocity toward target (acceleration). Larger k = snappier.
    const k = 16;
    const t = Math.min(1, k * dt);
    this.vx = this.vx + (tvx - this.vx) * t;
    this.vy = this.vy + (tvy - this.vy) * t;
    // Snap tiny velocities to zero so we don't drift.
    if (Math.abs(this.vx) < 1) this.vx = 0;
    if (Math.abs(this.vy) < 1) this.vy = 0;
    if (this.vx || this.vy) this.pan(this.vx * dt, this.vy * dt);
  }

  worldToScreen(p: Vec2): Vec2 {
    return {
      x: (p.x - this.x) * this.zoom,
      y: (p.y - this.y) * this.zoom * ISO_Y_SCALE,
    };
  }

  screenToWorld(sx: number, sy: number): Vec2 {
    return {
      x: sx / this.zoom + this.x,
      y: (sy / this.zoom) / ISO_Y_SCALE + this.y,
    };
  }

  private clamp() {
    const maxX = Math.max(0, MAP_W - this.viewW / this.zoom);
    const maxY = Math.max(0, MAP_H - (this.viewH / this.zoom) / ISO_Y_SCALE);
    this.x = clamp(this.x, 0, maxX);
    this.y = clamp(this.y, 0, maxY);
  }
}
