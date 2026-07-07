// Mini-map widget. A small canvas in the top-right that shows the whole world
// at reduced scale: terrain color, fog state, entity dots (player blue, enemy
// red, neutral resources brown). The current viewport is drawn as a rectangle.
// Click-to-jump pans the main camera. Right-click sets a rally point for
// selected production buildings.

import { ISO_Y_SCALE, MAP_TILES_X, MAP_TILES_Y, TILE_SIZE } from '@/config/constants';
import type { Camera } from '@/core/camera';
import type { Game } from '@/core/game';
import { VIS_EXPLORED, VIS_UNSEEN, VIS_VISIBLE } from '@/core/fog';

export interface MiniMapOpts {
  game: Game;
  camera: Camera;
  size?: number;     // pixel size of the widest edge
  onJumpTo: (worldX: number, worldY: number) => void;
}

export class MiniMap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private opts: MiniMapOpts;
  private root: HTMLElement;
  // Map aspect ratio: world is MAP_TILES_X × MAP_TILES_Y tiles.
  private tilePx: number;
  private mw: number;
  private mh: number;
  visible = true;

  constructor(root: HTMLElement, opts: MiniMapOpts) {
    this.root = root;
    this.opts = opts;
    const target = opts.size ?? 200;
    // Make the mini-map dimensions reflect the world aspect.
    const aspect = MAP_TILES_X / MAP_TILES_Y;
    this.mw = Math.round(target);
    this.mh = Math.round(target / aspect);
    this.tilePx = this.mw / MAP_TILES_X;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'minimap';
    this.canvas.width = this.mw;
    this.canvas.height = this.mh;
    this.canvas.style.width = `${this.mw}px`;
    this.canvas.style.height = `${this.mh}px`;
    this.ctx = this.canvas.getContext('2d')!;

    this.canvas.addEventListener('mousedown', (e) => this.handleClick(e));
    this.canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); this.handleClick(e, true); });
    // Replace any prior minimap in the slot.
    this.root.innerHTML = '';
    this.root.appendChild(this.canvas);
  }

  setVisible(v: boolean) {
    this.visible = v;
    this.canvas.style.display = v ? '' : 'none';
  }

  toggle() { this.setVisible(!this.visible); }

  update() {
    if (!this.visible) return;
    const g = this.opts.game;
    const cx = this.ctx;
    cx.fillStyle = '#0a0f14';
    cx.fillRect(0, 0, this.mw, this.mh);
    // Tile colors (terrain) + fog dimming.
    const tp = this.tilePx;
    for (let ty = 0; ty < MAP_TILES_Y; ty++) {
      for (let tx = 0; tx < MAP_TILES_X; tx++) {
        const t = g.world.terrain[ty * MAP_TILES_X + tx];
        const blocker = g.world.blocker[ty * MAP_TILES_X + tx];
        const fog = g.fogEnabled ? g.fog.vis[ty * MAP_TILES_X + tx] : VIS_VISIBLE;
        if (fog === VIS_UNSEEN) {
          cx.fillStyle = '#000000';
        } else {
          let color: string;
          if (t === 2) color = '#1e3a52';                  // water
          else if (t === 1) color = '#6b5a3a';             // dirt
          else color = '#3d6b3a';                          // grass
          if (blocker !== 0) {
            // A blocker means a building, tree, or resource node. Pull the
            // entity to pick a more descriptive color.
            const ent = g.entities.get(blocker);
            if (ent) {
              if (ent.kind === 'resource') {
                if (ent.typeId === 'tree') color = '#2b4a2b';
                else if (ent.typeId === 'berry_bush') color = '#7a3a3a';
                else if (ent.typeId === 'gold_vein') color = '#d4af4a';
                else if (ent.typeId === 'stone_vein') color = '#9aa4ae';
              } else if (ent.typeId === 'wall' || ent.typeId === 'gate') {
                // Stone barriers read as light grey so wall rings are legible.
                color = ent.owner === 1 ? '#c8ced4' : '#8a8078';
              }
              // Other buildings draw as bright dots after the terrain pass.
            }
          }
          cx.fillStyle = color;
          if (fog === VIS_EXPLORED) {
            // Dim explored tiles slightly.
            cx.globalAlpha = 0.55;
          }
        }
        cx.fillRect(tx * tp, ty * tp, Math.ceil(tp), Math.ceil(tp));
        cx.globalAlpha = 1;
      }
    }
    // Entity dots.
    for (const e of g.entities.values()) {
      if (e.dead) continue;
      const tx = e.pos.x / TILE_SIZE;
      const ty = e.pos.y / TILE_SIZE;
      const px = tx * tp;
      const py = ty * tp;
      if (g.fogEnabled) {
        const v = g.fog.vis[Math.floor(ty) * MAP_TILES_X + Math.floor(tx)];
        if (e.owner !== 1 && v !== VIS_VISIBLE && !(e.kind === 'building' && v === VIS_EXPLORED)) continue;
        if (e.owner === 0 && v === VIS_UNSEEN) continue;
      }
      if (e.owner === 1) {
        cx.fillStyle = e.kind === 'building' ? '#4a9bff' : '#9ec6ff';
        const r = e.kind === 'building' ? 3 : 1.5;
        cx.fillRect(px - r / 2, py - r / 2, r, r);
      } else if (e.owner === 2) {
        cx.fillStyle = e.kind === 'building' ? '#d04040' : '#ff7878';
        const r = e.kind === 'building' ? 3 : 1.5;
        cx.fillRect(px - r / 2, py - r / 2, r, r);
      }
    }
    // Viewport rect.
    const cam = this.opts.camera;
    const vx0 = (cam.x / TILE_SIZE) * tp;
    const vy0 = (cam.y / TILE_SIZE) * tp;
    const vw = ((cam.viewW / cam.zoom) / TILE_SIZE) * tp;
    const vh = (((cam.viewH / cam.zoom) / ISO_Y_SCALE) / TILE_SIZE) * tp;
    cx.strokeStyle = '#f0c850';
    cx.lineWidth = 1;
    cx.strokeRect(vx0, vy0, vw, vh);
  }

  private handleClick(e: MouseEvent, right = false) {
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const tx = px / this.tilePx;
    const ty = py / this.tilePx;
    const wx = tx * TILE_SIZE;
    const wy = ty * TILE_SIZE;
    if (!right) this.opts.onJumpTo(wx, wy);
  }
}
