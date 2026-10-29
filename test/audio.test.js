/*
 * Node test for audio.js using a strict fake Web Audio shim.
 * Run: node test/audio.test.js
 * Loads audio.js into a vm sandbox with fake timers + fake AudioContext,
 * calls every API method (before and after unlock), runs the music
 * scheduler with advancing fake time, and asserts nothing throws / no
 * invalid values reach AudioParams.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

let violations = [];
function bad(msg) { violations.push(msg); throw new Error(msg); }
function fin(v, what) { if (typeof v !== 'number' || !isFinite(v)) bad(what + ' non-finite: ' + v); }
function tm(v, what) { fin(v, what); if (v < 0) bad(what + ' negative time: ' + v); }

let nodeCount = 0, liveNodes = new Set(), sources = new Set();

// ---------------- fake timers ----------------
let timers = [], timerId = 1, fakeNowMs = 0;
function fakeSetTimeout(fn, ms) { const id = timerId++; timers.push({ id, at: fakeNowMs + (ms || 0), fn }); return id; }
function fakeClearTimeout(id) { timers = timers.filter(t => t.id !== id); }

// ---------------- fake Web Audio ----------------
class AudioParam {
  constructor(v, name) { this._v = v; this.name = name; this.events = 0; this.inputs = 0; }
  get value() { return this._v; }
  set value(v) { fin(v, this.name + '.value'); this._v = v; }
  setValueAtTime(v, t) { fin(v, this.name); tm(t, this.name); this._v = v; this.events++; return this; }
  linearRampToValueAtTime(v, t) { fin(v, this.name); tm(t, this.name); this._v = v; this.events++; return this; }
  exponentialRampToValueAtTime(v, t) { fin(v, this.name); tm(t, this.name); if (v === 0 || (v > 0) !== (this._v >= 0)) bad('expRamp to ' + v + ' from ' + this._v); this._v = v; this.events++; return this; }
  setTargetAtTime(v, t, c) { fin(v, this.name); tm(t, this.name); fin(c, 'timeConstant'); if (c <= 0) bad('timeConstant <= 0'); this.events++; return this; }
  setValueCurveAtTime(c, t, d) { tm(t, this.name); return this; }
  cancelScheduledValues(t) { tm(t, 'cancel'); return this; }
  cancelAndHoldAtTime(t) { tm(t, 'cancelHold'); return this; }
}
class AudioNode {
  constructor(ctx) { this.context = ctx; this.outs = new Set(); this.id = ++nodeCount; liveNodes.add(this); }
  connect(dest) {
    if (!dest) bad('connect to null');
    if (!(dest instanceof AudioNode) && !(dest instanceof AudioParam)) bad('connect to non-node');
    if (dest instanceof AudioParam) dest.inputs++;
    this.outs.add(dest); return dest;
  }
  disconnect() { this.outs.clear(); liveNodes.delete(this); }
}
class Scheduled extends AudioNode {
  constructor(ctx) { super(ctx); this.started = false; this.stopAt = Infinity; this.onended = null; this.ended = false; sources.add(this); }
  start(t, off) { if (this.started) bad('start twice'); tm(t || 0, 'start'); if (off != null) tm(off, 'offset'); this.started = true; this.startAt = t || 0; }
  stop(t) { if (!this.started) bad('stop before start'); tm(t || 0, 'stop'); this.stopAt = Math.min(this.stopAt === Infinity ? Infinity : this.stopAt, t || 0); if (this.stopAt === Infinity) this.stopAt = t || 0; }
}
class Osc extends Scheduled {
  constructor(c) { super(c); this.type = 'sine'; this.frequency = new AudioParam(440, 'frequency'); this.detune = new AudioParam(0, 'detune'); }
  set type(v) { if (!['sine', 'square', 'sawtooth', 'triangle'].includes(v)) bad('bad osc type ' + v); this._t = v; }
  get type() { return this._t; }
}
class BufSrc extends Scheduled {
  constructor(c) { super(c); this.buffer = null; this.loop = false; this.playbackRate = new AudioParam(1, 'playbackRate'); this.detune = new AudioParam(0, 'detune'); }
  start(t, off) { if (!this.buffer) bad('buffer source without buffer'); super.start(t, off); }
}
class Buffer {
  constructor(ch, len, sr) { if (!(len > 0)) bad('buffer len ' + len); this.numberOfChannels = ch; this.length = len; this.sampleRate = sr; this.duration = len / sr; this._d = []; for (let i = 0; i < ch; i++) this._d.push(new Float32Array(len)); }
  getChannelData(i) { return this._d[i]; }
}
class FakeCtx {
  constructor() { this.currentTime = 0; this.sampleRate = 48000; this.state = 'suspended'; this.destination = new AudioNode(this); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  close() { return Promise.resolve(); }
  createOscillator() { return new Osc(this); }
  createGain() { const n = new AudioNode(this); n.gain = new AudioParam(1, 'gain'); return n; }
  createBiquadFilter() {
    const n = new AudioNode(this); n.frequency = new AudioParam(350, 'bqfreq'); n.Q = new AudioParam(1, 'Q'); n.gain = new AudioParam(0, 'bqgain'); n.detune = new AudioParam(0, 'bqdetune');
    let ty = 'lowpass'; Object.defineProperty(n, 'type', { get: () => ty, set: v => { if (!['lowpass', 'highpass', 'bandpass', 'lowshelf', 'highshelf', 'peaking', 'notch', 'allpass'].includes(v)) bad('bad filter ' + v); ty = v; } });
    return n;
  }
  createBufferSource() { return new BufSrc(this); }
  createBuffer(ch, len, sr) { return new Buffer(ch, len, sr); }
  createConvolver() { const n = new AudioNode(this); n.buffer = null; n.normalize = true; return n; }
  createDynamicsCompressor() { const n = new AudioNode(this); for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[k] = new AudioParam(0, k); n.reduction = 0; return n; }
  createWaveShaper() { const n = new AudioNode(this); n.curve = null; n.oversample = 'none'; return n; }
  createStereoPanner() { const n = new AudioNode(this); n.pan = new AudioParam(0, 'pan'); return n; }
  createDelay() { const n = new AudioNode(this); n.delayTime = new AudioParam(0, 'delayTime'); return n; }
}

// Advance fake time: audio clock + timers + fire onended for finished sources.
function advance(seconds, ctx, step = 0.01) {
  const end = fakeNowMs + seconds * 1000;
  while (fakeNowMs < end) {
    fakeNowMs += step * 1000;
    if (ctx && ctx.state === 'running') ctx.currentTime += step;
    timers.sort((a, b) => a.at - b.at);
    while (timers.length && timers[0].at <= fakeNowMs) { const t = timers.shift(); t.fn(); }
    if (ctx) for (const s of sources) {
      if (!s.ended && s.started && s.stopAt <= ctx.currentTime) {
        s.ended = true; sources.delete(s);
        if (typeof s.onended === 'function') s.onended();
      }
    }
  }
}

// ---------------- load ----------------
const warnings = [];
const sandbox = {
  console: { log: console.log, warn: (...a) => warnings.push(a.join(' ')), error: console.error },
  setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, setInterval: () => 0, clearInterval: () => {},
  Math, Float32Array, Promise, Object, Array, String, Number, Error,
};
sandbox.window = sandbox;
let createdCtx = null;
sandbox.AudioContext = function () { createdCtx = new FakeCtx(); return createdCtx; };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'audio.js'), 'utf8'), sandbox, { filename: 'audio.js' });
const LA = sandbox.LanternAudio;
assert(LA, 'window.LanternAudio not defined');

const KINDS = ['blue', 'orange', 'green', 'purple', undefined, 'weird'];
const POWERS = ['multiball', 'fireball', 'zen', 'spooky', 'magnet', 'lightning', '', null];
function callAll(rounds) {
  for (let r = 0; r < rounds; r++) {
    for (let n = 1; n <= 40; n++) { LA.pegHit(n, KINDS[n % KINDS.length]); LA.brickHit(n, KINDS[(n + 1) % KINDS.length]); }
    LA.pegHit(0); LA.pegHit(-5, 'blue'); LA.pegHit(NaN); LA.pegHit('3', 'green'); LA.brickHit();
    LA.launch(); LA.bounceWall(); LA.bounceWall(); LA.bucket(); LA.extraBall();
    for (const p of POWERS) LA.powerReady(p);
    LA.powerReady();
    LA.explosion(); LA.fire(); LA.zap(); LA.magnet();
    LA.tension(); LA.tension(); LA.stopTension(); LA.stopTension(); LA.tension();
    LA.feverStart(); LA.feverMusic(); LA.feverMusic(); LA.stopFever(); LA.stopFever(); LA.feverMusic();
    LA.levelClear(); LA.fail(); LA.ui(); LA.ballLost();
    LA.destinyThink(); LA.destinyThink(0.5); LA.destinyThink(-1); LA.destinyThink(NaN); LA.destinyThink(1e9); LA.destinyThink('2');
    LA.stopDestinyThink(); LA.stopDestinyThink(); LA.destinyThink(0.9);
    for (const p of [0, 1, 50, 150, 300, 1e6, -20, NaN, undefined, null, 'x']) LA.destinyFound(p);
    for (const i of [0, 1, 2, 3, 4, 7, -1, NaN, undefined, '2', 2.7]) LA.turnChange(i);
    for (const n of [1, 2, 3, 0, 4, 99, -3, NaN, undefined, '2']) LA.star(n);
    LA.powerUnlocked(); LA.powerUnlocked('extra'); LA.chapterClear(); LA.chapterClear(1); LA.matchEnd(); LA.matchEnd({});
    LA.setMusicVolume(0.3); LA.setMusicVolume(2); LA.setMusicVolume(-1); LA.setMusicVolume('x'); LA.setMusicVolume(NaN);
    LA.setSfxVolume(0.7); LA.setSfxVolume(undefined);
    LA.music.duck(true); LA.music.duck(false);
    LA.music.start(r); LA.music.start(-7); LA.music.start(1e9); LA.music.start('2'); LA.music.start(undefined);
    LA.setPaused(true); LA.pegHit(1, 'blue'); LA.setPaused(false);
  }
}

let ok = 0;
function step(name, fn) {
  try { fn(); ok++; console.log('  ok  ' + name); }
  catch (e) { console.log('  FAIL ' + name + ': ' + (e && e.stack || e)); process.exitCode = 1; }
}

console.log('LanternAudio test');
step('all methods before unlock are no-ops', () => {
  callAll(2);
  LA.music.stop(); LA.setPaused(true); LA.setPaused(false);
  assert.strictEqual(createdCtx, null, 'context created before unlock');
});
step('unlock creates context, idempotent', () => {
  LA.music.start(1);   // pending track before unlock
  LA.unlock(); LA.unlock(); LA.unlock();
  assert(createdCtx, 'no ctx');
  return Promise.resolve();
});
step('context running after unlock', () => { assert.strictEqual(createdCtx.state, 'running'); });
const ctx = createdCtx;

step('every method several times after unlock', () => { callAll(3); advance(2, ctx); });

step('peg chain voice cap', () => {
  for (let n = 1; n <= 100; n++) LA.pegHit(n, 'blue');
  assert(LA._debug.pegVoices() <= 24, 'peg voices ' + LA._debug.pegVoices());
});

step('music scheduler runs 5 minutes per track with fake time', () => {
  for (let tr = 0; tr < 3; tr++) {
    LA.music.stop();
    LA.music.start(tr);
    const before = sources.size;
    advance(300, ctx, 0.02);
    assert(LA._debug.activeVoices() < 200, 'voice leak? active=' + LA._debug.activeVoices());
  }
});

step('scheduler survives suspend (paused) and timer stalls', () => {
  LA.setPaused(true);
  advance(5, ctx);
  LA.setPaused(false);
  // simulate a big timer stall: jump audio clock 3 seconds without timers
  ctx.currentTime += 3;
  advance(5, ctx);
  LA.music.duck(true); advance(1, ctx); LA.music.duck(false);
});

step('new feature sfx: destiny, turns, stars, campaign, match', () => {
  const methods = ['destinyThink', 'stopDestinyThink', 'destinyFound', 'turnChange', 'star', 'powerUnlocked', 'chapterClear', 'matchEnd'];
  for (const m of methods) assert.strictEqual(typeof LA[m], 'function', m + ' missing');
  const v0 = LA._debug.activeVoices();
  LA.destinyThink(1.2); advance(0.4, ctx); LA.stopDestinyThink(); advance(0.3, ctx);
  LA.destinyThink(0.9); advance(1.5, ctx);                      // self-stops
  LA.destinyThink(3); LA.destinyFound(150);                     // found cuts think
  for (let p = 0; p <= 300; p += 25) LA.destinyFound(p);
  for (let i = 0; i < 4; i++) LA.turnChange(i);
  LA.star(1); advance(0.35, ctx); LA.star(2); advance(0.35, ctx); LA.star(3);
  LA.powerUnlocked(); LA.chapterClear(); LA.matchEnd();
  LA.setPaused(true); LA.destinyThink(); LA.star(1); LA.setPaused(false);
  assert(LA._debug.activeVoices() > v0, 'expected new voices');
  advance(6, ctx);
});

step('fever music plays out and auto-stops', () => {
  LA.feverStart(); LA.feverMusic();
  advance(20, ctx);
});

step('voices are freed after sounds finish', () => {
  LA.music.stop();
  advance(10, ctx);
  const act = LA._debug.activeVoices();
  assert(act === 0, 'active voices remaining: ' + act);
});

step('no leaked live nodes beyond static graph', () => {
  // static graph is ~20 nodes; allow slack
  assert(liveNodes.size < 60, 'live (connected) nodes: ' + liveNodes.size);
});

step('music.start during suspended ctx and stop/start spam', () => {
  ctx.state = 'suspended';
  for (let i = 0; i < 20; i++) { LA.music.start(i); LA.music.stop(); }
  LA.music.start(4);
  ctx.state = 'running';
  advance(10, ctx);
  LA.music.stop(); advance(3, ctx);
});

step('no AudioParam / node violations and no internal errors', () => {
  assert.strictEqual(violations.length, 0, violations.slice(0, 5).join('\n'));
  assert.strictEqual(LA._lastError, undefined, 'internal error caught: ' + (LA._lastError && LA._lastError.stack));
  assert.strictEqual(warnings.length, 0, warnings.join('\n'));
});

console.log(process.exitCode ? 'FAILED' : ('PASSED (' + ok + ' checks)'));
