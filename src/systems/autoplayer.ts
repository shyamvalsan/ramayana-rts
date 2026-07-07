// AutoPlayer — an AI that drives the *human* side of the Bala Kanda scenario
// so we can watch the game play itself for testing & demos. Uses the public
// agent API exposed on window.rts.api, so it stays decoupled from internal
// game state.
//
// Behavior priorities (re-evaluated ~2 Hz):
//   1. Villagers: gather wood (for towers) and stone. Re-task idle ones every tick.
//   2. Build a Watchtower near the Yajna when wood ≥ 50 + stone ≥ 100 and a
//      tower isn't already going up.
//   3. Rama + Lakshmana: focus the most-dangerous visible enemy if any are
//      close to the Yajna; otherwise stand guard a few tiles from the altar.
//   4. Train more villagers from the TC if pop allows — wait, there's no TC
//      in Bala Kanda. So we skip that.
//
// All decisions are intentionally simple — this is for testing the visual
// loop, not a competitive bot.

import type { AgentApi, EntitySnapshot } from '@/agentApi';
import type { Vec2 } from '@/core/types';

interface AutoPlayerOpts {
  api: AgentApi;
  /** Player id we're controlling (default 1). */
  playerId?: number;
  /** Where to anchor defensive units (typically the Yajna). */
  anchorPos: Vec2;
  /** Tile-grid offsets where we'll try to drop watchtowers around the anchor. */
  towerSpots?: Vec2[];
}

const TILE = 32;

const DEFAULT_TOWER_SPOTS: Vec2[] = [
  { x: -6, y: -3 }, { x: 6, y: -3 }, { x: -6, y: 3 }, { x: 6, y: 3 },
  { x: 0, y: -8 }, { x: 0, y: 8 }, { x: -10, y: 0 }, { x: 10, y: 0 },
];

export class AutoPlayer {
  private api: AgentApi;
  private playerId: number;
  private anchor: Vec2;
  private towerSpots: Vec2[];
  private lastDecisionAt = 0;
  private towerIdx = 0;
  /** Hero ids currently pulled out of the fight to heal. */
  private retreating = new Set<number>();
  enabled = false;
  // Stash a snapshot for the UI to read.
  lastAction = '';

  constructor(opts: AutoPlayerOpts) {
    this.api = opts.api;
    this.playerId = opts.playerId ?? 1;
    this.anchor = opts.anchorPos;
    this.towerSpots = opts.towerSpots ?? DEFAULT_TOWER_SPOTS;
  }

  setAnchor(p: Vec2) { this.anchor = p; }

  tick(now: number) {
    if (!this.enabled) return;
    if (now - this.lastDecisionAt < 0.5) return;
    this.lastDecisionAt = now;

    const resources = this.api.getResources(this.playerId);
    const myUnits = this.api.listEntities({ owner: this.playerId, kind: 'unit' });
    const myBuildings = this.api.listEntities({ owner: this.playerId, kind: 'building' });
    const villagers = myUnits.filter(e => e.typeId === 'villager');
    const heroes = myUnits.filter(e => e.typeId === 'rama' || e.typeId === 'lakshmana');
    const military = myUnits.filter(e =>
      e.typeId === 'spearman' || e.typeId === 'archer' || e.typeId === 'cavalry');
    const enemies = this.api.listEntities({ kind: 'unit' }).filter(e => e.owner !== this.playerId && e.owner !== 0);
    const sites = myBuildings.filter(e => e.isConstructionSite);
    const trainer = myBuildings.find(e =>
      !e.isConstructionSite && (e.typeId === 'town_center' || e.typeId === 'hermitage'));
    const economyMode = !!trainer; // heroes-only missions have no villager trainer

    // 1) Villagers. Flee raids, keep construction moving, otherwise gather —
    //    food first (abilities + training), then wood, then stone, then gold.
    for (const v of villagers) {
      const threat = enemies.find(t => sqDist(t.pos, v.pos) < 180 * 180);
      if (threat) {
        this.api.issueCommand(v.id, { kind: 'move', pos: { ...this.anchor } });
        continue;
      }
      if (v.state !== 'idle') continue;
      if (sites.length > 0) {
        const site = closestEntityToPos(sites, v.pos)!;
        this.api.issueCommand(v.id, { kind: 'build', targetId: site.id });
        continue;
      }
      const need = resources.food < 250 ? 'berry_bush'
                 : resources.wood < 200 ? 'tree'
                 : resources.stone < 150 ? 'stone_vein'
                 : resources.gold < 150 ? 'gold_vein'
                 : 'tree';
      let node = this.api.findClosest(v.pos, e => e.kind === 'resource' && e.typeId === need && (e.resourceRemaining ?? 0) > 0);
      // Fall back to any resource if the preferred kind is exhausted.
      node ??= this.api.findClosest(v.pos, e => e.kind === 'resource' && e.typeId !== 'stone_vein' && (e.resourceRemaining ?? 0) > 0);
      if (node) {
        this.api.issueCommand(v.id, { kind: 'gather', targetId: node.id });
        this.lastAction = `Villager → gather ${node.typeId}`;
      }
    }

    if (economyMode) {
      // 2a) Keep villagers flowing (up to 8) and the army training.
      if (villagers.length < 8 && (trainer.productionQueueLength ?? 0) === 0 && resources.food >= 50) {
        this.api.train(trainer.id, 'villager');
      }
      // 2b) Build order: house at pop cap, then barracks, then archery range,
      //     then towers. One site at a time.
      if (sites.length === 0) {
        const has = (tid: string) => myBuildings.some(b => b.typeId === tid && !b.isConstructionSite);
        if (resources.popUsed >= resources.popCap - 1 && resources.wood >= 30) {
          this.tryBuildNear('house', 5);
        } else if (!has('barracks') && resources.wood >= 175) {
          this.tryBuildNear('barracks', 6);
        } else if (has('barracks') && !has('archery_range') && resources.wood >= 175) {
          this.tryBuildNear('archery_range', 6);
        } else if (resources.wood >= 60 && resources.stone >= 110 && this.towerIdx < Math.min(4, this.towerSpots.length)) {
          const slot = this.towerSpots[this.towerIdx];
          const tx = Math.floor(this.anchor.x / TILE) + slot.x;
          const ty = Math.floor(this.anchor.y / TILE) + slot.y;
          const builder = villagers.length > 0 ? closestEntityToPos(villagers, this.anchor) : null;
          const r = this.api.build('watchtower', { tx, ty }, builder ? [builder.id] : undefined);
          if (r.ok) this.towerIdx++;
        }
      }
      // 2c) Train military: alternate spear/archer, small queues.
      for (const b of myBuildings) {
        if (b.isConstructionSite || (b.productionQueueLength ?? 0) >= 2) continue;
        if (b.typeId === 'barracks' && resources.food >= 35 && resources.wood >= 25) {
          this.api.train(b.id, 'spearman');
        } else if (b.typeId === 'archery_range' && resources.wood >= 30 && resources.gold >= 25) {
          this.api.train(b.id, 'archer');
        } else if (b.typeId === 'stable' && resources.food >= 60 && resources.gold >= 40) {
          this.api.train(b.id, 'cavalry');
        }
      }
      // 2d) Military stance: pile onto threats near home, else hold a guard post.
      const threats0 = enemies.filter(e => sqDist(e.pos, this.anchor) < 520 * 520);
      for (const m of military) {
        if (m.state === 'attacking') continue;
        if (threats0.length > 0) {
          const t = closestEntityToPos(threats0, m.pos)!;
          this.api.issueCommand(m.id, { kind: 'attack', targetId: t.id });
        } else if (m.state === 'idle' && sqDist(m.pos, this.anchor) > 200 * 200) {
          this.api.issueCommand(m.id, { kind: 'move', pos: { x: this.anchor.x + 60, y: this.anchor.y - 40 } });
        }
      }
    } else {
      // Heroes-only mission: original tower-ring behavior.
      if (sites.length === 0 && resources.wood >= 60 && resources.stone >= 110 && this.towerIdx < this.towerSpots.length) {
        const slot = this.towerSpots[this.towerIdx];
        const tx = Math.floor(this.anchor.x / TILE) + slot.x;
        const ty = Math.floor(this.anchor.y / TILE) + slot.y;
        const builder = villagers.length > 0 ? closestEntityToPos(villagers, this.anchor) : null;
        const r = this.api.build('watchtower', { tx, ty }, builder ? [builder.id] : undefined);
        if (r.ok) this.towerIdx++;
      }
    }

    // 3) Heroes: engage only threats near the anchor (LEASHED — chasing wave
    //    spawns to the map edge abandons the Yajna and the VIPs beside it).
    //    Bosses first, then whatever is closest to the anchor. Cast abilities
    //    on cooldown when worthwhile.
    const LEASH = 480;
    const threats = enemies.filter(e => sqDist(e.pos, this.anchor) < LEASH * LEASH);
    if (threats.length > 0) {
      // Kill order: anything actively mauling a VIP (Vishwamitra dying loses
      // the mission even with the Yajna standing), then whatever is closest
      // to the altar. Dueling the boss while her escort burns the Yajna loses
      // too — she becomes the target when she IS the pressing threat.
      const vips = this.api.listEntities({ owner: this.playerId })
        .filter(e => e.typeId === 'vishwamitra' || e.typeId === 'rishi' || e.typeId === 'yajna');
      const nearVip = (t: EntitySnapshot) => vips.some(v => sqDist(t.pos, v.pos) < 70 * 70);
      threats.sort((a, b) =>
        (sqDist(a.pos, this.anchor) - (nearVip(a) ? 1e9 : 0)) -
        (sqDist(b.pos, this.anchor) - (nearVip(b) ? 1e9 : 0)));
      const boss = threats.find(e => e.typeId === 'tataka' || e.typeId === 'subahu' || e.typeId === 'maricha');
      const target = threats[0];
      const now = this.api.getState().simTime;
      for (const h of heroes) {
        // Retreat discipline: a hero below 35% pulls out of the fight (Rama
        // dying is mission over) and stays out until he heals past 60%.
        if (this.retreating.has(h.id)) {
          if (h.hp > h.maxHp * 0.6) this.retreating.delete(h.id);
          else {
            const nearestThreat = threats[0];
            const away = kiteAway(h.pos, nearestThreat ? nearestThreat.pos : this.anchor, this.anchor);
            this.api.issueCommand(h.id, { kind: 'move', pos: away });
            continue;
          }
        } else if (h.hp < h.maxHp * 0.35) {
          this.retreating.add(h.id);
          this.lastAction = `${h.typeId} retreats to heal`;
        }
        // Abilities: Rama sweeps the thickest cluster with Brahmastra; Lakshmana
        // bolts the boss (or the nearest threat when things get crowded).
        if (h.typeId === 'rama' && threats.length >= 3 && this.ready(h, 'brahmastra', now, 60)) {
          const aim = densestThreat(threats, h.pos);
          const r = this.api.castAbility(h.id, 'brahmastra', aim);
          if (r.ok) { this.lastAction = 'Rama → Brahmastra'; continue; }
        }
        if (h.typeId === 'lakshmana' && (boss || threats.length >= 2) && this.ready(h, 'indrastra', now, 45)) {
          const aim = (boss ?? threats[0]).pos;
          const r = this.api.castAbility(h.id, 'indrastra', aim);
          if (r.ok) { this.lastAction = 'Lakshmana → Indrastra'; continue; }
        }
        // Kite: heroes are archers — when melee is on top of them, stutter-step
        // away (biased back toward the anchor) instead of trading punches.
        // Wounded heroes disengage earlier.
        const kiteR = h.hp < h.maxHp * 0.4 ? 95 : 70;
        const meleeOnTop = threats.find(t => MELEE.has(t.typeId) && sqDist(t.pos, h.pos) < kiteR * kiteR);
        if (meleeOnTop) {
          const away = kiteAway(h.pos, meleeOnTop.pos, this.anchor);
          this.api.issueCommand(h.id, { kind: 'move', pos: away });
          this.lastAction = `${h.typeId} kites`;
          continue;
        }
        if (h.state === 'attacking') continue;
        this.api.issueCommand(h.id, { kind: 'attack', targetId: target.id });
      }
      this.lastAction = `Heroes → attack ${target.typeId}`;
    } else if (enemies.length > 0) {
      // Wave inbound but still outside the leash: meet it partway. Take a
      // forward post toward the nearest enemy, capped at 300px from the
      // anchor, so the fight happens before the rakshasas reach the sages.
      enemies.sort((a, b) => sqDist(a.pos, this.anchor) - sqDist(b.pos, this.anchor));
      const inc = enemies[0].pos;
      const dx = inc.x - this.anchor.x, dy = inc.y - this.anchor.y;
      const d = Math.hypot(dx, dy) || 1;
      const post = { x: this.anchor.x + (dx / d) * 300, y: this.anchor.y + (dy / d) * 300 };
      for (const h of heroes) {
        if (h.state === 'attacking') continue;
        if (sqDist(h.pos, post) > 80 * 80) {
          this.api.issueCommand(h.id, { kind: 'move', pos: { x: post.x + (h.typeId === 'rama' ? -40 : 40), y: post.y } });
        }
      }
      this.lastAction = 'Heroes → forward post';
    } else {
      for (const h of heroes) {
        if (h.state !== 'idle') continue;
        // Stand-guard offsets.
        const off = h.typeId === 'rama' ? { x: -64, y: 32 } : { x: 64, y: 32 };
        const dist = sqDist(h.pos, { x: this.anchor.x + off.x, y: this.anchor.y + off.y });
        if (dist > 40 * 40) {
          this.api.issueCommand(h.id, { kind: 'move', pos: { x: this.anchor.x + off.x, y: this.anchor.y + off.y } });
        }
      }
    }
  }

  private ready(h: EntitySnapshot, abilityId: string, now: number, cooldown: number): boolean {
    const last = h.abilityLastUsed?.[abilityId];
    return last === undefined || now - last >= cooldown;
  }

  /** Place a building on the first free spot in expanding rings around the
   *  anchor, assigning the closest villager to build it. */
  private tryBuildNear(typeId: string, radiusTiles: number): boolean {
    const ax = Math.floor(this.anchor.x / TILE);
    const ay = Math.floor(this.anchor.y / TILE);
    const villagers = this.api.listEntities({ owner: this.playerId, kind: 'unit', typeId: 'villager' });
    const builder = villagers.length ? closestEntityToPos(villagers, this.anchor) : null;
    for (let r = 3; r <= radiusTiles + 5; r++) {
      for (let attempt = 0; attempt < 12; attempt++) {
        const ang = (attempt / 12) * Math.PI * 2 + r * 0.7;
        const tx = ax + Math.round(Math.cos(ang) * r);
        const ty = ay + Math.round(Math.sin(ang) * r);
        if (!this.api.canPlace(typeId, { tx, ty })) continue;
        const res = this.api.build(typeId, { tx, ty }, builder ? [builder.id] : undefined);
        if (res.ok) {
          this.lastAction = `Built ${typeId}`;
          return true;
        }
      }
    }
    return false;
  }
}

const MELEE = new Set(['grunt_enemy', 'spearman_enemy', 'cavalry_enemy', 'tataka', 'subahu']);

/** Step ~110px away from the attacker, biased 30% back toward home so kiting
 *  circles the anchor instead of drifting off the map. */
function kiteAway(from: Vec2, threat: Vec2, home: Vec2): Vec2 {
  const dx = from.x - threat.x, dy = from.y - threat.y;
  const d = Math.hypot(dx, dy) || 1;
  const hx = home.x - from.x, hy = home.y - from.y;
  const hd = Math.hypot(hx, hy) || 1;
  return {
    x: from.x + (dx / d) * 110 * 0.7 + (hx / hd) * 110 * 0.3,
    y: from.y + (dy / d) * 110 * 0.7 + (hy / hd) * 110 * 0.3,
  };
}

/** Aim point that catches the most threats: the threat whose 150px neighborhood
 *  is densest, weighted toward the direction away from the caster so the
 *  Brahmastra line sweeps through the cluster. */
function densestThreat(threats: EntitySnapshot[], from: Vec2): Vec2 {
  let best = threats[0].pos;
  let bestScore = -1;
  for (const t of threats) {
    let score = 0;
    for (const o of threats) {
      if (sqDist(t.pos, o.pos) < 150 * 150) score++;
    }
    if (score > bestScore) { bestScore = score; best = t.pos; }
  }
  // Aim slightly past the cluster so the beam pierces through it.
  const dx = best.x - from.x, dy = best.y - from.y;
  const d = Math.hypot(dx, dy) || 1;
  return { x: best.x + (dx / d) * 60, y: best.y + (dy / d) * 60 };
}

function sqDist(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function closestEntityToPos(list: EntitySnapshot[], p: Vec2): EntitySnapshot | null {
  let best: EntitySnapshot | null = null;
  let bestD = Infinity;
  for (const e of list) {
    const d = sqDist(e.pos, p);
    if (d < bestD) { best = e; bestD = d; }
  }
  return best;
}
