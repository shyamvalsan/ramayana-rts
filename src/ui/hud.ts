// HUD distributed across the AoE-style framed layout. The DOM elements
// referenced (#top-bar, #bb-portrait, #bb-actions, #bb-minimap, #bb-system,
// #ui-overlay) are created in index.html. The HUD only fills these slots —
// it does not own positioning.

import { BUILDING_DEFS, PLAYER_BUILDABLE } from '@/config/buildings';
import { UNIT_DEFS } from '@/config/units';
import { ABILITY_DEFS } from '@/config/abilities';
import { TECH_DEFS } from '@/config/techs';
import type { Command, Entity, ResourceKind, Vec2 } from '@/core/types';
import type { Game } from '@/core/game';
import { buildingSpriteKey, unitSpriteKey } from '@/render/sprites';
import { asset } from '@/util/assets';

// NOTE: the gather-wood/food/gold/stone, build, patrol and move kinds below,
// plus the HUD's onCancelProduction/onSetRally callbacks, are currently
// dormant — no control emits or invokes them in the heroes-only mission.
// They stay declared because a later campaign phase re-enables the economy UI.
export type ActionKind =
  | 'gather-wood' | 'gather-food' | 'gather-gold' | 'gather-stone'
  | 'build' | 'stop' | 'attack-move' | 'patrol' | 'move';

export class HUD {
  private game: Game;
  private topBar: HTMLElement;
  private bbPortrait: HTMLElement;
  private bbActions: HTMLElement;
  private bbSystem: HTMLElement;
  private overlay: HTMLElement;
  private resEls: Record<ResourceKind | 'pop', HTMLElement> = {} as any;
  private buildMenu: HTMLElement;
  private toast: HTMLElement;
  private buildMenuOpen = false;

  onBuildSelect: (typeId: string) => void = () => {};
  onTrain: (building: Entity, typeId: string) => void = () => {};
  onResearch: (building: Entity, techId: string) => void = () => {};
  onCancelProduction: (building: Entity, index: number) => void = () => {};
  onSetRally: (building: Entity) => void = () => {};
  onUnitAction: (units: Entity[], kind: ActionKind, arg?: any) => void = () => {};
  onSystemButton: (kind: 'help' | 'settings' | 'audio') => void = () => {};
  /** Called when the player clicks an ability button. The host wires this to
   *  enter "casting" mode where the next left-click on the canvas chooses a
   *  target point. */
  onAbility: (caster: Entity, abilityId: string) => void = () => {};

  constructor(game: Game) {
    this.game = game;
    this.topBar = document.getElementById('top-bar')!;
    this.bbPortrait = document.getElementById('bb-portrait')!;
    this.bbActions = document.getElementById('bb-actions')!;
    this.bbSystem = document.getElementById('bb-system')!;
    this.overlay = document.getElementById('ui-overlay')!;

    this.renderTopBar();
    this.renderSystemColumn();

    this.buildMenu = el('div', { class: 'build-menu' });
    this.buildMenu.innerHTML = `<div class="title">Build</div><div class="buttons"></div>`;
    this.overlay.appendChild(this.buildMenu);

    this.toast = el('div', { class: 'toast' });
    this.overlay.appendChild(this.toast);
  }

  setGame(game: Game) {
    this.game = game;
  }

  // ----- Top bar -----
  // Five readouts — food first (it fuels hero abilities in the current
  // mission), then wood, gold, stone, population — plus the wave counter.
  private waveLabelEl: HTMLElement | null = null;
  private waveTimerEl: HTMLElement | null = null;
  private renderTopBar() {
    this.topBar.innerHTML = '';
    const wrap = el('div', { class: 'resource-bar-inline' });

    const addReadout = (
      key: ResourceKind | 'pop',
      icon: string,
      name: string,
      title: string,
      swatchColor: string,
    ) => {
      const row = el('div', { class: `resource ${key}` });
      row.title = title;
      const img = el('img', { class: 'res-icon', src: asset(`sprites/${icon}.webp`), alt: name });
      // If the icon fails to load, fall back to a colored swatch dot.
      (img as HTMLImageElement).onerror = () => {
        const sw = el('span', { class: 'swatch' });
        sw.style.background = swatchColor;
        img.replaceWith(sw);
      };
      row.appendChild(img);
      const v = el('span', { class: 'value' });
      v.textContent = key === 'pop' ? '0 / 0' : '0';
      row.appendChild(v);
      this.resEls[key] = v;
      wrap.appendChild(row);
    };

    addReadout('food', 'icon-food', 'Food',
      'Food — hunt deer to gather. Spent to cast hero abilities.', '#d8a13a');
    addReadout('wood', 'icon-wood', 'Wood',
      'Wood — chopped from trees.', '#8a5a2b');
    addReadout('gold', 'icon-gold', 'Gold',
      'Gold — mined from gold deposits.', '#f0c645');
    addReadout('stone', 'icon-stone', 'Stone',
      'Stone — quarried from stone deposits.', '#9aa0a6');
    addReadout('pop', 'icon-population', 'Population',
      'Population — units alive / current population cap.', '#7fb3ff');

    // Wave counter pill.
    const wave = el('div', { class: 'resource wave-counter' });
    wave.title = 'Current wave / total waves. The countdown shows time until the next wave spawns.';
    wave.innerHTML = `<span class="wave-icon">⚔</span><span class="wave-label">Wave 0</span><span class="wave-timer"></span>`;
    this.waveLabelEl = wave.querySelector('.wave-label') as HTMLElement;
    this.waveTimerEl = wave.querySelector('.wave-timer') as HTMLElement;
    wrap.appendChild(wave);

    this.topBar.appendChild(wrap);
  }

  // ----- System buttons column (right edge of bottom bar) -----
  private renderSystemColumn() {
    this.bbSystem.innerHTML = '';
    const btn = (id: string, label: string, kind: 'help' | 'settings' | 'audio') => {
      const b = el('button', { class: 'sys-btn', id, title: label });
      b.innerHTML = labelToIcon(kind);
      b.addEventListener('click', () => this.onSystemButton(kind));
      this.bbSystem.appendChild(b);
    };
    btn('sys-help', 'Help (F1)', 'help');
    btn('sys-set', 'Settings', 'settings');
    btn('sys-audio', 'Toggle audio', 'audio');
  }

  toggleBuildMenu() {
    this.buildMenuOpen = !this.buildMenuOpen;
    this.refreshBuildMenu();
  }

  closeBuildMenu() {
    this.buildMenuOpen = false;
    this.buildMenu.classList.remove('open');
  }

  refreshBuildMenu() {
    const list = this.buildMenu.querySelector('.buttons') as HTMLElement;
    list.innerHTML = '';
    const hasVillager = Array.from(this.game.selectedIds).some((id) => {
      const e = this.game.entities.get(id);
      return e?.kind === 'unit' && e.typeId === 'villager';
    });
    if (!this.buildMenuOpen || !hasVillager) {
      this.buildMenu.classList.remove('open');
      return;
    }
    this.buildMenu.classList.add('open');
    for (const id of PLAYER_BUILDABLE) {
      const def = BUILDING_DEFS[id];
      if (!def) continue;
      const btn = el('button', { class: 'act-btn' });
      const cost = costString(def.cost);
      btn.innerHTML = `<div class="lbl">${def.name}</div><div class="cost">${cost}</div>`;
      btn.addEventListener('click', () => { this.onBuildSelect(def.typeId); });
      list.appendChild(btn);
    }
  }

  update() {
    const bag = this.game.resources[this.game.playerId];
    this.resEls.wood.textContent = String(Math.floor(bag.wood));
    this.resEls.food.textContent = String(Math.floor(bag.food));
    this.resEls.gold.textContent = String(Math.floor(bag.gold));
    this.resEls.stone.textContent = String(Math.floor(bag.stone));
    this.resEls.pop.textContent = `${this.game.popUsed(this.game.playerId)} / ${this.game.popCap(this.game.playerId)}`;
    // Wave counter — only for missions that run a scheduled-wave director.
    // Economy/skirmish missions (showWaveCounter=false) hide the pill.
    const waveEl = this.waveLabelEl?.parentElement;
    const showWave = this.game.mission?.showWaveCounter !== false;
    if (waveEl) waveEl.style.display = showWave ? '' : 'none';
    if (showWave && this.waveLabelEl && this.waveTimerEl) {
      const dir: any = Array.from(this.game.ais.values())[0];
      const nextIdx = dir?.nextWaveIdx ?? 0;
      // The WaveDirector exposes its wave count; fall back to 5 (the legacy
      // scenario length) if an older director without totalWaves is running.
      const total = dir?.totalWaves ?? 5;
      const cur = Math.min(total, nextIdx);
      this.waveLabelEl.textContent = `Wave ${cur} / ${total}`;
      // Find the next wave's scheduled time via dir.nextWaveAt convention,
      // else fall back to a simple message.
      const nextAt = dir?.nextWaveScheduledAt ?? null;
      if (nextAt && this.game.simTime < nextAt) {
        const secs = Math.max(0, Math.ceil(nextAt - this.game.simTime));
        const m = Math.floor(secs / 60), s = secs % 60;
        this.waveTimerEl.textContent = `· next in ${m}:${s.toString().padStart(2, '0')}`;
      } else {
        this.waveTimerEl.textContent = nextIdx >= total ? '· final wave' : '· incoming…';
      }
    }
    this.updateBottomBar();
    this.updateToast();
    this.refreshBuildMenu();
  }

  private updateBottomBar() {
    const sel = Array.from(this.game.selectedIds)
      .map(id => this.game.entities.get(id))
      .filter((e): e is Entity => !!e && !e.dead);
    if (sel.length === 0) {
      this.bbPortrait.innerHTML = `<div class="placeholder">Select a unit or building to see details and commands.</div>`;
      this.bbActions.innerHTML = '';
      return;
    }
    const e = sel[0];
    this.renderPortrait(e, sel);
    this.renderActions(e, sel.filter(s => s.kind === 'unit'));
  }

  private renderPortrait(e: Entity, sel: Entity[]) {
    const isUnit = e.kind === 'unit';
    const isBuilding = e.kind === 'building';
    const def: any = isUnit ? UNIT_DEFS[e.typeId] : isBuilding ? BUILDING_DEFS[e.typeId] : null;
    const spriteKey = isUnit ? unitSpriteKey(e.typeId) : isBuilding ? buildingSpriteKey(e.typeId) : null;
    const portrait = spriteKey ? `<img src="${asset(`sprites/${spriteKey}.webp`)}" alt="" />` : '';
    const hpPct = Math.max(0, e.hp / Math.max(1, e.maxHp));
    const hpClass = hpPct > 0.5 ? '' : (hpPct > 0.25 ? 'low' : 'critical');
    let stats = '';
    if (isUnit) {
      stats = `<div class="stats"><b>HP</b> ${Math.ceil(e.hp)} / ${e.maxHp} · <b>${describeState(e)}</b></div>`;
      if (e.carrying) {
        stats += `<div class="stats">Carrying ${Math.floor(e.carrying.amount)} ${e.carrying.resource}</div>`;
      }
    } else if (isBuilding) {
      const status = e.isConstructionSite
        ? `Construction ${Math.floor((e.buildProgress ?? 0) * 100)}%`
        : 'Operational';
      stats = `<div class="stats"><b>HP</b> ${Math.ceil(e.hp)} / ${e.maxHp} · ${status}</div>`;
      if (e.productionQueue && e.productionQueue.length > 0) {
        const head = e.productionQueue[0];
        stats += `<div class="stats">Training ${UNIT_DEFS[head.typeId]?.name ?? head.typeId} (${Math.floor(head.progress * 100)}%)</div>`;
      }
    }
    const extra = sel.length > 1 ? `<div class="stats" style="color:#aacfff">+${sel.length - 1} more selected</div>` : '';
    this.bbPortrait.innerHTML = `
      <div class="portrait-frame">${portrait}</div>
      <div class="info">
        <div class="name">${def?.name ?? e.typeId}</div>
        <div class="hp-bar ${hpClass}"><div style="width:${hpPct * 100}%"></div></div>
        ${stats}
        ${extra}
      </div>
    `;
  }

  private renderActions(primary: Entity, units: Entity[]) {
    this.bbActions.innerHTML = '';

    const mkBtn = (label: string, hint: string, onClick: () => void) => {
      const b = el('button', { class: 'act-btn' });
      b.innerHTML = `<div class="lbl">${label}</div><div class="cost">${hint}</div>`;
      b.addEventListener('click', onClick);
      return b;
    };

    // Heroes get a special row above the action grid with their ability.
    if (primary.kind === 'unit' && (primary.typeId === 'rama' || primary.typeId === 'lakshmana')) {
      const abilityId = primary.typeId === 'rama' ? 'brahmastra' : 'indrastra';
      const def = ABILITY_DEFS[abilityId];
      const last = primary.abilityLastUsed?.[abilityId] ?? -1e9;
      const sinceCast = this.game.simTime - last;
      const ready = sinceCast >= def.cooldown;
      const cdFrac = Math.max(0, 1 - sinceCast / def.cooldown);
      const remaining = ready ? 0 : Math.ceil(def.cooldown - sinceCast);
      const label = el('div', { class: 'action-row-label' });
      label.textContent = 'Hero Ability';
      this.bbActions.appendChild(label);
      const row = el('div', { class: 'action-grid' });
      const b = el('button', { class: 'act-btn ability-btn' + (ready ? '' : ' on-cooldown') });
      b.title = def.description + (def.hotkey ? ` — Hotkey: ${def.hotkey}` : '');
      const icon = def.iconKey ? `<img class="ability-icon" src="${asset(`sprites/${def.iconKey}.webp`)}" alt="" />` : '';
      const cdMask = ready
        ? ''
        : `<div class="cd-mask" style="height:${cdFrac * 100}%"></div><div class="cd-text">${remaining}s</div>`;
      b.innerHTML = `${icon}${cdMask}<div class="lbl">${def.name}</div><div class="cost">${def.foodCost}F · ${def.hotkey ?? ''}</div>`;
      b.addEventListener('click', () => { if (ready) this.onAbility(primary, abilityId); });
      row.appendChild(b);
      this.bbActions.appendChild(row);
    }

    if (primary.kind === 'unit') {
      const grid = el('div', { class: 'action-grid' });
      grid.appendChild(mkBtn('Attack Move', 'A-click', () => this.onUnitAction(units, 'attack-move')));
      grid.appendChild(mkBtn('Hold',        'halt',    () => this.onUnitAction(units, 'stop')));
      // Builders get the build menu in economy missions.
      if (this.game.mission?.economyEnabled
        && units.some(u => UNIT_DEFS[u.typeId]?.canBuild)) {
        grid.appendChild(mkBtn('Build', 'B', () => this.onUnitAction(units, 'build')));
      }
      this.bbActions.appendChild(grid);
    } else if (primary.kind === 'building') {
      const def = BUILDING_DEFS[primary.typeId];
      if (def?.trains && !primary.isConstructionSite && primary.owner === this.game.playerId) {
        const label = el('div', { class: 'action-row-label' });
        label.textContent = 'Train';
        this.bbActions.appendChild(label);
        const grid = el('div', { class: 'action-grid' });
        for (const unitId of def.trains) {
          const udef = UNIT_DEFS[unitId];
          if (!udef) continue;
          grid.appendChild(mkBtn(udef.name, `${costString(udef.cost)} · ${udef.trainTime}s`, () => this.onTrain(primary, unitId)));
        }
        this.bbActions.appendChild(grid);
      }
      // Researchable blessings hosted at this building (mission-gated).
      const missionTechs = this.game.mission?.techIds ?? [];
      if (missionTechs.length && !primary.isConstructionSite && primary.owner === this.game.playerId) {
        const available = Object.values(TECH_DEFS).filter(t =>
          t.hostBuildings.includes(primary.typeId)
          && missionTechs.includes(t.id)
          && !this.game.hasTech(primary.owner, t.id));
        if (available.length) {
          const label = el('div', { class: 'action-row-label' });
          label.textContent = 'Blessings';
          this.bbActions.appendChild(label);
          const grid = el('div', { class: 'action-grid' });
          for (const t of available) {
            const queued = primary.productionQueue?.some(o => o.kind === 'tech' && o.typeId === t.id);
            const prereqMissing = (t.requires ?? []).find(r => !this.game.hasTech(primary.owner, r));
            const b = mkBtn(t.name,
              queued ? 'researching…'
                : prereqMissing ? `needs ${TECH_DEFS[prereqMissing]?.name ?? prereqMissing}`
                : `${costString(t.cost)} · ${t.researchTime}s`,
              () => { if (!queued && !prereqMissing) this.onResearch(primary, t.id); });
            b.title = t.description;
            if (queued || prereqMissing) b.setAttribute('disabled', 'true');
            grid.appendChild(b);
          }
          this.bbActions.appendChild(grid);
        }
      }
    }
  }

  private updateToast() {
    const n = this.game.notifications[this.game.notifications.length - 1];
    if (!n || n.age > 2.4) { this.toast.classList.remove('show'); return; }
    this.toast.textContent = n.text;
    this.toast.classList.add('show');
  }
}

function el(tag: string, attrs: Record<string, string> = {}): HTMLElement {
  const e = document.createElement(tag);
  for (const k of Object.keys(attrs)) {
    if (k === 'class') e.className = attrs[k];
    else e.setAttribute(k, attrs[k]);
  }
  return e;
}

function costString(cost: Partial<Record<ResourceKind, number>>): string {
  return (Object.entries(cost) as [ResourceKind, number][])
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${v}${k[0].toUpperCase()}`)
    .join(' ');
}

function describeState(e: Entity): string {
  if (!e.state) return 'Idle';
  switch (e.state.kind) {
    case 'idle': return 'Idle';
    case 'moving': return 'Moving';
    case 'gathering': return 'Gathering';
    case 'returning': return 'Returning';
    case 'building': return 'Building';
    case 'attacking': return 'Attacking';
    case 'attackMove': return 'Attack-move';
    // Future states render their raw kind instead of "undefined".
    default: return (e.state as { kind: string }).kind;
  }
}

function labelToIcon(kind: 'help' | 'settings' | 'audio'): string {
  switch (kind) {
    case 'help':     return '?';
    case 'settings': return '⚙';
    case 'audio':    return '♫';
  }
}
