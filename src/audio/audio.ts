// Procedural audio via Web Audio API. No external assets — all sounds are
// synthesized on the fly. Two layers:
//
//   - SFX: short clips for select, build, deposit, train-complete, attack,
//          arrow whoosh, death. Triggered by gameplay events.
//   - Music: a slow ambient drone in C minor with layered melodic motifs.
//            Tries to feel "epic Indian"-ish via a pentatonic-leaning scale
//            and tabla-like percussion accents.
//
// The user can toggle audio on/off from the UI. Browsers require a user
// gesture before starting audio; we initialize on first click.

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let musicGain: GainNode | null = null;
let sfxGain: GainNode | null = null;
let musicStarted = false;
let muted = false;

export function initAudio() {
  if (ctx) return;
  ctx = new AudioContext();
  masterGain = ctx.createGain();
  // Respect a mute chosen before init (e.g. from the title screen).
  masterGain.gain.value = muted ? 0 : 0.6;
  masterGain.connect(ctx.destination);
  musicGain = ctx.createGain();
  musicGain.gain.value = 0.45;
  musicGain.connect(masterGain);
  sfxGain = ctx.createGain();
  sfxGain.gain.value = 0.8;
  sfxGain.connect(masterGain);
}

export function setMuted(m: boolean) {
  muted = m;
  if (masterGain) masterGain.gain.value = m ? 0 : 0.6;
}

export function toggleMuted(): boolean {
  setMuted(!muted);
  return muted;
}

export function isMuted() { return muted; }

// ----------- SFX -----------

function envelope(g: GainNode, t0: number, attack: number, decay: number, peak: number) {
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
}

function tone(freq: number, durMs: number, opts: { type?: OscillatorType; detune?: number; gain?: number } = {}) {
  if (!ctx || !sfxGain) return;
  const t0 = ctx.currentTime;
  const o = ctx.createOscillator();
  o.type = opts.type ?? 'sine';
  o.frequency.value = freq;
  if (opts.detune) o.detune.value = opts.detune;
  const g = ctx.createGain();
  envelope(g, t0, 0.005, durMs / 1000, opts.gain ?? 0.3);
  o.connect(g).connect(sfxGain);
  o.start(t0);
  o.stop(t0 + durMs / 1000 + 0.05);
}

function noiseBurst(durMs: number, freq: number, gainAmt: number) {
  if (!ctx || !sfxGain) return;
  const t0 = ctx.currentTime;
  const buf = ctx.createBuffer(1, ctx.sampleRate * (durMs / 1000), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq;
  bp.Q.value = 6;
  const g = ctx.createGain();
  envelope(g, t0, 0.005, durMs / 1000, gainAmt);
  src.connect(bp).connect(g).connect(sfxGain);
  src.start(t0);
  src.stop(t0 + durMs / 1000 + 0.05);
}

export const Sfx = {
  click() { tone(820, 60, { type: 'triangle', gain: 0.18 }); },
  select() {
    tone(620, 80, { type: 'sine', gain: 0.22 });
    setTimeout(() => tone(820, 80, { type: 'sine', gain: 0.18 }), 35);
  },
  command() { tone(440, 70, { type: 'triangle', gain: 0.18 }); },
  buildPlace() {
    tone(330, 100, { type: 'square', gain: 0.16 });
    setTimeout(() => tone(440, 100, { type: 'triangle', gain: 0.15 }), 70);
  },
  buildComplete() {
    tone(523.25, 120, { type: 'triangle', gain: 0.18 }); // C
    setTimeout(() => tone(659.25, 120, { type: 'triangle', gain: 0.18 }), 100); // E
    setTimeout(() => tone(783.99, 180, { type: 'triangle', gain: 0.22 }), 220); // G
  },
  deposit() {
    tone(880, 60, { type: 'sine', gain: 0.18 });
    setTimeout(() => tone(1175, 80, { type: 'sine', gain: 0.18 }), 40);
  },
  chop() { noiseBurst(60, 1800, 0.28); },
  attack() { noiseBurst(50, 2400, 0.22); },
  arrow() { noiseBurst(40, 3200, 0.16); },
  death() {
    noiseBurst(120, 600, 0.32);
    setTimeout(() => tone(220, 200, { type: 'sawtooth', gain: 0.18 }), 60);
  },
  trainComplete() {
    tone(440, 100, { type: 'triangle', gain: 0.18 });
    setTimeout(() => tone(587.33, 120, { type: 'triangle', gain: 0.2 }), 90);
    setTimeout(() => tone(880, 220, { type: 'triangle', gain: 0.25 }), 200);
  },
  victory() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      setTimeout(() => tone(f, 300, { type: 'triangle', gain: 0.32 }), i * 180);
    });
  },
  defeat() {
    [440, 415.30, 392, 349.23].forEach((f, i) => {
      setTimeout(() => tone(f, 400, { type: 'sawtooth', gain: 0.28 }), i * 220);
    });
  },
  warning() {
    tone(880, 100, { type: 'square', gain: 0.18 });
    setTimeout(() => tone(880, 100, { type: 'square', gain: 0.18 }), 160);
  },
};

// ----------- Music -----------
// Layered ambient drone in C minor (Indian raga-ish pentatonic) with a slow
// moving melodic line and tabla-like percussion. Built around scheduled
// oscillator nodes, refreshed every few seconds so we don't have one huge
// pre-scheduled timeline.

const SCALE_C_MINOR_PENT = [261.63, 311.13, 349.23, 392.00, 466.16, 523.25]; // C, Eb, F, G, Bb, C

function makeDrone(freq: number, type: OscillatorType, gainVal: number, detune = 0): OscillatorNode | null {
  if (!ctx || !musicGain) return null;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  o.detune.value = detune;
  const g = ctx.createGain();
  g.gain.value = gainVal;
  o.connect(g).connect(musicGain);
  o.start();
  return o;
}

let droneNodes: OscillatorNode[] = [];
function startDrones() {
  // Two layered drones: root + fifth, with slow detune for movement.
  droneNodes.push(makeDrone(SCALE_C_MINOR_PENT[0] / 2, 'sine', 0.18)!);
  droneNodes.push(makeDrone(SCALE_C_MINOR_PENT[3] / 2, 'sine', 0.12, 8)!);
  droneNodes.push(makeDrone(SCALE_C_MINOR_PENT[0], 'triangle', 0.04, -4)!);

  // Slow LFO on detune so the drone feels alive.
  if (!ctx) return;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.07;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 14;
  lfo.connect(lfoGain);
  droneNodes.forEach((d) => lfoGain.connect(d.detune));
  lfo.start();
  droneNodes.push(lfo);
}

function scheduleMelody() {
  if (!ctx || !musicGain) return;
  const now = ctx.currentTime;
  // Pick a short motif of 5–7 notes from the pentatonic scale.
  const motifLen = 5 + Math.floor(Math.random() * 3);
  let prevIdx = 2;
  for (let i = 0; i < motifLen; i++) {
    const dir = Math.random() < 0.5 ? -1 : 1;
    prevIdx = Math.max(0, Math.min(SCALE_C_MINOR_PENT.length - 1, prevIdx + dir + (Math.random() < 0.3 ? dir : 0)));
    const f = SCALE_C_MINOR_PENT[prevIdx];
    const t = now + i * (0.6 + Math.random() * 0.4);
    const dur = 0.5 + Math.random() * 0.5;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f;
    const g = ctx.createGain();
    envelope(g, t, 0.04, dur, 0.07);
    o.connect(g).connect(musicGain);
    o.start(t);
    o.stop(t + dur + 0.1);
  }
}

function schedulePercussion() {
  if (!ctx || !musicGain) return;
  const now = ctx.currentTime;
  // Tabla-ish on the 1 and the 3 of an 8-beat measure.
  const beats = [0, 2, 3, 5];
  for (const b of beats) {
    const t = now + b * 0.5;
    // Body: low sine pluck.
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(80, t + 0.1);
    const g = ctx.createGain();
    envelope(g, t, 0.005, 0.18, 0.18);
    o.connect(g).connect(musicGain);
    o.start(t);
    o.stop(t + 0.25);
  }
}

let musicScheduler: number | null = null;
export function startMusic() {
  if (!ctx) return;
  if (musicStarted) return;
  musicStarted = true;
  startDrones();
  scheduleMelody();
  schedulePercussion();
  musicScheduler = window.setInterval(() => {
    if (currentMusicState === 'combat') scheduleCombatLoop();
    else if (currentMusicState === 'boss') scheduleBossLoop();
    else if (currentMusicState === 'victory' || currentMusicState === 'defeat') {
      // The one-shot sting already played on the state transition; schedule
      // nothing here (drones only) so peaceful plinks don't play under it.
    }
    else { scheduleMelody(); schedulePercussion(); }
  }, 4000);
}

export function stopMusic() {
  if (!musicStarted) return;
  musicStarted = false;
  if (musicScheduler !== null) window.clearInterval(musicScheduler);
  musicScheduler = null;
  for (const n of droneNodes) {
    try { n.stop(); } catch {}
  }
  droneNodes = [];
}

// ----- State-aware music -----
export type MusicState = 'peaceful' | 'tension' | 'combat' | 'boss' | 'victory' | 'defeat';
let currentMusicState: MusicState = 'peaceful';

export function setMusicState(state: MusicState) {
  if (state === currentMusicState) return;
  currentMusicState = state;
  if (!ctx || !musicGain) return;
  // Trigger an immediate musical sting to mark the transition.
  if (state === 'tension') scheduleTensionSting();
  else if (state === 'combat') scheduleCombatLoop();
  else if (state === 'boss') scheduleBossLoop();
  else if (state === 'victory') { Sfx.victory(); scheduleVictorySting(); }
  else if (state === 'defeat') Sfx.defeat();
}

export function getMusicState(): MusicState { return currentMusicState; }

function scheduleTensionSting() {
  if (!ctx || !musicGain) return;
  const now = ctx.currentTime;
  for (let i = 0; i < 3; i++) {
    const t = now + i * 0.25;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = 87.31 * (1 + i * 0.05); // F2 area
    const g = ctx.createGain();
    envelope(g, t, 0.01, 0.45, 0.10);
    o.connect(g).connect(musicGain);
    o.start(t); o.stop(t + 0.6);
  }
}

function scheduleCombatLoop() {
  if (!ctx || !musicGain) return;
  const now = ctx.currentTime;
  // Driving low-octave ostinato + tabla taps at 110 BPM equivalent.
  const beats = [0, 0.27, 0.54, 0.81, 1.08, 1.35, 1.62, 1.89];
  const note = [110, 110, 130.81, 110, 110, 146.83, 130.81, 110]; // A2 / C3 / D3 pattern
  for (let i = 0; i < beats.length; i++) {
    const t = now + beats[i];
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = note[i];
    const g = ctx.createGain();
    envelope(g, t, 0.005, 0.16, 0.09);
    o.connect(g).connect(musicGain);
    o.start(t); o.stop(t + 0.3);
    // Tabla tap.
    const oo = ctx.createOscillator();
    oo.type = 'sine';
    oo.frequency.setValueAtTime(180, t);
    oo.frequency.exponentialRampToValueAtTime(80, t + 0.08);
    const gg = ctx.createGain();
    envelope(gg, t, 0.003, 0.13, 0.16);
    oo.connect(gg).connect(musicGain);
    oo.start(t); oo.stop(t + 0.2);
  }
}

function scheduleBossLoop() {
  if (!ctx || !musicGain) return;
  const now = ctx.currentTime;
  // Heavier driving rhythm + dissonant choir chord.
  for (let i = 0; i < 4; i++) {
    const t = now + i * 0.5;
    // Big drum thud.
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(65, t);
    o.frequency.exponentialRampToValueAtTime(35, t + 0.18);
    const g = ctx.createGain();
    envelope(g, t, 0.005, 0.32, 0.28);
    o.connect(g).connect(musicGain);
    o.start(t); o.stop(t + 0.4);
  }
  // Dissonant minor 7 sustained "chorus".
  const chord = [110, 130.81, 155.56, 196];
  for (const f of chord) {
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f;
    const g = ctx.createGain();
    envelope(g, now, 0.4, 2.0, 0.05);
    o.connect(g).connect(musicGain);
    o.start(now); o.stop(now + 2.5);
  }
}

function scheduleVictorySting() {
  if (!ctx || !musicGain) return;
  const now = ctx.currentTime;
  // Triumphant rising 4-note motif over a sustained tonic.
  const melody = [261.63, 329.63, 392, 523.25]; // C, E, G, C
  for (let i = 0; i < melody.length; i++) {
    const t = now + i * 0.3;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = melody[i];
    const g = ctx.createGain();
    envelope(g, t, 0.04, 0.6, 0.12);
    o.connect(g).connect(musicGain);
    o.start(t); o.stop(t + 0.8);
  }
}
