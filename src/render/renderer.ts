// Main canvas renderer. Painterly top-down style: layered shapes with light/
// dark sides for depth, soft shadows on units, thatch-roof buildings,
// decorated grass terrain with rocks/flowers, animated walk cycles, and
// arrow projectile trails.
//
// Draw order (back to front):
//   1. Terrain base tiles
//   2. Terrain decorations (grass tufts, flowers, pebbles)
//   3. Water animation (last layer of terrain)
//   4. Building shadows
//   5. Resources (trees, bushes, ore)
//   6. Buildings
//   7. Units (z-sorted by y)
//   8. Projectiles (arrows in flight)
//   9. Death puffs
//  10. Selection rings
//  11. Placement ghost
//  12. Health bars / status glyphs
//  13. Screen-space drag box + rally markers

import { COLORS, ISO_Y_SCALE, TILE_SIZE } from '@/config/constants';
import { BUILDING_DEFS } from '@/config/buildings';
import { RESOURCE_DEFS } from '@/config/resources';
import { UNIT_DEFS } from '@/config/units';
import type { Camera } from '@/core/camera';
import type { Game, HitFlashFX } from '@/core/game';
import type { Entity, EntityId, Vec2 } from '@/core/types';
import { buildingSpriteKey, buildingTileSpriteKey, getSprite, getTerrainTile, resourceSpriteKey, unitActionSprite, unitDirectionalSprite, unitTopdownSpriteKey } from '@/render/sprites';
import { VIS_EXPLORED, VIS_UNSEEN, VIS_VISIBLE } from '@/core/fog';

export interface RendererInput {
  game: Game;
  camera: Camera;
  ctx: CanvasRenderingContext2D;
  mouseScreen: Vec2;
  mouseWorld: Vec2;
  dragStartScreen: Vec2 | null;
  dragging: boolean;
  hoveredEntity: Entity | null;
}

export function render(input: RendererInput) {
  const { ctx, camera } = input;
  ctx.save();
  ctx.fillStyle = '#0a0f14';
  ctx.fillRect(0, 0, camera.viewW, camera.viewH);

  // World transform stack:
  //   Outer: scale(zoom) * translate(-cam) + shake — camera-only.
  //   Inner: translate * scale(1, ISO_Y_SCALE) — Y squish for the ground plane.
  ctx.scale(camera.zoom, camera.zoom);
  // Camera shake: random jitter scaled to current amplitude.
  const shake = input.game.cameraShake;
  const shakeX = shake > 0 ? (Math.random() - 0.5) * shake : 0;
  const shakeY = shake > 0 ? (Math.random() - 0.5) * shake : 0;
  ctx.translate(-camera.x + shakeX, -camera.y + shakeY);

  ctx.save();
  ctx.translate(0, camera.y * (1 - ISO_Y_SCALE));
  ctx.scale(1, ISO_Y_SCALE);

  drawTerrainBase(input);
  drawTerrainDecorations(input);
  drawWaterEdges(input);

  const fog = input.game.fog;
  const fogOn = input.game.fogEnabled;
  const drawables: Entity[] = [];
  // Single pass over entities: collect drawables (fog-gated) and find the boss
  // so drawBossHpBar doesn't have to walk every entity again per frame.
  // "Major" bosses (def.bossTier) get the top HP bar; a live one wins over a
  // fading corpse.
  let boss: Entity | null = null;
  for (const e of input.game.entities.values()) {
    if (UNIT_DEFS[e.typeId]?.bossTier === 'major' && (!boss || (boss.dead && !e.dead))) boss = e;
    if (!fogOn) { drawables.push(e); continue; }
    const tx = Math.floor(e.pos.x / TILE_SIZE);
    const ty = Math.floor(e.pos.y / TILE_SIZE);
    const v = fog.get(tx, ty);
    if (e.owner === 1) { drawables.push(e); continue; }
    if (e.kind === 'unit' && v !== VIS_VISIBLE) continue;
    if (v === VIS_UNSEEN) continue;
    drawables.push(e);
  }
  drawables.sort((a, b) => a.pos.y - b.pos.y);

  // Hoisted hit-flash lookup: one pass over the (short) flash list instead of
  // a .find() per unit per frame.
  const hitFlashById = new Map<EntityId, HitFlashFX>();
  for (const h of input.game.hitFlashes) hitFlashById.set(h.entityId, h);

  // Ground-plane entities first (squished). Shadows + resources + buildings.
  for (const e of drawables) drawEntityShadow(input, e);
  for (const e of drawables) {
    if (e.kind === 'resource') drawResourceNode(input, e);
    else if (e.kind === 'building') drawBuilding(input, e);
  }
  drawFogOfWar(input);
  ctx.restore(); // undo iso squish — back to camera-only

  // Units in camera-only space (no Y squish): translate world pos through
  // iso manually so they sit on the iso ground but stay upright + full-sized.
  for (const e of drawables) {
    if (e.kind !== 'unit') continue;
    drawUnitUpright(input, e, hitFlashById.get(e.id));
  }

  drawProjectiles(input);
  drawBeams(input);
  drawDeathPuffs(input);
  drawSelectionRings(input);
  drawPlacementGhost(input);
  drawHealthBars(input);
  drawFlyingNumbers(input);
  drawBirds(input);

  ctx.restore(); // undo camera transform

  // Screen-space overlays.
  drawDragBox(input);
  drawRallyMarkers(input);
  drawBossHpBar(input, boss);
  drawWaveAlert(input);
}

function drawBossHpBar(input: RendererInput, boss: Entity | null) {
  const { ctx, camera, game } = input;
  // The major boss is found once per frame in render(). Show the bar from the
  // moment they spawn until either they die or the death fade completes.
  if (!boss) return;
  // Fade out after death. Corpses are reaped 1.0s after deathAt, so the fade
  // must complete within that window.
  let alpha = 1;
  if (boss.dead) {
    const since = game.simTime - (boss.deathAt ?? game.simTime);
    alpha = Math.max(0, 1 - since / 1.0);
    if (alpha <= 0) return;
  }
  const name = (UNIT_DEFS[boss.typeId]?.name ?? boss.typeId).toUpperCase();
  // The enrage phase belongs to Tataka's script; other bosses ignore it.
  const enraged = boss.typeId === 'tataka' && game.bossPhase === 2;
  const bw = Math.min(720, camera.viewW * 0.6);
  const bh = 28;
  const bx = (camera.viewW - bw) / 2;
  const by = 16;
  ctx.save();
  ctx.globalAlpha = alpha;
  // Background.
  ctx.fillStyle = 'rgba(20, 8, 6, 0.92)';
  ctx.fillRect(bx, by, bw, bh);
  // HP fill — red, with a faint glow.
  const hpPct = Math.max(0, boss.hp / boss.maxHp);
  ctx.fillStyle = enraged ? '#ff3030' : '#c93030';
  ctx.fillRect(bx + 2, by + 2, (bw - 4) * hpPct, bh - 4);
  // Enrage pulse: white inner bar.
  if (enraged && !boss.dead) {
    const pulse = 0.4 + 0.6 * Math.abs(Math.sin(game.simTime * 6));
    ctx.fillStyle = `rgba(255, 220, 60, ${0.25 * pulse})`;
    ctx.fillRect(bx + 2, by + 2, (bw - 4) * hpPct, bh - 4);
  }
  // Frame.
  ctx.strokeStyle = '#f0c850';
  ctx.lineWidth = 2;
  ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
  // Boss portrait + name (portrait sprite is optional per boss).
  const portrait = getSprite(`portrait-${boss.typeId}`);
  if (portrait) {
    ctx.drawImage(portrait, bx - 56, by - 6, 48, 48);
    ctx.strokeRect(bx - 56 + 0.5, by - 6 + 0.5, 47, 47);
  }
  const label = boss.dead ? `${name} FALLS` : (enraged ? `${name} — ENRAGED` : name);
  ctx.font = 'bold 16px "Cinzel", "Georgia", serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#000';
  ctx.fillText(label, bx + bw / 2 + 1, by + bh / 2 + 1);
  ctx.fillStyle = '#ffd860';
  ctx.fillText(label, bx + bw / 2, by + bh / 2);
  ctx.restore();
}

function drawWaveAlert(input: RendererInput) {
  const { ctx, camera, game } = input;
  const a = game.waveAlert;
  if (!a) return;
  const t = a.age / a.duration;
  // Vignette: red pulse fading out.
  const pulse = Math.sin(a.age * 8) * 0.5 + 0.5;
  const vignetteAlpha = Math.max(0, 0.55 * (1 - t)) * (0.4 + 0.6 * pulse);
  const grd = ctx.createRadialGradient(
    camera.viewW / 2, camera.viewH / 2, Math.min(camera.viewW, camera.viewH) * 0.3,
    camera.viewW / 2, camera.viewH / 2, Math.max(camera.viewW, camera.viewH) * 0.7,
  );
  grd.addColorStop(0, 'rgba(220, 30, 30, 0)');
  grd.addColorStop(1, `rgba(220, 30, 30, ${vignetteAlpha})`);
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, camera.viewW, camera.viewH);

  // Banner near the top.
  const bannerAlpha = Math.max(0, 1 - t * 1.2);
  if (bannerAlpha > 0.02) {
    ctx.save();
    ctx.globalAlpha = bannerAlpha;
    const bx = camera.viewW / 2;
    const by = 92;
    ctx.fillStyle = 'rgba(40, 10, 8, 0.92)';
    ctx.fillRect(bx - 320, by - 28, 640, 56);
    ctx.strokeStyle = '#f0c850';
    ctx.lineWidth = 2;
    ctx.strokeRect(bx - 320 + 0.5, by - 28 + 0.5, 640 - 1, 56 - 1);
    ctx.font = 'bold 22px "Cinzel", "Georgia", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#000';
    ctx.fillText(a.text, bx + 1, by + 1);
    ctx.fillStyle = '#ffd860';
    ctx.fillText(a.text, bx, by);
    ctx.restore();
  }
}

// Compute the screen position a unit at world (e.pos) should land at, given
// the iso Y squish that's applied to the ground plane. We render units in
// camera-only space so they're upright, but at this projected position they
// appear to be standing on the iso ground.
function isoUnitScreenPos(camera: Camera, worldX: number, worldY: number) {
  // Inside the iso pass, world (wx, wy) lands at world-pre-iso-coords (wx, (wy - cy)*S + cy).
  // In camera-only space, that point's screen position is:
  //   x = (wx - cx) * zoom
  //   y = ((wy - cy) * S + cy - cy) * zoom = (wy - cy) * S * zoom
  // We want to draw the unit at THAT y so it visually sits on the iso ground.
  return {
    x: (worldX - camera.x) * camera.zoom,
    y: (worldY - camera.y) * camera.zoom * ISO_Y_SCALE,
  };
}

// Draws a unit upright at the iso-projected screen position. Called from
// camera-only space (no iso squish currently applied). Note: in camera-only
// space, position (px, py) on screen maps from world via inverse of
// scale(zoom)*translate(-cam), so to draw at iso-projected screen pos we set
// the current point in the camera-coordinate-system explicitly.
// Derive a short action label from the unit's current FSM state, so the
// renderer can pick the matching action-pose sprite.
//
// Latch: when a unit chases a kiting target, the FSM rapidly flips
// 'attacking' → 'moving' → 'attacking' between strikes (the moment the target
// drifts 1px out of range it queues a re-approach). Without a latch the
// action sprite vanishes between swings. We hold the attack pose for
// min(attackCooldown, 0.6s) after the last swing, keyed off lastAttackAt.
function unitActionKind(e: Entity, simTime: number): 'chop' | 'gather' | 'build' | 'attack' | 'shoot' | 'claw' | null {
  if (!e.state) return null;
  if (e.state.kind === 'gathering') {
    const r = (e.state as any).resource;
    return r === 'wood' ? 'chop' : 'gather';
  }
  if (e.state.kind === 'building') return 'build';
  const attackPose = (): 'attack' | 'shoot' | 'claw' => {
    if (e.typeId === 'archer' || e.typeId === 'archer_enemy' || e.typeId === 'rama' || e.typeId === 'lakshmana' || e.typeId === 'maricha') return 'shoot';
    if (e.typeId === 'tataka') return 'claw';
    return 'attack';
  };
  if (e.state.kind === 'attacking') return attackPose();
  // Latched attack pose for chase-fights.
  if (e.lastAttackAt && (e.state.kind === 'moving' || e.state.kind === 'attackMove')) {
    const def = UNIT_DEFS[e.typeId];
    const cooldown = def?.attackSpeed ? 1 / def.attackSpeed : 0.4;
    const latch = Math.min(0.6, cooldown);
    if (simTime - e.lastAttackAt < latch) return attackPose();
  }
  return null;
}

function drawUnitUpright(input: RendererInput, e: Entity, hitFlash?: HitFlashFX) {
  const { ctx, camera, game } = input;
  const def = UNIT_DEFS[e.typeId];
  if (!def) return;

  // Corpse fade: dead entities linger in game.entities for exactly 1.0s after
  // deathAt (then reaped), so fade alpha 1 → 0 over that window. Corpses skip
  // the faction ring and bob so they read as dead, not idle.
  let deadAlpha = 1;
  if (e.dead) {
    const since = game.simTime - (e.deathAt ?? game.simTime);
    deadAlpha = Math.max(0, 1 - since / 1.0);
    if (deadAlpha <= 0) return;
  }

  // In camera-only space, drawing at (px, py) lands at world (px+cam.x, py+cam.y).
  // But py is in pre-zoom units. We want the unit visually at iso-projected
  // screen y, which equals (e.pos.y - cam.y) * ISO_Y_SCALE — in screen px.
  // Camera-only space transform is scale(zoom)*translate(-cam). So drawing at
  // camera-space (a, b) lands at screen ((a-cx)*zoom, (b-cy)*zoom). To land at
  // screen ((e.pos.x - cx)*zoom, (e.pos.y - cy)*zoom*ISO_Y_SCALE), we draw at:
  //   a = e.pos.x
  //   b = (e.pos.y - cy) * ISO_Y_SCALE + cy
  const drawY = (e.pos.y - camera.y) * ISO_Y_SCALE + camera.y;

  const moving = !e.dead && (e.state?.kind === 'moving' || e.state?.kind === 'gathering');
  const bobPhase = moving ? Math.sin(game.simTime * 12 + e.id) : 0;
  const walkBob = moving ? Math.abs(bobPhase) * 1.5 : 0;
  // Idle breathing: subtle vertical bob at ~1.6Hz so resting units feel alive.
  // Corpses don't breathe.
  const idleBob = !moving && !e.dead ? Math.sin(game.simTime * 1.6 + e.id * 0.3) * 0.7 : 0;
  const bob = walkBob + idleBob;

  if (e.dead) ctx.globalAlpha = deadAlpha;

  // Faction-tinted ground ring (drawn behind the unit, in iso ground space).
  // Gaia units (deer, etc.) get no ring so they read as wildlife. Corpses get
  // no ring either.
  if (e.owner !== 0 && !e.dead) {
    const factionColor = e.owner === 1 ? 'rgba(120, 180, 255, 0.35)' : 'rgba(255, 100, 100, 0.35)';
    ctx.fillStyle = factionColor;
    ctx.beginPath();
    ctx.ellipse(e.pos.x, drawY - 1, e.radius + 2, (e.radius + 2) * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Determine action sprite if the unit is mid-action — these take precedence
  // over the regular directional sprite so the player sees a clear "doing
  // something" pose instead of a walking stance.
  let sprite: HTMLCanvasElement | HTMLImageElement | null = null;
  let flip = false;
  let extraScalePulse = 1; // brief scale pulse on attack ticks
  const actionKind = e.dead ? null : unitActionKind(e, game.simTime);
  if (actionKind) {
    const actionInfo = unitActionSprite(e.typeId, actionKind, e.facingAngle);
    if (actionInfo) {
      const s = getSprite(actionInfo.key);
      if (s) {
        sprite = s;
        flip = actionInfo.flip;
        // Pulse the sprite slightly on attack cadence so it reads as motion.
        if (actionKind === 'attack' || actionKind === 'shoot' || actionKind === 'claw' || actionKind === 'chop') {
          const sinceAttack = e.lastAttackAt ? game.simTime - e.lastAttackAt : 999;
          if (sinceAttack < 0.18) extraScalePulse = 1.10;
        }
      }
    }
  }
  // Fall back to directional sprite. Skip for enraged Tataka: the enraged art
  // only exists as a single S-facing sprite, and the normal directional set
  // would override it.
  const tatakaEnraged = e.typeId === 'tataka' && game.bossPhase === 2;
  if (!sprite && !tatakaEnraged) {
    const dirInfo = unitDirectionalSprite(e.typeId, e.facingAngle);
    sprite = dirInfo ? getSprite(dirInfo.key) : null;
    flip = !!dirInfo?.flip;
  }
  // Fall back to the S-facing sprite while directional ones are still loading.
  if (!sprite) {
    const sk = unitTopdownSpriteKey(e.typeId, tatakaEnraged);
    sprite = sk ? getSprite(sk) : null;
    flip = e.facing === -1;
  }
  if (sprite) {
    const isCavalry = e.typeId === 'cavalry' || e.typeId === 'cavalry_enemy';
    const baseSize = (isCavalry ? 64 : 48) * (def?.sizeScale ?? 1);
    const size = baseSize * extraScalePulse;
    // Hit flash: brief red tint when the unit was just struck. Looked up once
    // per frame in render() and passed down.
    const flashAlpha = hitFlash ? Math.max(0, 1 - hitFlash.age / hitFlash.maxAge) * 0.6 : 0;
    const dx = e.pos.x - size / 2;
    const dyy = drawY - size * 0.92 - bob;
    if (flip) {
      ctx.save();
      ctx.translate(e.pos.x, drawY - size * 0.92 - bob);
      ctx.scale(-1, 1);
      ctx.drawImage(sprite, -size / 2, 0, size, size);
      ctx.restore();
    } else {
      ctx.drawImage(sprite, dx, dyy, size, size);
    }
    // Persistent reskin tint (campaign bosses sharing base art), then hit flash.
    if (def?.tintColor) {
      drawTintedSprite(ctx, sprite, dx, dyy, size, size, def.tintColor, flip);
    }
    if (flashAlpha > 0) {
      drawTintedSprite(ctx, sprite, dx, dyy, size, size, `rgba(255, 60, 60, ${flashAlpha})`, flip);
    }
  } else {
    // Procedural fallback.
    ctx.save();
    ctx.translate(e.pos.x, drawY - bob);
    ctx.fillStyle = def.primaryColor;
    ctx.beginPath();
    ctx.ellipse(0, 0, e.radius * 0.9, e.radius * 1.05, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#d8a880';
    ctx.beginPath();
    ctx.arc(0, -e.radius * 0.55, e.radius * 0.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = def.accentColor;
    ctx.fillRect(-e.radius * 0.5, 0, e.radius, 1.5);
    ctx.restore();
  }

  // Carrying indicator + gather flash above the head (living units only).
  if (!e.dead && e.carrying && e.carrying.amount > 0) {
    const col =
      e.carrying.resource === 'wood' ? COLORS.wood :
      e.carrying.resource === 'food' ? COLORS.food :
      e.carrying.resource === 'gold' ? COLORS.gold :
      COLORS.stone;
    ctx.fillStyle = col;
    ctx.fillRect(e.pos.x - 3, drawY - 50 - bob, 6, 6);
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(e.pos.x - 3.5, drawY - 50.5 - bob, 7, 7);
  }
  if (!e.dead && e.state?.kind === 'gathering') {
    const pulse = 0.5 + 0.5 * Math.sin(game.simTime * 14 + e.id);
    ctx.fillStyle = `rgba(255, 220, 120, ${0.4 + 0.5 * pulse})`;
    ctx.beginPath();
    ctx.arc(e.pos.x + e.radius - 2, drawY - 18 - bob, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  if (e.dead) ctx.globalAlpha = 1;
}

// ============================================================================
// Terrain
// ============================================================================

function drawTerrainBase(input: RendererInput) {
  const { ctx, camera, game } = input;
  const tile = TILE_SIZE;
  const x0 = Math.max(0, Math.floor(camera.x / tile));
  const y0 = Math.max(0, Math.floor(camera.y / tile));
  const x1 = Math.min(game.world.w, Math.ceil((camera.x + camera.viewW / camera.zoom) / tile) + 1);
  const y1 = Math.min(game.world.h, Math.ceil((camera.y + (camera.viewH / camera.zoom) / ISO_Y_SCALE) / tile) + 1);

  // Try to use painted terrain textures. Each AI-painted tile texture is 256px
  // and contains many tiles' worth of variation, so we sample sub-regions
  // based on tile coords for visual variety.
  const grassTex = getTerrainTile('terrain-grass');
  const dirtTex = getTerrainTile('terrain-dirt');
  const waterTex = getTerrainTile('terrain-water');

  for (let ty = y0; ty < y1; ty++) {
    for (let tx = x0; tx < x1; tx++) {
      const i = game.world.idx(tx, ty);
      const t = game.world.terrain[i];
      const v = game.world.variation[i];
      let tex: HTMLCanvasElement | null = null;
      let fallback = '#3d6b3a';
      if (t === 1) { tex = dirtTex; fallback = '#6b5a3a'; }
      else if (t === 2) { tex = waterTex; fallback = '#2a4a6a'; }
      else { tex = grassTex; }
      if (tex) {
        // Sample a 32×32 sub-region of the 256px texture. Use a deterministic
        // offset per tile so the same tile always picks the same sub-region.
        const tileTex = tile;
        const subSize = 32;
        const cols = Math.floor(tex.width / subSize);
        const rows = Math.floor(tex.height / subSize);
        const sx = (((tx * 7 + ty * 13 + v) % cols) + cols) % cols * subSize;
        const sy = (((tx * 17 + ty * 31 + (v >> 3)) % rows) + rows) % rows * subSize;
        ctx.drawImage(tex, sx, sy, subSize, subSize, tx * tile, ty * tile, tileTex, tileTex);
      } else {
        ctx.fillStyle = fallback;
        ctx.fillRect(tx * tile, ty * tile, tile, tile);
      }
    }
  }
}

function drawTerrainDecorations(input: RendererInput) {
  const { ctx, camera, game } = input;
  const tile = TILE_SIZE;
  const x0 = Math.max(0, Math.floor(camera.x / tile));
  const y0 = Math.max(0, Math.floor(camera.y / tile));
  const x1 = Math.min(game.world.w, Math.ceil((camera.x + camera.viewW / camera.zoom) / tile) + 1);
  const y1 = Math.min(game.world.h, Math.ceil((camera.y + (camera.viewH / camera.zoom) / ISO_Y_SCALE) / tile) + 1);
  for (let ty = y0; ty < y1; ty++) {
    for (let tx = x0; tx < x1; tx++) {
      const i = game.world.idx(tx, ty);
      const t = game.world.terrain[i];
      if (t !== 0) continue;       // only on grass
      if (game.world.blocker[i] !== 0) continue; // skip occupied
      const v = game.world.variation[i];
      // Grass tuft if variation byte is in a certain range.
      if (v > 230) {
        ctx.fillStyle = 'rgba(160, 200, 110, 0.45)';
        const cx = tx * tile + (v & 0x1f);
        const cy = ty * tile + ((v >> 3) & 0x1f);
        ctx.fillRect(cx, cy, 2, 1);
        ctx.fillRect(cx + 1, cy + 1, 1, 1);
      } else if (v > 220) {
        // Tiny pebble.
        ctx.fillStyle = 'rgba(120, 100, 80, 0.55)';
        const cx = tx * tile + ((v * 7) & 0x1f);
        const cy = ty * tile + ((v * 11) & 0x1f);
        ctx.beginPath();
        ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
        ctx.fill();
      } else if (v > 200 && (v & 7) === 0) {
        // Tiny flower.
        const flowerColors = ['#ffd840', '#ff7a90', '#e0d8ff', '#ffffff'];
        ctx.fillStyle = flowerColors[v & 3];
        const cx = tx * tile + ((v * 5) & 0x1f);
        const cy = ty * tile + ((v * 13) & 0x1f);
        ctx.fillRect(cx, cy, 2, 2);
      }
    }
  }
}

function drawWaterEdges(input: RendererInput) {
  // Water tiles get an animated highlight stripe to look "alive".
  const { ctx, camera, game } = input;
  const tile = TILE_SIZE;
  const now = performance.now() / 1000;
  const x0 = Math.max(0, Math.floor(camera.x / tile));
  const y0 = Math.max(0, Math.floor(camera.y / tile));
  const x1 = Math.min(game.world.w, Math.ceil((camera.x + camera.viewW / camera.zoom) / tile) + 1);
  const y1 = Math.min(game.world.h, Math.ceil((camera.y + (camera.viewH / camera.zoom) / ISO_Y_SCALE) / tile) + 1);
  for (let ty = y0; ty < y1; ty++) {
    for (let tx = x0; tx < x1; tx++) {
      const i = game.world.idx(tx, ty);
      if (game.world.terrain[i] !== 2) continue;
      const phase = (tx + ty) * 0.7 + now * 0.6;
      const stripeY = ty * tile + ((Math.sin(phase) + 1) * 0.5) * (tile - 4) + 2;
      ctx.fillStyle = 'rgba(180, 220, 255, 0.18)';
      ctx.fillRect(tx * tile + 4, stripeY, tile - 8, 1);
      // Coast highlight on neighbors that are grass. Bounds check: at tx=0
      // there is no west neighbor (idx would wrap to the previous row).
      if (tx > 0 && game.world.terrain[game.world.idx(tx - 1, ty)] !== 2) {
        ctx.fillStyle = 'rgba(200,230,255,0.3)';
        ctx.fillRect(tx * tile, ty * tile, 1, tile);
      }
    }
  }
}

// ============================================================================
// Shadows
// ============================================================================

function drawEntityShadow(input: RendererInput, e: Entity) {
  const { ctx } = input;
  if (e.dead) return;
  if (e.kind === 'building') {
    if (!e.tilePos || !e.sizeTiles) return;
    const x = e.tilePos.tx * TILE_SIZE;
    const y = e.tilePos.ty * TILE_SIZE;
    const w = e.sizeTiles.w * TILE_SIZE;
    const h = e.sizeTiles.h * TILE_SIZE;
    // Building "footprint shadow" — covers the footprint area to ground the
    // sprite. With the iso squish applied to the world, this comes out as a
    // squished darker rect, which reads as a darker patch of ground under the
    // building.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.32)';
    ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
    // Soft outer halo.
    const grd = ctx.createRadialGradient(
      x + w / 2, y + h / 2, Math.min(w, h) * 0.35,
      x + w / 2, y + h / 2, Math.max(w, h) * 0.7,
    );
    grd.addColorStop(0, 'rgba(0,0,0,0.22)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grd;
    ctx.fillRect(x - w * 0.3, y - h * 0.3, w * 1.6, h * 1.6);
  } else if (e.kind === 'resource' && e.typeId === 'tree') {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
    ctx.beginPath();
    ctx.ellipse(e.pos.x + 3, e.pos.y + 9, 13, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (e.kind === 'unit') {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.32)';
    ctx.beginPath();
    ctx.ellipse(e.pos.x + 1, e.pos.y + e.radius - 1, e.radius * 0.95, e.radius * 0.32, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ============================================================================
// Resources
// ============================================================================

function drawResourceNode(input: RendererInput, e: Entity) {
  const { ctx, game } = input;
  if (e.dead) {
    const t = (game.simTime - (e.deathAt ?? 0)) / 1.0;
    ctx.globalAlpha = Math.max(0, 1 - t);
    ctx.fillStyle = '#4a3a22';
    ctx.beginPath();
    ctx.arc(e.pos.x, e.pos.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    return;
  }
  const def = RESOURCE_DEFS[e.typeId];
  if (!def) return;
  // Try the AI-painted sprite first; fall back to procedural if it hasn't
  // loaded. Sprites are tightly-cropped + pre-scaled so they composite cleanly
  // onto the painted terrain.
  const sprite = getSprite(resourceSpriteKey(e.typeId) ?? '');
  if (sprite) {
    // Sway only for trees so the forest feels alive.
    const sway = e.typeId === 'tree' ? Math.sin(game.simTime * 1.3 + e.id * 0.7) * 0.012 : 0;
    const size = e.typeId === 'tree' ? 56 : 38;
    const aspect = (sprite as any).height / (sprite as any).width || 1;
    const w = size;
    const h = size * aspect;
    // Anchor at the tile bottom so trees/bushes "stand on" the ground.
    const x = e.pos.x - w / 2;
    const y = e.pos.y - h * 0.78;
    if (sway) {
      ctx.save();
      ctx.translate(e.pos.x, e.pos.y);
      ctx.rotate(sway);
      ctx.drawImage(sprite, -w / 2, -h * 0.78, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(sprite, x, y, w, h);
    }
    return;
  }
  // Procedural fallback while sprites are still loading.
  if (e.typeId === 'tree') drawTree(ctx, e, game.simTime);
  else if (e.typeId === 'berry_bush') drawBerryBush(ctx, e);
  else if (e.typeId === 'gold_vein') drawGoldVein(ctx, e);
  else if (e.typeId === 'stone_vein') drawStoneVein(ctx, e);
}

function drawTree(ctx: CanvasRenderingContext2D, e: Entity, simTime = 0) {
  const x = e.pos.x, y = e.pos.y;
  // Gentle wind sway: canopy drifts horizontally by ~1px on a per-tree phase.
  const sway = Math.sin(simTime * 1.3 + e.id * 0.7) * 0.9;
  // Trunk.
  ctx.fillStyle = '#3a2a18';
  ctx.fillRect(x - 2, y + 1, 4, 9);
  ctx.fillStyle = '#5a3a22';
  ctx.fillRect(x - 1, y + 1, 2, 9);
  // Canopy. The canopy is offset by `sway` so it appears to move with wind.
  ctx.fillStyle = '#1f3a1a';
  ctx.beginPath();
  ctx.arc(x - 4 + sway, y - 4, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#2c5028';
  ctx.beginPath();
  ctx.arc(x + 2 + sway, y - 6, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#3a6a32';
  ctx.beginPath();
  ctx.arc(x + 1 + sway, y - 2, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#6a9a4a';
  ctx.beginPath();
  ctx.arc(x + 3 + sway, y - 6, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(220, 240, 180, 0.6)';
  ctx.beginPath();
  ctx.arc(x + 4 + sway, y - 8, 1.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawBerryBush(ctx: CanvasRenderingContext2D, e: Entity) {
  const x = e.pos.x, y = e.pos.y;
  // Foliage.
  ctx.fillStyle = '#3a5028';
  ctx.beginPath();
  ctx.arc(x, y, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#588a48';
  ctx.beginPath();
  ctx.arc(x + 2, y - 1, 8, 0, Math.PI * 2);
  ctx.fill();
  // Berries.
  const berries = [
    [-4, -2], [3, -3], [5, 2], [-3, 3], [0, 0], [-6, 1],
  ];
  ctx.fillStyle = '#c83a4a';
  for (const [dx, dy] of berries) {
    ctx.beginPath();
    ctx.arc(x + dx, y + dy, 1.7, 0, Math.PI * 2);
    ctx.fill();
  }
  // Highlights on a couple of berries.
  ctx.fillStyle = '#ff90a0';
  ctx.beginPath();
  ctx.arc(x + 4, y + 2, 0.8, 0, Math.PI * 2);
  ctx.fill();
}

function drawGoldVein(ctx: CanvasRenderingContext2D, e: Entity) {
  const x = e.pos.x, y = e.pos.y;
  // Dark base rock.
  ctx.fillStyle = '#403028';
  ctx.beginPath();
  ctx.arc(x, y + 1, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#5a4838';
  ctx.beginPath();
  ctx.arc(x - 2, y - 1, 8, 0, Math.PI * 2);
  ctx.fill();
  // Gold flecks.
  ctx.fillStyle = '#f0c850';
  ctx.beginPath();
  ctx.arc(x - 3, y - 2, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + 2, y, 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + 4, y - 3, 1.5, 0, Math.PI * 2);
  ctx.fill();
  // Highlight.
  ctx.fillStyle = '#ffeea0';
  ctx.beginPath();
  ctx.arc(x - 3, y - 3, 0.8, 0, Math.PI * 2);
  ctx.fill();
}

function drawStoneVein(ctx: CanvasRenderingContext2D, e: Entity) {
  const x = e.pos.x, y = e.pos.y;
  // Dark base.
  ctx.fillStyle = '#3a3a3a';
  ctx.beginPath();
  ctx.arc(x, y + 1, 10, 0, Math.PI * 2);
  ctx.fill();
  // Mid stones.
  ctx.fillStyle = '#7a7a80';
  ctx.beginPath();
  ctx.arc(x - 3, y - 2, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + 3, y + 1, 5, 0, Math.PI * 2);
  ctx.fill();
  // Lit tops.
  ctx.fillStyle = '#b0b4b8';
  ctx.beginPath();
  ctx.arc(x - 3, y - 3, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + 3, y, 2.5, 0, Math.PI * 2);
  ctx.fill();
}

// ============================================================================
// Buildings
// ============================================================================

function drawBuilding(input: RendererInput, e: Entity) {
  const { ctx } = input;
  const def = BUILDING_DEFS[e.typeId];
  if (!def || !e.tilePos || !e.sizeTiles) return;
  const x = e.tilePos.tx * TILE_SIZE;
  const y = e.tilePos.ty * TILE_SIZE;
  const w = e.sizeTiles.w * TILE_SIZE;
  const h = e.sizeTiles.h * TILE_SIZE;

  // Corpse fade: destroyed buildings linger for 1.0s after deathAt before
  // being reaped; fade them out over that window instead of drawing them
  // fully intact next to their death puff.
  let deadAlpha = 1;
  if (e.dead) {
    const since = input.game.simTime - (e.deathAt ?? input.game.simTime);
    deadAlpha = Math.max(0, 1 - since / 1.0);
    if (deadAlpha <= 0) return;
    ctx.globalAlpha = deadAlpha;
  }

  if (e.isConstructionSite) {
    drawConstructionSite(ctx, e, x, y, w, h, def);
    // Also draw the actual building sprite, but vertically clipped to the
    // build progress so it "rises" out of the ground as work proceeds.
    const v2Key = buildingTileSpriteKey(e.typeId);
    const sprite = v2Key ? getSprite(v2Key) : null;
    if (sprite && (e.buildProgress ?? 0) > 0.05) {
      const headroom = Math.floor(h * 0.45);
      const drawY = y - headroom;
      const drawH = h + headroom;
      const progress = e.buildProgress ?? 0;
      // Clip to a horizontal band that grows from the bottom upward.
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, drawY + drawH * (1 - progress), w, drawH * progress);
      ctx.clip();
      ctx.globalAlpha = 0.85 * deadAlpha;
      ctx.drawImage(sprite, x, drawY, w, drawH);
      ctx.globalAlpha = deadAlpha;
      ctx.restore();
    }
    if (e.dead) ctx.globalAlpha = 1;
    return;
  }

  // Try sprite first. Prefer v2 "tile-*" sprite (no painted ground disc); fall
  // back to v1 building-*; fall back to procedural.
  const v2Key = buildingTileSpriteKey(e.typeId);
  const v2Sprite = v2Key ? getSprite(v2Key) : null;
  const v1Key = buildingSpriteKey(e.typeId);
  const v1Sprite = v1Key ? getSprite(v1Key) : null;
  const sprite = v2Sprite ?? v1Sprite;
  if (sprite) {
    // Anchor the sprite so its BOTTOM aligns with the footprint bottom and it
    // extends UPWARD over the footprint plus headroom. This way the painted
    // building "sits in" the tiles instead of floating on a plate.
    const headroom = Math.floor(h * 0.45);
    const drawX = x;
    const drawY = y - headroom;
    const drawH = h + headroom;
    ctx.drawImage(sprite, drawX, drawY, w, drawH);
    if (e.owner === 2 && v2Key !== 'tile-lanka-citadel' && v1Key !== 'building-lanka-citadel') {
      ctx.fillStyle = 'rgba(140, 30, 30, 0.18)';
      ctx.fillRect(drawX, drawY, w, drawH);
    }
  } else {
    // Procedural fallback.
    if (e.typeId === 'town_center' || e.typeId === 'town_center_enemy') {
      drawTownCenter(ctx, x, y, w, h, def, e.owner === 2);
    } else if (e.typeId === 'house' || e.typeId === 'house_enemy') {
      drawHouse(ctx, x, y, w, h, def, e.owner === 2);
    } else if (e.typeId === 'watchtower') {
      drawWatchtower(ctx, x, y, w, h, def);
    } else if (e.typeId.startsWith('barracks')) {
      drawBarracks(ctx, x, y, w, h, def, e.owner === 2);
    } else if (e.typeId.startsWith('archery_range')) {
      drawArcheryRange(ctx, x, y, w, h, def, e.owner === 2);
    } else if (e.typeId.startsWith('stable')) {
      drawStable(ctx, x, y, w, h, def, e.owner === 2);
    } else if (e.typeId === 'wall') {
      drawWall(ctx, x, y, w, h, def);
    } else if (e.typeId === 'gate') {
      drawGate(ctx, x, y, w, h, def, !!e.gateOpen);
    } else {
      drawGenericBuilding(ctx, x, y, w, h, def);
    }
  }

  // Faction trim border (subtle). Skip for the Yajna so it doesn't get a
  // factional border — it's a sacred altar, not a player structure. Skip for
  // corpses so destroyed buildings don't keep their faction highlight.
  if (e.typeId !== 'yajna' && !e.dead) {
    ctx.strokeStyle = e.owner === 1 ? 'rgba(240,200,80,0.4)' : 'rgba(200,80,80,0.45)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  // Yajna flame: pulsing glow halo + rising "embers" particles drawn over
  // the sprite so it visibly burns. Extinguished once destroyed.
  if (e.typeId === 'yajna' && !e.isConstructionSite && !e.dead) {
    const game = input.game;
    const cx = x + w / 2;
    const cy = y + h * 0.35;
    const pulse = 0.5 + 0.5 * Math.sin(game.simTime * 6);
    const radius = Math.max(w, h) * (0.65 + 0.08 * pulse);
    const grd = ctx.createRadialGradient(cx, cy, 4, cx, cy, radius);
    grd.addColorStop(0, `rgba(255, 220, 100, ${0.35 + 0.2 * pulse})`);
    grd.addColorStop(0.5, 'rgba(240, 140, 40, 0.18)');
    grd.addColorStop(1, 'rgba(240, 140, 40, 0)');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    // Embers: small drifting motes.
    for (let i = 0; i < 4; i++) {
      const phase = game.simTime * 1.2 + i * 1.3;
      const ex = cx + Math.sin(phase * 0.9 + i) * 8;
      const ey = cy - ((phase * 22) % (h * 0.7));
      const alpha = 0.6 * (1 - ((phase * 22) % (h * 0.7)) / (h * 0.7));
      ctx.fillStyle = `rgba(255, 200, 60, ${alpha})`;
      ctx.fillRect(ex - 1, ey - 1, 2, 2);
    }
  }

  if (e.dead) ctx.globalAlpha = 1;
}

function drawConstructionSite(
  ctx: CanvasRenderingContext2D, e: Entity, x: number, y: number, w: number, h: number, def: any,
) {
  // Outlined foundation + rising progress fill.
  ctx.fillStyle = '#3a2e1e';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#5a4830';
  ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
  // Progress fill from bottom (like raising a building).
  const p = e.buildProgress ?? 0;
  const fillH = (h - 6) * p;
  ctx.fillStyle = `rgba(${hexToRgb(def.primaryColor)}, 0.85)`;
  ctx.fillRect(x + 3, y + h - 3 - fillH, w - 6, fillH);
  // Scaffolding poles.
  ctx.strokeStyle = '#9b7a4a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x + 4, y - 2); ctx.lineTo(x + 6, y + h);
  ctx.moveTo(x + w - 4, y - 2); ctx.lineTo(x + w - 6, y + h);
  ctx.stroke();
  // Crossbeams.
  ctx.beginPath();
  ctx.moveTo(x + 4, y + h * 0.4); ctx.lineTo(x + w - 4, y + h * 0.4);
  ctx.moveTo(x + 4, y + h * 0.7); ctx.lineTo(x + w - 4, y + h * 0.7);
  ctx.stroke();
}

function drawTownCenter(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, def: any, enemy: boolean,
) {
  // Stone base (slightly larger than walls).
  const baseInset = 2;
  ctx.fillStyle = '#7a7268';
  ctx.fillRect(x + baseInset, y + baseInset, w - baseInset * 2, h - baseInset * 2);
  // Wall body.
  const wallInset = 8;
  ctx.fillStyle = def.primaryColor;
  ctx.fillRect(x + wallInset, y + wallInset, w - wallInset * 2, h - wallInset * 2);
  // Wall light side (north + west).
  ctx.fillStyle = lighten(def.primaryColor, 0.18);
  ctx.fillRect(x + wallInset, y + wallInset, w - wallInset * 2, 4);
  ctx.fillRect(x + wallInset, y + wallInset, 4, h - wallInset * 2);
  // Wall dark side (south + east).
  ctx.fillStyle = darken(def.primaryColor, 0.25);
  ctx.fillRect(x + wallInset, y + h - wallInset - 4, w - wallInset * 2, 4);
  ctx.fillRect(x + w - wallInset - 4, y + wallInset, 4, h - wallInset * 2);
  // Stone columns at each corner.
  ctx.fillStyle = '#a8a098';
  ctx.fillRect(x + wallInset - 3, y + wallInset - 3, 6, 6);
  ctx.fillRect(x + w - wallInset - 3, y + wallInset - 3, 6, 6);
  ctx.fillRect(x + wallInset - 3, y + h - wallInset - 3, 6, 6);
  ctx.fillRect(x + w - wallInset - 3, y + h - wallInset - 3, 6, 6);
  // Roof: pyramidal effect with a smaller center square.
  const cx = x + w / 2, cy = y + h / 2;
  const roofInset = 16;
  ctx.fillStyle = def.roofColor;
  ctx.beginPath();
  ctx.moveTo(x + roofInset, y + roofInset);
  ctx.lineTo(x + w - roofInset, y + roofInset);
  ctx.lineTo(x + w - roofInset, y + h - roofInset);
  ctx.lineTo(x + roofInset, y + h - roofInset);
  ctx.closePath();
  ctx.fill();
  // Inner roof bright.
  ctx.fillStyle = lighten(def.roofColor, 0.2);
  ctx.beginPath();
  ctx.moveTo(x + roofInset + 2, y + roofInset + 2);
  ctx.lineTo(x + w / 2, y + h / 2 - 4);
  ctx.lineTo(x + w - roofInset - 2, y + roofInset + 2);
  ctx.closePath();
  ctx.fill();
  // Gold spire / banner at center.
  ctx.fillStyle = def.accentColor ?? '#f0c850';
  ctx.fillRect(cx - 1.5, cy - 8, 3, 14);
  ctx.fillStyle = enemy ? '#a04040' : '#f0c850';
  ctx.beginPath();
  ctx.moveTo(cx + 1, cy - 6);
  ctx.lineTo(cx + 8, cy - 4);
  ctx.lineTo(cx + 1, cy - 2);
  ctx.closePath();
  ctx.fill();
}

function drawHouse(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, def: any, enemy: boolean,
) {
  // Walls.
  ctx.fillStyle = def.primaryColor;
  ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
  // Light side.
  ctx.fillStyle = lighten(def.primaryColor, 0.15);
  ctx.fillRect(x + 2, y + 2, w - 4, 3);
  ctx.fillRect(x + 2, y + 2, 3, h - 4);
  // Dark side.
  ctx.fillStyle = darken(def.primaryColor, 0.22);
  ctx.fillRect(x + 2, y + h - 5, w - 4, 3);
  ctx.fillRect(x + w - 5, y + 2, 3, h - 4);
  // Thatch roof (overlapping triangles).
  const cx = x + w / 2;
  ctx.fillStyle = def.roofColor;
  ctx.beginPath();
  ctx.moveTo(x, y + h * 0.45);
  ctx.lineTo(cx, y - 3);
  ctx.lineTo(x + w, y + h * 0.45);
  ctx.lineTo(x + w - 3, y + h * 0.55);
  ctx.lineTo(cx, y + 3);
  ctx.lineTo(x + 3, y + h * 0.55);
  ctx.closePath();
  ctx.fill();
  // Thatch streaks.
  ctx.strokeStyle = lighten(def.roofColor, 0.2);
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const t = (i + 1) / 5;
    ctx.beginPath();
    ctx.moveTo(x + w * t * 0.5, y + h * 0.45 * t);
    ctx.lineTo(x + w * t * 0.5 + 2, y + h * 0.45 * t - 1);
    ctx.stroke();
  }
  // Door.
  ctx.fillStyle = '#3a2818';
  ctx.fillRect(cx - 3, y + h - 9, 6, 7);
  ctx.fillStyle = '#5a3a22';
  ctx.fillRect(cx - 2, y + h - 8, 4, 5);
}

function drawWatchtower(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, def: any,
) {
  // Stone column.
  ctx.fillStyle = def.primaryColor;
  ctx.fillRect(x + 6, y + 8, w - 12, h - 14);
  // Lit side.
  ctx.fillStyle = lighten(def.primaryColor, 0.18);
  ctx.fillRect(x + 6, y + 8, w - 12, 3);
  ctx.fillRect(x + 6, y + 8, 3, h - 14);
  // Dark side.
  ctx.fillStyle = darken(def.primaryColor, 0.25);
  ctx.fillRect(x + 6, y + h - 9, w - 12, 3);
  ctx.fillRect(x + w - 9, y + 8, 3, h - 14);
  // Crenellated top.
  ctx.fillStyle = def.roofColor;
  ctx.fillRect(x + 4, y + 4, w - 8, 8);
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = '#222';
    ctx.fillRect(x + 6 + i * 6, y + 2, 3, 4);
  }
  // Lookout slit (window) on north face.
  ctx.fillStyle = '#0e1e28';
  ctx.fillRect(x + w / 2 - 2, y + h * 0.4, 4, 3);
}

function drawBarracks(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, def: any, enemy: boolean,
) {
  // Walls.
  ctx.fillStyle = def.primaryColor;
  ctx.fillRect(x + 3, y + 3, w - 6, h - 6);
  ctx.fillStyle = lighten(def.primaryColor, 0.14);
  ctx.fillRect(x + 3, y + 3, w - 6, 4);
  ctx.fillRect(x + 3, y + 3, 4, h - 6);
  ctx.fillStyle = darken(def.primaryColor, 0.22);
  ctx.fillRect(x + 3, y + h - 7, w - 6, 4);
  ctx.fillRect(x + w - 7, y + 3, 4, h - 6);
  // Wood-pole roof: rows of planks.
  ctx.fillStyle = def.roofColor;
  ctx.fillRect(x + 6, y + 6, w - 12, h * 0.45);
  ctx.strokeStyle = darken(def.roofColor, 0.4);
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const yy = y + 6 + (i + 1) * (h * 0.45 / 5);
    ctx.beginPath();
    ctx.moveTo(x + 6, yy);
    ctx.lineTo(x + w - 6, yy);
    ctx.stroke();
  }
  // Banner / sword icon.
  ctx.fillStyle = enemy ? '#a04040' : '#cdd1d4';
  ctx.fillRect(x + w / 2 - 1, y + h * 0.55, 2, h * 0.25);
  // Door.
  ctx.fillStyle = '#1a0e08';
  ctx.fillRect(x + w / 2 - 4, y + h - 12, 8, 9);
}

function drawArcheryRange(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, def: any, enemy: boolean,
) {
  // Open-walled training yard.
  ctx.fillStyle = darken(def.primaryColor, 0.1);
  ctx.fillRect(x + 3, y + 3, w - 6, h - 6);
  // Inner sandy floor.
  ctx.fillStyle = '#c8b070';
  ctx.fillRect(x + 6, y + 6, w - 12, h - 12);
  // Roof corner pillars.
  ctx.fillStyle = '#3a2818';
  ctx.fillRect(x + 3, y + 3, 5, 5);
  ctx.fillRect(x + w - 8, y + 3, 5, 5);
  ctx.fillRect(x + 3, y + h - 8, 5, 5);
  ctx.fillRect(x + w - 8, y + h - 8, 5, 5);
  // Roof banner overlay on the north strip.
  ctx.fillStyle = def.roofColor;
  ctx.fillRect(x + 3, y + 3, w - 6, 5);
  // Targets (round dummies) inside the yard.
  ctx.fillStyle = '#9b3a3a';
  ctx.beginPath();
  ctx.arc(x + w * 0.7, y + h * 0.55, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f0c850';
  ctx.beginPath();
  ctx.arc(x + w * 0.7, y + h * 0.55, 1.5, 0, Math.PI * 2);
  ctx.fill();
  // Faction banner.
  ctx.fillStyle = enemy ? '#a04040' : '#588958';
  ctx.fillRect(x + w / 2 - 1, y + 1, 2, 6);
}

function drawStable(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, def: any, enemy: boolean,
) {
  // Wood plank walls.
  ctx.fillStyle = def.primaryColor;
  ctx.fillRect(x + 3, y + 3, w - 6, h - 6);
  // Horizontal plank lines.
  ctx.strokeStyle = darken(def.primaryColor, 0.3);
  ctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) {
    const yy = y + 3 + i * ((h - 6) / 5);
    ctx.beginPath();
    ctx.moveTo(x + 3, yy);
    ctx.lineTo(x + w - 3, yy);
    ctx.stroke();
  }
  // Roof.
  ctx.fillStyle = def.roofColor;
  ctx.beginPath();
  ctx.moveTo(x + 1, y + h * 0.35);
  ctx.lineTo(x + w / 2, y + 2);
  ctx.lineTo(x + w - 1, y + h * 0.35);
  ctx.lineTo(x + w / 2, y + h * 0.5);
  ctx.closePath();
  ctx.fill();
  // Stall doors (two openings).
  ctx.fillStyle = '#1a0e08';
  ctx.fillRect(x + w * 0.25 - 4, y + h - 14, 8, 11);
  ctx.fillRect(x + w * 0.75 - 4, y + h - 14, 8, 11);
  // Faction marker.
  ctx.fillStyle = enemy ? '#a04040' : '#e0c060';
  ctx.fillRect(x + w / 2 - 1, y + 1, 2, 5);
}

function drawGenericBuilding(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, def: any,
) {
  ctx.fillStyle = def.primaryColor;
  ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
  ctx.fillStyle = lighten(def.primaryColor, 0.15);
  ctx.fillRect(x + 2, y + 2, w - 4, 4);
  ctx.fillRect(x + 2, y + 2, 4, h - 4);
  ctx.fillStyle = darken(def.primaryColor, 0.22);
  ctx.fillRect(x + 2, y + h - 6, w - 4, 4);
  ctx.fillRect(x + w - 6, y + 2, 4, h - 4);
  // Roof.
  ctx.fillStyle = def.roofColor;
  ctx.fillRect(x + 5, y + 5, w - 10, h - 10);
  // Door.
  ctx.fillStyle = '#1a0e08';
  ctx.fillRect(x + w / 2 - 3, y + h - 8, 6, 6);
}

// A single wall segment: a squat stone block with a lit top face, a shadowed
// base, and merlon notches along the top so a line of them reads as a rampart.
function drawWall(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, def: any,
) {
  const inset = 3;
  const bx = x + inset, by = y + inset, bw = w - inset * 2, bh = h - inset * 2;
  // Body.
  ctx.fillStyle = def.primaryColor;
  ctx.fillRect(bx, by, bw, bh);
  // Lit top band + shadowed base for a bit of relief.
  ctx.fillStyle = lighten(def.primaryColor, 0.22);
  ctx.fillRect(bx, by, bw, Math.max(3, bh * 0.28));
  ctx.fillStyle = darken(def.primaryColor, 0.3);
  ctx.fillRect(bx, by + bh - Math.max(3, bh * 0.22), bw, Math.max(3, bh * 0.22));
  // Merlon notches across the top edge.
  ctx.fillStyle = darken(def.primaryColor, 0.15);
  const notch = Math.max(3, bw / 5);
  for (let nx = bx + notch * 0.5; nx < bx + bw - notch * 0.5; nx += notch * 2) {
    ctx.fillRect(nx, by - 2, notch, 3);
  }
  // Mortar seam.
  ctx.strokeStyle = darken(def.primaryColor, 0.35);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(bx, by + bh * 0.5); ctx.lineTo(bx + bw, by + bh * 0.5);
  ctx.stroke();
}

// A gate: the same stone frame as a wall, with two posts and either a closed
// timber door or an open dark archway between them.
function drawGate(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, def: any, open: boolean,
) {
  const inset = 3;
  const bx = x + inset, by = y + inset, bw = w - inset * 2, bh = h - inset * 2;
  const post = Math.max(4, bw * 0.22);
  // Stone posts (left + right).
  ctx.fillStyle = def.primaryColor;
  ctx.fillRect(bx, by, post, bh);
  ctx.fillRect(bx + bw - post, by, post, bh);
  ctx.fillStyle = lighten(def.primaryColor, 0.22);
  ctx.fillRect(bx, by, post, 3);
  ctx.fillRect(bx + bw - post, by, post, 3);
  // Lintel across the top.
  ctx.fillStyle = darken(def.primaryColor, 0.12);
  ctx.fillRect(bx, by, bw, Math.max(3, bh * 0.2));
  // Between the posts: open archway or closed door.
  const ix = bx + post, iw = bw - post * 2, iy = by + Math.max(3, bh * 0.2), ih = bh - Math.max(3, bh * 0.2);
  if (open) {
    ctx.fillStyle = 'rgba(10, 8, 6, 0.6)';
    ctx.fillRect(ix, iy, iw, ih);
  } else {
    // Timber door with plank seams + iron studs.
    ctx.fillStyle = def.roofColor ?? '#6b4a2a';
    ctx.fillRect(ix, iy, iw, ih);
    ctx.strokeStyle = darken(def.roofColor ?? '#6b4a2a', 0.3);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ix + iw / 2, iy); ctx.lineTo(ix + iw / 2, iy + ih);
    ctx.stroke();
    ctx.fillStyle = '#3a3230';
    ctx.fillRect(ix + 1, iy + 1, 2, 2);
    ctx.fillRect(ix + iw - 3, iy + 1, 2, 2);
  }
}

// ============================================================================
// FX
// ============================================================================

function drawBirds(input: RendererInput) {
  const { ctx, camera, game } = input;
  for (const b of game.birds) {
    // Each bird may have its own sprite key now; fall back to the legacy
    // flock stamp if its individual sprite isn't loaded yet.
    const key = (b as any).spriteKey ?? 'sprite-birds-flock';
    const sprite = getSprite(key) ?? getSprite('sprite-birds-flock');
    if (!sprite) continue;
    const projY = (b.pos.y - camera.y) * ISO_Y_SCALE + camera.y;
    const bob = Math.sin(b.flapPhase) * 2;
    const size = 32 * b.scale;
    const flip = b.velX < 0;
    const t = b.life / b.maxLife;
    const a = Math.min(1, t * 4, (1 - t) * 4);
    ctx.globalAlpha = Math.max(0, a);
    if (flip) {
      ctx.save();
      ctx.translate(b.pos.x, projY + bob);
      ctx.scale(-1, 1);
      ctx.drawImage(sprite, -size / 2, -size / 2, size, size);
      ctx.restore();
    } else {
      ctx.drawImage(sprite, b.pos.x - size / 2, projY - size / 2 + bob, size, size);
    }
    ctx.globalAlpha = 1;
  }
}

function drawBeams(input: RendererInput) {
  const { ctx, camera, game } = input;
  for (const b of game.beams) {
    const t = b.age / b.maxAge;
    const alpha = Math.max(0, 1 - t);
    const dx = b.to.x - b.from.x;
    const dy = b.to.y - b.from.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) continue;
    // Project endpoints with iso Y squish.
    const fy = (b.from.y - camera.y) * ISO_Y_SCALE + camera.y;
    const ty2 = (b.to.y - camera.y) * ISO_Y_SCALE + camera.y;
    const ddx = b.to.x - b.from.x;
    const ddy = ty2 - fy;
    const screenDist = Math.hypot(ddx, ddy);
    const screenAngle = Math.atan2(ddy, ddx);
    // Use the AI-painted arrow trail sprite if available; else draw a glow line.
    const sprite = getSprite('vfx-brahmastra-arrow');
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(b.from.x, fy);
    ctx.rotate(screenAngle);
    if (sprite && b.key === 'brahmastra') {
      const h = 64;
      ctx.drawImage(sprite, 0, -h / 2, screenDist, h);
    } else {
      // Procedural glow beam (Indrastra or fallback).
      const color = b.key === 'indrastra' ? '#8acfff' : '#ffd860';
      const grd = ctx.createLinearGradient(0, 0, screenDist, 0);
      grd.addColorStop(0, color);
      grd.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = grd;
      ctx.fillRect(0, -4, screenDist, 8);
      // White hot core line.
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.fillRect(0, -1, screenDist, 2);
    }
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function drawProjectiles(input: RendererInput) {
  const { ctx, camera } = input;
  // Iso-project a world point to camera-only space so the projectile aligns
  // with the visually rendered (iso-squished) sprites.
  const projY = (worldY: number) => (worldY - camera.y) * ISO_Y_SCALE + camera.y;
  for (const p of input.game.projectiles) {
    if (!p.ranged) {
      // Melee tracer: brief static line, fades out. Drawn straight between
      // shooter and target with iso-projected Y.
      const a = 1 - (p.elapsed / p.duration);
      ctx.globalAlpha = Math.max(0, a);
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p.from.x, projY(p.from.y) - 18);
      ctx.lineTo(p.to.x, projY(p.to.y) - 18);
      ctx.stroke();
      continue;
    }
    // Animated arrow: interpolate from shoulder-height of shooter to chest of
    // target, with a parabolic arc so the arrow visibly rises and falls.
    const t = Math.min(1, p.elapsed / p.duration);
    const fx = p.from.x, fy = projY(p.from.y) - 22;     // shoulder
    const tx = p.to.x,   ty = projY(p.to.y) - 18;       // chest
    const dist = Math.hypot(tx - fx, ty - fy);
    // Arc height scales with distance (max 28 px so it stays readable).
    const arcH = Math.min(28, Math.max(8, dist * 0.18));
    const lerpX = fx + (tx - fx) * t;
    const lerpY = fy + (ty - fy) * t;
    const arc = -arcH * 4 * t * (1 - t);   // peaks at t=0.5, returns to 0 at ends
    const x = lerpX;
    const y = lerpY + arc;
    // Tangent (direction of travel) for arrow rotation. Derivative of the
    // path: dx/dt = (tx-fx), dy/dt = (ty-fy) + arcH*4*(2t-1).
    const dx = tx - fx;
    const dy = (ty - fy) + arcH * 4 * (2 * t - 1);
    const angle = Math.atan2(dy, dx);
    // Motion-blur trail behind the arrow (decays toward the tail).
    const trailSegments = 4;
    for (let s = 1; s <= trailSegments; s++) {
      const trailT = Math.max(0, t - s * 0.04);
      if (trailT <= 0) break;
      const trailX = fx + (tx - fx) * trailT;
      const trailY = fy + (ty - fy) * trailT + (-arcH * 4 * trailT * (1 - trailT));
      ctx.globalAlpha = 0.22 * (1 - s / trailSegments);
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(trailX, trailY);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    // Shaft (thick + dark outline for contrast against grass).
    ctx.strokeStyle = '#2a1a08';
    ctx.lineWidth = 3.6;
    ctx.beginPath();
    ctx.moveTo(-14, 0);
    ctx.lineTo(10, 0);
    ctx.stroke();
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(-14, 0);
    ctx.lineTo(10, 0);
    ctx.stroke();
    // Arrowhead — bright cream filled triangle.
    ctx.fillStyle = '#fff4d0';
    ctx.strokeStyle = '#2a1a08';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(15, 0);
    ctx.lineTo(7, -3.2);
    ctx.lineTo(7, 3.2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Fletching (V at the tail).
    ctx.strokeStyle = '#f0e0a0';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(-14, 0);
    ctx.lineTo(-18, -3);
    ctx.moveTo(-14, 0);
    ctx.lineTo(-18, 3);
    ctx.stroke();
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function drawFlyingNumbers(input: RendererInput) {
  const { ctx, camera, game } = input;
  ctx.font = 'bold 14px "Cinzel", "Georgia", serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (const n of game.flyingNumbers) {
    const t = n.age / n.maxAge;
    const alpha = Math.max(0, 1 - t);
    const projY = (n.pos.y - camera.y) * ISO_Y_SCALE + camera.y;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#000';
    ctx.fillText(n.text, n.pos.x + 1, projY + 1);
    ctx.fillStyle = n.color;
    ctx.fillText(n.text, n.pos.x, projY);
  }
  ctx.globalAlpha = 1;
}

function drawDeathPuffs(input: RendererInput) {
  // Drawn in camera-only space (after the iso restore), so world Y must be
  // projected through the iso squish to line up with where the entity died.
  const { ctx, camera } = input;
  for (const d of input.game.deathPuffs) {
    const t = d.age / d.maxAge;
    const projY = (d.pos.y - camera.y) * ISO_Y_SCALE + camera.y;
    ctx.globalAlpha = Math.max(0, 1 - t);
    ctx.fillStyle = '#a04040';
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const r = 3 + t * 16;
      // Squash the expanding ring's Y radius too, so the puff hugs the ground.
      ctx.beginPath();
      ctx.arc(d.pos.x + Math.cos(a) * r, projY + Math.sin(a) * r * ISO_Y_SCALE, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

function drawSelectionRings(input: RendererInput) {
  // Drawn in camera-only space (after iso restore). For units, use the
  // iso-projected Y so the ring sits under the visible sprite's feet.
  const { ctx, game, camera } = input;
  for (const id of game.selectedIds) {
    const e = game.entities.get(id);
    if (!e || e.dead) continue;
    // Heroes get a thicker gold ring with a pulsing aura.
    const isHero = e.typeId === 'rama' || e.typeId === 'lakshmana';
    if (isHero) {
      ctx.strokeStyle = '#ffd860';
      ctx.lineWidth = 2.5;
    } else {
      ctx.strokeStyle = COLORS.selectRing;
      ctx.lineWidth = 1.5;
    }
    if (e.kind === 'unit') {
      const projY = (e.pos.y - camera.y) * ISO_Y_SCALE + camera.y;
      if (isHero) {
        // Outer halo (animated).
        const pulse = 0.5 + 0.5 * Math.sin(game.simTime * 4);
        ctx.save();
        ctx.globalAlpha = 0.35 + 0.25 * pulse;
        ctx.fillStyle = '#ffd860';
        ctx.beginPath();
        ctx.ellipse(e.pos.x, projY - 1, e.radius + 8, (e.radius + 8) * 0.45, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      ctx.beginPath();
      ctx.ellipse(e.pos.x, projY - 1, e.radius + 4, (e.radius + 4) * 0.42, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (e.tilePos && e.sizeTiles) {
      const x = e.tilePos.tx * TILE_SIZE;
      const y = e.tilePos.ty * TILE_SIZE;
      const w = e.sizeTiles.w * TILE_SIZE;
      const h = e.sizeTiles.h * TILE_SIZE;
      // Building drawn under iso squish; project the four corners.
      const py0 = (y - camera.y) * ISO_Y_SCALE + camera.y;
      const py1 = ((y + h) - camera.y) * ISO_Y_SCALE + camera.y;
      ctx.strokeRect(x - 2, py0 - 2, w + 4, (py1 - py0) + 4);
    } else {
      const projY = (e.pos.y - camera.y) * ISO_Y_SCALE + camera.y;
      ctx.beginPath();
      ctx.arc(e.pos.x, projY, e.radius + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function drawPlacementGhost(input: RendererInput) {
  // Drawn in camera-only space (after the iso restore). The footprint tiles
  // being tested by canPlace() live on the iso ground plane, so project the
  // rect's Y through the iso squish (and scale its height) so the ghost
  // overlays the true footprint.
  const { ctx, game, camera, mouseWorld } = input;
  const p = game.pendingPlacement;
  if (!p) return;
  const def = BUILDING_DEFS[p.typeId];
  if (!def) return;
  const tx = Math.floor(mouseWorld.x / TILE_SIZE);
  const ty = Math.floor(mouseWorld.y / TILE_SIZE);
  const ok = game.world.canPlace(tx, ty, def.sizeTiles.w, def.sizeTiles.h);
  const x = tx * TILE_SIZE;
  const w = def.sizeTiles.w * TILE_SIZE;
  const worldY = ty * TILE_SIZE;
  const projTop = (worldY - camera.y) * ISO_Y_SCALE + camera.y;
  const projH = def.sizeTiles.h * TILE_SIZE * ISO_Y_SCALE;
  ctx.fillStyle = ok ? COLORS.buildPlaceOk : COLORS.buildPlaceBad;
  ctx.fillRect(x, projTop, w, projH);
  ctx.strokeStyle = ok ? COLORS.selectRing : COLORS.hostileRing;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x + 0.5, projTop + 0.5, w - 1, projH - 1);
  // Sketch the building outline at the cursor at low opacity.
  ctx.globalAlpha = 0.4;
  if (def.sizeTiles.w >= 3) {
    drawGenericBuilding(ctx, x, projTop, w, projH, def);
  }
  ctx.globalAlpha = 1;
}

// Draw the fog-of-war overlay on top of everything else (still inside the
// world transform, so it scrolls/zooms with the camera).
function drawFogOfWar(input: RendererInput) {
  if (!input.game.fogEnabled) return;
  const { ctx, camera, game } = input;
  const tile = TILE_SIZE;
  const x0 = Math.max(0, Math.floor(camera.x / tile));
  const y0 = Math.max(0, Math.floor(camera.y / tile));
  const x1 = Math.min(game.world.w, Math.ceil((camera.x + camera.viewW / camera.zoom) / tile) + 1);
  const y1 = Math.min(game.world.h, Math.ceil((camera.y + (camera.viewH / camera.zoom) / ISO_Y_SCALE) / tile) + 1);
  // Render in two passes: first explored-but-not-visible dims, then unseen
  // pitch-black. We draw rectangles per tile; cheaper than per-pixel alpha
  // and easier to read.
  const fog = game.fog;
  for (let ty = y0; ty < y1; ty++) {
    for (let tx = x0; tx < x1; tx++) {
      const v = fog.vis[ty * fog.w + tx];
      if (v === VIS_VISIBLE) continue;
      if (v === VIS_EXPLORED) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      } else {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.86)';
      }
      ctx.fillRect(tx * tile, ty * tile, tile, tile);
    }
  }
}

function drawHealthBars(input: RendererInput) {
  const { ctx, game, camera } = input;
  const fog = game.fog;
  const fogOn = game.fogEnabled;
  // Viewport bounds in world coordinates (the world-Y span is stretched by
  // 1/ISO_Y_SCALE because the ground plane is squished on screen). Entities
  // outside this (plus a margin) can't have a visible bar.
  const margin = 64;
  const wx0 = camera.x - margin;
  const wx1 = camera.x + camera.viewW / camera.zoom + margin;
  const wy0 = camera.y - margin;
  const wy1 = camera.y + (camera.viewH / camera.zoom) / ISO_Y_SCALE + margin;
  for (const e of game.entities.values()) {
    if (e.dead) continue;
    if (e.pos.x < wx0 || e.pos.x > wx1 || e.pos.y < wy0 || e.pos.y > wy1) continue;
    // Fog gate — same policy as render()'s drawable pass: own entities always;
    // other units only when currently visible; other buildings/resources once
    // explored. Prevents HP bars + hostile markers leaking positions into fog.
    if (fogOn && e.owner !== 1) {
      const ftx = Math.floor(e.pos.x / TILE_SIZE);
      const fty = Math.floor(e.pos.y / TILE_SIZE);
      const v = fog.get(ftx, fty);
      if (e.kind === 'unit') {
        if (v !== VIS_VISIBLE) continue;
      } else if (v === VIS_UNSEEN) {
        continue;
      }
    }
    let show = false;
    if (e.kind === 'unit' && e.hp < e.maxHp) show = true;
    if (e.kind === 'building' && (e.isConstructionSite || e.hp < e.maxHp)) show = true;
    if (game.selectedIds.has(e.id)) show = true;
    if (!show) continue;
    const w = e.kind === 'unit' ? 26 : (e.sizeTiles?.w ?? 1) * TILE_SIZE - 6;
    const h = 4;
    const x = e.pos.x - w / 2;
    // Place above the visible unit/building. Units render upright with sprite
    // anchored at their iso-projected feet; building sprites occupy a squished
    // footprint. Anchor the bar above the iso-projected top of the entity.
    let y: number;
    if (e.kind === 'unit') {
      const projY = (e.pos.y - camera.y) * ISO_Y_SCALE + camera.y;
      y = projY - 56; // above the sprite's head
    } else if (e.kind === 'building' && e.tilePos) {
      const topWorldY = e.tilePos.ty * TILE_SIZE;
      const projTop = (topWorldY - camera.y) * ISO_Y_SCALE + camera.y;
      y = projTop - 10;
    } else {
      const projY = (e.pos.y - camera.y) * ISO_Y_SCALE + camera.y;
      y = projY - e.radius - 10;
    }
    ctx.fillStyle = COLORS.hpBg;
    ctx.fillRect(x, y, w, h);
    const pct = Math.max(0, e.hp / Math.max(1, e.maxHp));
    // Color by faction for selected, by health for damaged.
    ctx.fillStyle = pct > 0.5 ? COLORS.hpGood : (pct > 0.25 ? '#dfb030' : COLORS.hpBad);
    ctx.fillRect(x, y, w * pct, h);
    if (e.isConstructionSite) {
      const p = e.buildProgress ?? 0;
      ctx.strokeStyle = COLORS.uiAccent;
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = COLORS.uiAccent;
      ctx.fillRect(x, y + h + 1, w * p, 1);
    }
    // Tiny enemy marker (red triangle) for hostile entities.
    if (e.owner !== 1 && e.owner !== 0) {
      ctx.fillStyle = '#ff5050';
      ctx.beginPath();
      ctx.moveTo(x + w + 2, y);
      ctx.lineTo(x + w + 6, y + h / 2);
      ctx.lineTo(x + w + 2, y + h);
      ctx.closePath();
      ctx.fill();
    }
  }
}

function drawDragBox(input: RendererInput) {
  if (!input.dragging || !input.dragStartScreen) return;
  const { ctx, mouseScreen, dragStartScreen } = input;
  const x = Math.min(mouseScreen.x, dragStartScreen.x);
  const y = Math.min(mouseScreen.y, dragStartScreen.y);
  const w = Math.abs(mouseScreen.x - dragStartScreen.x);
  const h = Math.abs(mouseScreen.y - dragStartScreen.y);
  ctx.fillStyle = 'rgba(126, 255, 122, 0.12)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = COLORS.selectRing;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);
}

function drawRallyMarkers(input: RendererInput) {
  const { ctx, game, camera } = input;
  for (const id of game.selectedIds) {
    const e = game.entities.get(id);
    if (!e || e.kind !== 'building' || !e.rallyPoint) continue;
    const center = camera.worldToScreen(e.pos);
    const target = camera.worldToScreen(e.rallyPoint);
    ctx.strokeStyle = COLORS.selectRing;
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(center.x, center.y);
    ctx.lineTo(target.x, target.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.selectRing;
    ctx.beginPath();
    ctx.arc(target.x, target.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ============================================================================
// Color helpers
// ============================================================================

// Draw a sprite tinted with the given color using an offscreen canvas so the
// tint only affects opaque pixels of the sprite (no rectangle bleed).
const _tintCache = new Map<string, HTMLCanvasElement>();
function drawTintedSprite(
  ctx: CanvasRenderingContext2D,
  sprite: HTMLCanvasElement | HTMLImageElement,
  x: number, y: number, w: number, h: number,
  tint: string, flip: boolean,
) {
  const sw = (sprite as any).width || (sprite as any).naturalWidth;
  const sh = (sprite as any).height || (sprite as any).naturalHeight;
  const key = `${sw}x${sh}`;
  let tmp = _tintCache.get(key);
  if (!tmp) {
    tmp = document.createElement('canvas');
    tmp.width = sw;
    tmp.height = sh;
    _tintCache.set(key, tmp);
  }
  const tx = tmp.getContext('2d')!;
  tx.clearRect(0, 0, sw, sh);
  tx.drawImage(sprite as any, 0, 0);
  tx.globalCompositeOperation = 'source-atop';
  tx.fillStyle = tint;
  tx.fillRect(0, 0, sw, sh);
  tx.globalCompositeOperation = 'source-over';
  if (flip) {
    ctx.save();
    ctx.translate(x + w / 2, y);
    ctx.scale(-1, 1);
    ctx.drawImage(tmp, -w / 2, 0, w, h);
    ctx.restore();
  } else {
    ctx.drawImage(tmp, x, y, w, h);
  }
}

function hexToRgb(hex: string): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

function lighten(hex: string, amt: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgb(${Math.min(255, r + 255 * amt)},${Math.min(255, g + 255 * amt)},${Math.min(255, b + 255 * amt)})`;
}

function darken(hex: string, amt: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgb(${Math.max(0, r - 255 * amt)},${Math.max(0, g - 255 * amt)},${Math.max(0, b - 255 * amt)})`;
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}
