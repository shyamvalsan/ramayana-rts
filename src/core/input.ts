// Input handling: mouse and keyboard. Translates DOM events into selection
// changes and unit commands. Doesn't render anything itself.

import type { Camera } from '@/core/camera';
import type { Game } from '@/core/game';
import type { Entity, TilePos, Vec2 } from '@/core/types';
import { dist } from '@/util/math';
import { TILE_SIZE } from '@/config/constants';
import { BUILDING_DEFS } from '@/config/buildings';
import { UNIT_DEFS } from '@/config/units';

/** Tiles along the line from a→b (Bresenham). Used for drag-laying walls. */
function bresenhamLine(a: TilePos, b: TilePos): TilePos[] {
  const out: TilePos[] = [];
  let x0 = a.tx, y0 = a.ty;
  const x1 = b.tx, y1 = b.ty;
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  // Cap length so an accidental cross-map drag can't try to place 100 walls.
  for (let guard = 0; guard < 80; guard++) {
    out.push({ tx: x0, ty: y0 });
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
  return out;
}

export interface InputState {
  mouseScreen: Vec2;
  mouseWorld: Vec2;
  dragStartScreen: Vec2 | null;
  dragging: boolean;
  hoveredEntity: Entity | null;
  keys: Set<string>;
  /** Last clientX/Y while a middle-mouse-button pan drag is active. */
  panDragLast: { x: number; y: number } | null;
  /** Armed command consumed by the next left-click (A = attack-move). */
  pendingCommand: 'attackMove' | null;
  /** Double-tap detection for control-group camera jumps. */
  lastGroupKey: string | null;
  lastGroupKeyAt: number;
}

const DRAG_THRESHOLD_PX = 5;

export function makeInput(): InputState {
  return {
    mouseScreen: { x: -9999, y: -9999 },
    mouseWorld: { x: 0, y: 0 },
    dragStartScreen: null,
    dragging: false,
    hoveredEntity: null,
    keys: new Set(),
    panDragLast: null,
    pendingCommand: null,
    lastGroupKey: null,
    lastGroupKeyAt: 0,
  };
}

export function attachInput(
  canvas: HTMLCanvasElement,
  gameRef: { current: Game },
  camera: Camera,
  input: InputState,
  onUiEvent: (e: { kind: string } & Record<string, unknown>) => void,
) {
  // Resolve the current game on every event so newGame() reassignments are picked up.
  const G = () => gameRef.current;
  const recomputeMouseWorld = () => {
    input.mouseWorld = camera.screenToWorld(input.mouseScreen.x, input.mouseScreen.y);
    const hov = pickEntity(G(), input.mouseWorld);
    input.hoveredEntity = hov;
    // Decide the cursor class based on (a) whether we have a player unit
    // selected and (b) what the cursor is hovering. Three cursor states:
    //   .casting   — ability being cast (set elsewhere)
    //   .aim-enemy — red crosshair on hostile targets
    //   .aim-ally  — gold ring on friendlies (force-attack with Ctrl)
    //   (default) — normal pointer
    if (canvas.classList.contains('casting')) return; // casting overrides
    let nextClass = '';
    if (G().selectedIds.size > 0 && hov && !hov.dead) {
      const someSelectedIsPlayer = Array.from(G().selectedIds).some((id) => {
        const e = G().entities.get(id);
        return e?.kind === 'unit' && e.owner === 1;
      });
      if (someSelectedIsPlayer) {
        if (hov.owner === 2 || hov.typeId === 'deer') nextClass = 'aim-enemy';
        else if (hov.owner === 1 && hov.kind === 'unit') nextClass = 'aim-ally';
      }
    }
    canvas.classList.toggle('aim-enemy', nextClass === 'aim-enemy');
    canvas.classList.toggle('aim-ally', nextClass === 'aim-ally');
  };

  // Track the mouse position relative to the canvas even when it leaves the
  // canvas rect (e.g. moves over the top/bottom UI bars). This lets edge-pan
  // continue to drive the camera when the player drags their cursor toward
  // the window edge. We translate window coords to canvas coords on every
  // mousemove on the WINDOW (not just the canvas).
  window.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    input.mouseScreen.x = e.clientX - r.left;
    input.mouseScreen.y = e.clientY - r.top;
    recomputeMouseWorld();
    if (input.dragStartScreen && !input.dragging) {
      const dx = input.mouseScreen.x - input.dragStartScreen.x;
      const dy = input.mouseScreen.y - input.dragStartScreen.y;
      if (dx * dx + dy * dy >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
        input.dragging = true;
      }
    }
  });

  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0) {
      input.dragStartScreen = { x: input.mouseScreen.x, y: input.mouseScreen.y };
      input.dragging = false;
    } else if (e.button === 1) {
      // Middle-click drag: pan the camera. AoE2 standard.
      e.preventDefault();
      input.panDragLast = { x: e.clientX, y: e.clientY };
    }
  });

  // Middle-mouse-button drag panning. We track at window level so the drag
  // continues even if the cursor strays off the canvas.
  window.addEventListener('mousemove', (e) => {
    if (input.panDragLast) {
      const dx = e.clientX - input.panDragLast.x;
      const dy = e.clientY - input.panDragLast.y;
      input.panDragLast.x = e.clientX;
      input.panDragLast.y = e.clientY;
      // Negative because moving the mouse right should reveal what's right —
      // i.e. the world should shift LEFT under the cursor → camera goes right.
      camera.pan(-dx, -dy);
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (e.button === 1) input.panDragLast = null;
  });

  canvas.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;
    const game = G();
    recomputeMouseWorld();
    // Ability cast mode: emit a `world-click` event so main.ts can fire the
    // ability at the clicked world position. We hand control back without
    // running the standard selection logic.
    if (canvas.classList.contains('casting')) {
      onUiEvent({ kind: 'world-click', worldPos: { ...input.mouseWorld } });
      input.dragStartScreen = null;
      input.dragging = false;
      return;
    }
    // Armed attack-move (A key or HUD button): this click is the target.
    if (input.pendingCommand === 'attackMove') {
      for (const id of game.selectedIds) {
        const u = game.entities.get(id);
        if (!u || u.dead || u.owner !== 1 || u.kind !== 'unit') continue;
        game.issueCommand(u, { kind: 'attackMove', pos: { ...input.mouseWorld } }, { queue: input.keys.has('shift') });
      }
      input.pendingCommand = null;
      canvas.classList.remove('priming');
      input.dragStartScreen = null;
      input.dragging = false;
      return;
    }
    // Building placement consumes the left click (placement takes precedence
    // over box-select, so a drag with a wall pending lays a line, not a box).
    if (game.pendingPlacement) {
      const typeId = game.pendingPlacement.typeId;
      const def = BUILDING_DEFS[typeId];
      if (def) {
        const endTile: TilePos = {
          tx: Math.floor(input.mouseWorld.x / TILE_SIZE),
          ty: Math.floor(input.mouseWorld.y / TILE_SIZE),
        };
        // Walls (1x1) support drag-to-lay a straight line; everything else is
        // a single placement at the release tile.
        const wallDrag = typeId === 'wall' && input.dragging && input.dragStartScreen;
        const tiles: TilePos[] = [];
        if (wallDrag) {
          const w0 = camera.screenToWorld(input.dragStartScreen!.x, input.dragStartScreen!.y);
          const startTile: TilePos = {
            tx: Math.floor(w0.x / TILE_SIZE),
            ty: Math.floor(w0.y / TILE_SIZE),
          };
          tiles.push(...bresenhamLine(startTile, endTile));
        } else {
          tiles.push(endTile);
        }
        // Build each site; assign every selected villager to build them in
        // sequence (first site replaces their orders, the rest queue).
        const builders = Array.from(game.selectedIds)
          .map(id => game.entities.get(id))
          .filter((u): u is Entity => !!u && u.kind === 'unit' && u.owner === 1
            && !!UNIT_DEFS[u.typeId]?.canBuild);
        let siteIdx = 0;
        for (const t of tiles) {
          // Silent for line drags — most tiles legitimately fail (occupied /
          // out of stone) and we don't want a toast storm.
          const site = game.tryStartConstruction(typeId, t, tiles.length > 1);
          if (!site) continue;
          for (const u of builders) {
            game.issueCommand(u, { kind: 'build', targetId: site.id }, { queue: siteIdx > 0 });
          }
          siteIdx++;
        }
        // Shift held keeps placement armed to chain more; a completed wall
        // drag ends it (shift on a wall drag re-arms for another line).
        if (!input.keys.has('shift')) {
          game.pendingPlacement = null;
          onUiEvent({ kind: 'placement-end' });
        }
        input.dragStartScreen = null;
        input.dragging = false;
        return;
      }
    }
    if (input.dragging && input.dragStartScreen) {
      const w1 = camera.screenToWorld(input.dragStartScreen.x, input.dragStartScreen.y);
      const w2 = input.mouseWorld;
      const picked = unitsInBox(G(), w1, w2, 1);
      game.selectedIds.clear();
      for (const u of picked) game.selectedIds.add(u.id);
    } else {
      const target = pickEntity(G(), input.mouseWorld);
      game.selectedIds.clear();
      if (target && target.owner === 1 && target.selectable) {
        game.selectedIds.add(target.id);
      } else if (target && target.kind === 'resource') {
        // Selecting a resource node is fine for inspection only.
        game.selectedIds.add(target.id);
      } else if (target && target.kind === 'building' && target.owner === 1) {
        game.selectedIds.add(target.id);
      }
    }
    input.dragStartScreen = null;
    input.dragging = false;
    onUiEvent({ kind: 'selection-changed' });
  });

  // Double-click a unit: select every visible unit of the same type.
  canvas.addEventListener('dblclick', (e) => {
    if (e.button !== 0) return;
    const game = G();
    recomputeMouseWorld();
    const target = pickEntity(game, input.mouseWorld);
    if (!target || target.owner !== 1 || target.kind !== 'unit') return;
    const topLeft = camera.screenToWorld(0, 0);
    const bottomRight = camera.screenToWorld(camera.viewW, camera.viewH);
    game.selectedIds.clear();
    for (const u of game.entities.values()) {
      if (u.dead || u.kind !== 'unit' || u.owner !== 1 || u.typeId !== target.typeId) continue;
      if (u.pos.x < topLeft.x - 32 || u.pos.x > bottomRight.x + 32) continue;
      if (u.pos.y < topLeft.y - 64 || u.pos.y > bottomRight.y + 64) continue;
      game.selectedIds.add(u.id);
    }
    onUiEvent({ kind: 'selection-changed' });
  });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const game = G();
    recomputeMouseWorld();
    if (game.pendingPlacement) {
      game.pendingPlacement = null;
      onUiEvent({ kind: 'placement-end' });
      return;
    }
    // Ctrl (or Cmd on macOS) = force attack: works even on friendly units
    // and rishis. Killing them is on you.
    const forceAttack = e.ctrlKey || e.metaKey;
    issueRightClick(G(), input, forceAttack);
  });

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    input.keys.add(k);
    const game = G();
    // Hotkeys.
    if (k === 'b') {
      // Quick build menu trigger.
      onUiEvent({ kind: 'toggle-build-menu' });
    }
    if (k === 'a' && !e.ctrlKey && !e.metaKey) {
      // Arm attack-move: the next left-click is the target location.
      const hasUnits = Array.from(game.selectedIds).some(id => {
        const u = game.entities.get(id);
        return u?.kind === 'unit' && u.owner === 1 && !u.dead;
      });
      if (hasUnits) {
        input.pendingCommand = 'attackMove';
        canvas.classList.add('priming');
      }
    }
    // Control groups: Ctrl+1..9 assigns the selection; 1..9 recalls it;
    // double-tap jumps the camera to the group.
    if (k >= '1' && k <= '9') {
      const slot = Number(k);
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        game.controlGroups[slot] = Array.from(game.selectedIds);
      } else {
        const members = (game.controlGroups[slot] ?? [])
          .map(id => game.entities.get(id))
          .filter((u): u is Entity => !!u && !u.dead);
        if (members.length > 0) {
          game.selectedIds.clear();
          for (const u of members) game.selectedIds.add(u.id);
          const now = performance.now();
          if (input.lastGroupKey === k && now - input.lastGroupKeyAt < 400) {
            // Double-tap: center the camera on the group.
            let cx = 0, cy = 0;
            for (const u of members) { cx += u.pos.x; cy += u.pos.y; }
            camera.centerOn({ x: cx / members.length, y: cy / members.length });
          }
          input.lastGroupKey = k;
          input.lastGroupKeyAt = now;
          onUiEvent({ kind: 'selection-changed' });
        }
      }
    }
    if (k === 'h') {
      // Center camera on the base anchor: Yajna (mission) or town center.
      let fallback: { x: number; y: number } | null = null;
      for (const ent of game.entities.values()) {
        if (ent.kind !== 'building' || ent.owner !== 1 || ent.dead) continue;
        if (ent.typeId === 'yajna' || ent.typeId === 'town_center') {
          camera.centerOn(ent.pos);
          fallback = null;
          break;
        }
        fallback ??= ent.pos;
      }
      if (fallback) camera.centerOn(fallback);
    }
    if (k === 'escape') {
      if (canvas.classList.contains('casting')) {
        onUiEvent({ kind: 'cancel-cast' });
        return;
      }
      if (input.pendingCommand) {
        input.pendingCommand = null;
        canvas.classList.remove('priming');
        return;
      }
      game.pendingPlacement = null;
      game.selectedIds.clear();
      onUiEvent({ kind: 'placement-end' });
      onUiEvent({ kind: 'selection-changed' });
    }
    if (k === '.' && e.shiftKey) {
      // Cycle to next idle villager.
      cycleIdleVillager(G(), camera);
      onUiEvent({ kind: 'selection-changed' });
    }
    if (k === 'm') onUiEvent({ kind: 'toggle-minimap' });
    if (k === 'f1' || k === '?' || (k === '/' && e.shiftKey)) onUiEvent({ kind: 'toggle-help' });
    if ((k === 'p' || k === ' ') && !e.repeat) onUiEvent({ kind: 'toggle-pause' });
  });

  window.addEventListener('keyup', (e) => {
    input.keys.delete(e.key.toLowerCase());
  });
}

function pickEntity(game: Game, p: Vec2): Entity | null {
  // Units render upright in screen space anchored at their feet (e.pos.y).
  // A click on the head should still hit the unit, so we extend the hit-box
  // upward in world coords by `headExtent` (matches the rendered sprite
  // height divided by ISO_Y_SCALE to project back to world Y).
  const headExtent = 64;       // world Y units above the feet that the sprite occupies
  const widePick = 14;         // half-width slack in world X for chunkier hit-boxes
  let best: Entity | null = null;
  let bestScore = -Infinity;
  for (const e of game.entities.values()) {
    if (e.dead || !e.selectable) continue;
    if (e.kind === 'unit') {
      const dx = Math.abs(p.x - e.pos.x);
      const dy = p.y - e.pos.y; // positive means click is below the feet
      const withinX = dx <= widePick;
      const withinY = dy <= 8 && dy >= -headExtent;
      if (withinX && withinY) {
        // Prefer the unit whose feet are closest to the click vertically —
        // gives the front-most unit precedence in a stack.
        const score = 1000 - Math.abs(dy);
        if (score > bestScore) { best = e; bestScore = score; }
      }
    } else if (e.tilePos && e.sizeTiles) {
      const x0 = e.tilePos.tx * TILE_SIZE;
      const y0 = e.tilePos.ty * TILE_SIZE;
      const w = e.sizeTiles.w * TILE_SIZE;
      const h = e.sizeTiles.h * TILE_SIZE;
      if (p.x >= x0 && p.x < x0 + w && p.y >= y0 && p.y < y0 + h) {
        const score = e.kind === 'resource' ? 500 : 100;
        if (score > bestScore) { best = e; bestScore = score; }
      }
    }
  }
  return best;
}

function unitsInBox(game: Game, w1: Vec2, w2: Vec2, owner: number): Entity[] {
  const lx = Math.min(w1.x, w2.x), rx = Math.max(w1.x, w2.x);
  const ty = Math.min(w1.y, w2.y), by = Math.max(w1.y, w2.y);
  // Expand the box upward to include units whose visible sprite extends above
  // their feet position. Without this, dragging a tight box around a row of
  // visible villagers wouldn't include them.
  const tyExpanded = ty - 64;
  const picked: Entity[] = [];
  for (const e of game.entities.values()) {
    if (e.dead || e.kind !== 'unit' || e.owner !== owner) continue;
    // Protected VIPs (sages) are defended, not commanded — never box-selected.
    if (UNIT_DEFS[e.typeId]?.noBoxSelect) continue;
    if (e.pos.x >= lx && e.pos.x <= rx && e.pos.y >= tyExpanded && e.pos.y <= by) picked.push(e);
  }
  return picked;
}

function issueRightClick(game: Game, input: InputState, forceAttack = false) {
  if (game.selectedIds.size === 0) return;
  const target = pickEntity(game, input.mouseWorld);
  // Shift-right-click queues the command after the unit's current task.
  const queue = input.keys.has('shift');
  // Sort by current position (row-major) so grid slots don't cross paths.
  const units = Array.from(game.selectedIds)
    .map(id => game.entities.get(id))
    .filter((u): u is Entity => !!u && !u.dead && u.owner === 1)
    .sort((a, b) => (a.pos.y - b.pos.y) || (a.pos.x - b.pos.x));
  const formationOffsets = computeFormationOffsets(units.filter(u => u.kind === 'unit').length);

  let slot = 0;
  for (const u of units) {
    if (u.kind === 'unit') {
      const i = slot++;
      if (target && target.kind === 'resource' && (target.resourceRemaining ?? 0) > 0) {
        game.issueCommand(u, { kind: 'gather', targetId: target.id }, { queue });
      } else if (target && target.kind === 'building' && target.isConstructionSite && target.owner === 1) {
        game.issueCommand(u, { kind: 'build', targetId: target.id }, { queue });
      } else if (target && target.owner === 2) {
        // Hostile entity → attack.
        game.issueCommand(u, { kind: 'attack', targetId: target.id }, { queue });
      } else if (target && (target.typeId === 'deer' || target.typeId === 'golden_deer')) {
        // Deer (gaia wildlife) → hunt.
        game.issueCommand(u, { kind: 'attack', targetId: target.id }, { queue });
      } else if (forceAttack && target && target.id !== u.id) {
        // Ctrl-right-click → force attack anything (friendly fire included).
        game.issueCommand(u, { kind: 'attack', targetId: target.id }, { queue });
        if (target.owner === 1) {
          game.notify('Friendly fire! Stop — that is your own side.');
        }
      } else {
        // Default: move in grid formation around the click point.
        const off = formationOffsets[i];
        const pos = { x: input.mouseWorld.x + off.x, y: input.mouseWorld.y + off.y };
        game.issueCommand(u, { kind: 'move', pos }, { queue });
      }
    } else if (u.kind === 'building') {
      u.rallyPoint = { ...input.mouseWorld };
    }
  }
}

// Returns N offsets (in pixels) arranging a group as a compact grid around
// the click point, row-major — matches the row-major position sort of the
// selection so units keep their relative order and don't cross paths.
function computeFormationOffsets(n: number): { x: number; y: number }[] {
  if (n <= 1) return [{ x: 0, y: 0 }];
  const spacing = 30;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const rowCount = r === rows - 1 ? n - r * cols : cols; // center the last row
    out.push({
      x: (c - (rowCount - 1) / 2) * spacing,
      y: (r - (rows - 1) / 2) * spacing,
    });
  }
  return out;
}

function cycleIdleVillager(game: Game, camera: Camera) {
  const idle: Entity[] = [];
  for (const e of game.entities.values()) {
    if (e.kind === 'unit' && e.owner === 1 && e.typeId === 'villager' && !e.dead) {
      if (!e.state || e.state.kind === 'idle') idle.push(e);
    }
  }
  if (idle.length === 0) return;
  // Pick the one not currently selected.
  let target = idle[0];
  if (game.selectedIds.size === 1) {
    const sel = idle.findIndex(e => game.selectedIds.has(e.id));
    if (sel !== -1) target = idle[(sel + 1) % idle.length];
  }
  game.selectedIds.clear();
  game.selectedIds.add(target.id);
  camera.centerOn(target.pos);
}
