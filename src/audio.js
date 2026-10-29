/*
 * Lantern Drop - audio.js
 * All sound effects and music, synthesized live with the Web Audio API.
 * No samples, no files, no libraries. All melodies are original.
 *
 * Classic script: assigns window.LanternAudio.
 * Every public method is a safe no-op before unlock() and never throws.
 */
(function (root) {
  'use strict';

  var AC = root.AudioContext || root.webkitAudioContext || null;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  var ctx = null;
  var G = {};                 // graph nodes (buses)
  var noiseBuf = null;
  var paused = false;
  var musicVol = 0.5;
  var sfxVol = 0.6;
  // Sliders are linear 0..1; loudness is roughly logarithmic, so square the value
  // to make the low half of the slider useful.
  function curve(v) { return v * v; }

  var userDuck = false;
  var feverActive = false;
  var feverTimer = null;
  var pendingTrack = null;
  var pegRoot = 62;           // midi note of the peg-chain scale root (follows track key)
  var lastBounce = -1;
  var warnCount = 0;
  var activeVoices = 0;
  var pegPool = [];
  var MAX_PEG_VOICES = 24;
  var SOFT_VOICE_LIMIT = 90;  // skip purely cosmetic sounds above this

  var api = {};

  function report(e) {
    api._lastError = e;
    if (warnCount < 5) {
      warnCount++;
      try { if (root.console && root.console.warn) root.console.warn('[LanternAudio]', e); } catch (_) {}
    }
  }

  // Wrap an SFX: no-op before unlock or while paused; never throws.
  function sfx(fn) {
    return function () {
      if (!ctx || paused) return;
      try { fn.apply(null, arguments); } catch (e) { report(e); }
    };
  }
  // Wrap a control method: no-op before unlock; never throws.
  function ctl(fn) {
    return function () {
      try { return fn.apply(null, arguments); } catch (e) { report(e); }
    };
  }

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function clamp01(v) { v = +v; if (!(v >= 0)) return 0; return v > 1 ? 1 : v; }
  function now() { return Math.max(0, ctx.currentTime) + 0.006; }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function mkRng(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      return (s % 100000) / 100000;
    };
  }
  function hashStr(str) {
    str = String(str == null ? '' : str);
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul ? Math.imul(h, 16777619) : (h * 16777619) | 0; }
    return h >>> 0;
  }

  function gainN(v) { var g = ctx.createGain(); g.gain.value = v; return g; }
  function oscN(type, f, t) {
    var o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(Math.min(f, 18000), t);
    return o;
  }
  function filt(type, f, q) {
    var b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f;
    if (q != null) b.Q.value = q;
    return b;
  }
  function panN(p) {
    if (!ctx.createStereoPanner) return null;
    var s = ctx.createStereoPanner(); s.pan.value = Math.max(-1, Math.min(1, p)); return s;
  }
  function noiseSrc() {
    var s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true; return s;
  }
  // Freeze a param's current automation at time t so a new ramp starts cleanly.
  function hold(param, t) {
    if (param.cancelAndHoldAtTime) { param.cancelAndHoldAtTime(t); }
    else { var v = param.value; param.cancelScheduledValues(t); param.setValueAtTime(v, t); }
  }
  function smooth(param, v, tc) {
    if (!ctx) return;
    var t = ctx.currentTime;
    hold(param, t);
    param.setTargetAtTime(v, t, tc || 0.06);
  }
  // Percussive envelope: fast linear attack, exponential-ish decay, clean tail to 0.
  function envPerc(param, t, peak, att, tau, end) {
    param.setValueAtTime(0, t);
    param.linearRampToValueAtTime(peak, t + att);
    param.setTargetAtTime(0, t + att, tau);
    if (end != null) param.setTargetAtTime(0, Math.max(t + att, end - 0.06), 0.012);
  }
  function chain() {
    var prev = null;
    for (var i = 0; i < arguments.length; i++) {
      var n = arguments[i];
      if (!n) continue;
      if (prev) prev.connect(n);
      prev = n;
    }
    return prev;
  }

  // A Voice groups nodes of one sound so they are all disconnected when it ends.
  function Voice() { this.nodes = []; this.srcs = []; this.last = null; this.end = 0; this.out = null; this.freed = false; }
  Voice.prototype.n = function (x) { if (x) this.nodes.push(x); return x; };
  Voice.prototype.s = function (x, t0, t1, off) {
    this.nodes.push(x); this.srcs.push(x);
    if (off != null) x.start(t0, off); else x.start(t0);
    x.stop(t1);
    if (t1 >= this.end) { this.end = t1; this.last = x; }
    return x;
  };
  Voice.prototype.done = function () {
    var self = this;
    activeVoices++;
    if (this.last) this.last.onended = function () { self.free(); };
    return this;
  };
  Voice.prototype.free = function () {
    if (this.freed) return;
    this.freed = true; activeVoices--;
    for (var i = 0; i < this.nodes.length; i++) { try { this.nodes[i].disconnect(); } catch (e) {} }
    this.nodes.length = 0; this.srcs.length = 0; this.last = null;
  };
  // Quick fade + early stop (voice stealing / cancel).
  Voice.prototype.kill = function (t) {
    if (this.freed) return;
    try { if (this.out) { hold(this.out.gain, t); this.out.gain.setTargetAtTime(0, t, 0.006); } } catch (e) {}
    var st = t + 0.05;
    for (var i = 0; i < this.srcs.length; i++) { try { this.srcs[i].stop(st); } catch (e) {} }
    if (st < this.end) this.end = st;
  };
  // Create the voice's output gain -> (pan) -> dest, optional reverb send.
  Voice.prototype.output = function (dest, pan, wet) {
    var o = this.n(gainN(0));
    this.out = o;
    var p = (pan != null && pan !== 0) ? this.n(panN(pan)) : null;
    chain(o, p, dest);
    if (wet && G.sfxWet && dest === G.sfxBus) (p || o).connect(G.sfxWet);
    return o;
  };

  // ---------------------------------------------------------------------------
  // Audio graph
  // ---------------------------------------------------------------------------
  function makeImpulse(seconds, tau) {
    var sr = ctx.sampleRate, len = Math.floor(sr * seconds);
    var buf = ctx.createBuffer(2, len, sr);
    var pre = Math.floor(sr * 0.012);
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch), y = 0, energy = 0, i;
      for (i = 0; i < len; i++) {
        if (i < pre) { d[i] = 0; continue; }
        var tt = (i - pre) / sr;
        var x = (Math.random() * 2 - 1) * Math.exp(-tt / tau);
        var a = 0.65 - 0.5 * Math.min(1, tt / seconds);    // darkens over time
        y += a * (x - y);
        var fadeIn = Math.min(1, (i - pre) / (sr * 0.02));
        d[i] = y * fadeIn;
      }
      for (i = 0; i < len; i++) energy += d[i] * d[i];
      var k = energy > 0 ? 1 / Math.sqrt(energy) : 0;
      for (i = 0; i < len; i++) d[i] *= k;
    }
    return buf;
  }

  function softClipCurve() {
    var n = 2048, c = new Float32Array(n), th = 0.7, rng = 0.28;
    for (var i = 0; i < n; i++) {
      var x = i * 2 / (n - 1) - 1, ax = Math.abs(x);
      var y = ax < th ? ax : th + rng * Math.tanh((ax - th) / rng);
      c[i] = x < 0 ? -y : y;
    }
    return c;
  }

  function buildGraph() {
    var t = ctx.currentTime;
    // noise (2 s mono white)
    var nlen = Math.floor(ctx.sampleRate * 2);
    noiseBuf = ctx.createBuffer(1, nlen, ctx.sampleRate);
    var nd = noiseBuf.getChannelData(0);
    for (var i = 0; i < nlen; i++) nd[i] = Math.random() * 2 - 1;

    G.mix = gainN(1);
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.setValueAtTime(-16, t); comp.knee.setValueAtTime(12, t);
    comp.ratio.setValueAtTime(3.5, t); comp.attack.setValueAtTime(0.004, t); comp.release.setValueAtTime(0.2, t);
    var lim = ctx.createDynamicsCompressor();
    lim.threshold.setValueAtTime(-4, t); lim.knee.setValueAtTime(0, t);
    lim.ratio.setValueAtTime(20, t); lim.attack.setValueAtTime(0.001, t); lim.release.setValueAtTime(0.08, t);
    var clip = ctx.createWaveShaper(); clip.curve = softClipCurve(); clip.oversample = 'none';
    // Overall output level, kept well below full scale so the game sits at a comfortable listening level.
    G.master = gainN(0.55);
    chain(G.mix, comp, lim, clip, G.master, ctx.destination);
    G.comp = comp; G.lim = lim; G.clip = clip;

    // shared reverb
    G.revIn = gainN(1);
    var conv = ctx.createConvolver();
    conv.normalize = false;
    conv.buffer = makeImpulse(2.0, 0.42);
    G.revOut = gainN(0.55);
    chain(G.revIn, conv, G.revOut, G.mix);
    G.conv = conv;

    // sfx bus
    G.sfxBus = gainN(curve(sfxVol));
    G.sfxBus.connect(G.mix);
    G.sfxWet = gainN(curve(sfxVol) * 0.32);
    G.sfxWet.connect(G.revIn);

    // music: tracks -> musicIn -> duck -> musicVol -> mix (+ reverb send)
    G.musicIn = gainN(1);
    G.duck = gainN(1);
    G.musicVol = gainN(curve(musicVol));
    chain(G.musicIn, G.duck, G.musicVol, G.mix);
    G.musicWet = gainN(0.4);
    chain(G.musicVol, G.musicWet, G.revIn);
  }

  function applyDuck() {
    if (!ctx) return;
    smooth(G.duck.gain, (userDuck || feverActive) ? 0.2 : 1, 0.25);
  }

  // ---------------------------------------------------------------------------
  // Shared instruments
  // ---------------------------------------------------------------------------
  // Glassy FM bell used by pegs, jingles, fever.
  function fmBell(t, f, o, dest) {
    o = o || {};
    var v = new Voice();
    var tau = o.tau || 0.28, len = o.len || tau * 5.5;
    var end = t + len;
    var out = v.output(dest || G.sfxBus, o.pan || 0, o.wet !== false);
    var ratio = o.ratio || 3.0, index = o.index || 1.2;
    if (f > 1200) index *= 1200 / f;               // tame aliasing up high
    var car = v.s(oscN('sine', f, t), t, end);
    var mod = v.s(oscN('sine', f * ratio, t), t, end);
    var mg = v.n(gainN(0));
    mg.gain.setValueAtTime(f * index, t);
    mg.gain.setTargetAtTime(f * index * 0.05, t, o.modTau || 0.05);
    chain(mod, mg); mg.connect(car.frequency);
    car.connect(out);
    var extras = o.extras || [];
    for (var i = 0; i < extras.length; i++) {
      var e = extras[i];
      var eo = v.s(oscN(e.type || 'sine', f * e.r, t), t, end);
      var eg = v.n(gainN(0));
      envPerc(eg.gain, t, e.g, 0.004, e.tau || tau * 0.6);
      chain(eo, eg, out);
    }
    envPerc(out.gain, t, o.peak || 0.2, o.att || 0.003, tau, end);
    v.done();
    return v;
  }

  // Soft pluck with optional overtone (kalimba-ish).
  function kalimba(t, m, dur, vel, dest, len) {
    var f = mtof(m), v = new Voice(), end = t + (len || 1.9);
    var out = v.output(dest, 0, false);
    var o1 = v.s(oscN('sine', f, t), t, end);
    var o2 = v.s(oscN('sine', f * 5.42, t), t, end);
    var g2 = v.n(gainN(0));
    envPerc(g2.gain, t, 0.22, 0.002, 0.035);
    o1.connect(out); chain(o2, g2, out);
    envPerc(out.gain, t, vel, 0.003, 0.42, end);
    return v.done();
  }

  // Koto-ish pluck: saw through an enveloped lowpass with a little bend-in.
  function koto(t, m, dur, vel, dest) {
    var f = mtof(m), v = new Voice(), end = t + 1.7;
    var out = v.output(dest, 0, false);
    var o = v.s(oscN('sawtooth', f, t), t, end);
    o.detune.setValueAtTime(-38, t);
    o.detune.linearRampToValueAtTime(0, t + 0.07);
    var lp = v.n(filt('lowpass', Math.min(9000, f * 6), 2.2));
    lp.frequency.setValueAtTime(Math.min(9000, f * 6), t);
    lp.frequency.setTargetAtTime(f * 1.4, t + 0.005, 0.12);
    chain(o, lp, out);
    envPerc(out.gain, t, vel * 0.55, 0.003, 0.36, end);
    return v.done();
  }

  // Music-box / celesta (soft FM).
  function musicBox(t, m, dur, vel, dest) {
    return fmBell(t, mtof(m), { ratio: 4.0, index: 0.7, modTau: 0.08, tau: 0.5, len: 2.2, peak: vel * 0.8, wet: false }, dest);
  }

  function pad(t, mids, dur, vel, dest) {
    var v = new Voice(), end = t + dur + 0.9;
    var out = v.output(dest, 0, false);
    var lp = v.n(filt('lowpass', 950, 0.4));
    lp.connect(out);
    for (var i = 0; i < mids.length; i++) {
      var f = mtof(mids[i]);
      var a = v.s(oscN('triangle', f, t), t, end);
      var b = v.s(oscN('sawtooth', f, t), t, end);
      b.detune.setValueAtTime(i % 2 ? 7 : -7, t);
      var bg = v.n(gainN(0.35));
      a.connect(lp); chain(b, bg, lp);
    }
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(vel, t + 0.55);
    out.gain.setValueAtTime(vel, t + dur);
    out.gain.linearRampToValueAtTime(0, t + dur + 0.85);
    return v.done();
  }

  function bass(t, m, dur, vel, dest) {
    var f = mtof(m), v = new Voice(), end = t + dur + 0.35;
    var out = v.output(dest, 0, false);
    var a = v.s(oscN('sine', f, t), t, end);
    var b = v.s(oscN('triangle', f * 2, t), t, end);
    var bg = v.n(gainN(0.12));
    a.connect(out); chain(b, bg, out);
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(vel, t + 0.015);
    out.gain.setTargetAtTime(vel * 0.45, t + 0.015, 0.25);
    out.gain.setTargetAtTime(0, t + dur, 0.07);
    return v.done();
  }

  function shaker(t, vel, dest) {
    var v = new Voice(), end = t + 0.12;
    var out = v.output(dest, 0, false);
    var n = v.s(noiseSrc(), t, end, Math.random() * 1.8);
    var hp = v.n(filt('highpass', 6500, 0.7));
    chain(n, hp, out);
    envPerc(out.gain, t, vel, 0.008, 0.022, end);
    return v.done();
  }

  function woodblock(t, vel, f, dest) {
    var v = new Voice(), end = t + 0.16;
    var out = v.output(dest, 0, false);
    var o = v.s(oscN('triangle', f, t), t, end);
    o.frequency.setTargetAtTime(f * 0.86, t, 0.02);
    o.connect(out);
    envPerc(out.gain, t, vel, 0.001, 0.028, end);
    return v.done();
  }

  function softKick(t, vel, dest) {
    var v = new Voice(), end = t + 0.45;
    var out = v.output(dest, 0, false);
    var o = v.s(oscN('sine', 115, t), t, end);
    o.frequency.setTargetAtTime(46, t, 0.035);
    o.connect(out);
    envPerc(out.gain, t, vel, 0.003, 0.11, end);
    return v.done();
  }

  // Brass-ish voice for the fever fanfare.
  function brass(t, m, dur, vel, dest) {
    var f = mtof(m), v = new Voice(), end = t + dur + 0.25;
    var out = v.output(dest, 0, false);
    var lp = v.n(filt('lowpass', 500, 1.2));
    lp.frequency.setValueAtTime(500, t);
    lp.frequency.linearRampToValueAtTime(Math.min(8000, f * 5), t + 0.05);
    lp.frequency.setTargetAtTime(Math.min(6000, f * 2.6), t + 0.05, 0.15);
    for (var i = 0; i < 2; i++) {
      var o = v.s(oscN('sawtooth', f, t), t, end);
      o.detune.setValueAtTime(i ? 8 : -8, t);
      o.connect(lp);
    }
    lp.connect(out);
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(vel, t + 0.035);
    out.gain.setTargetAtTime(vel * 0.75, t + 0.035, 0.12);
    out.gain.setTargetAtTime(0, t + dur, 0.06);
    return v.done();
  }

  function noiseHit(t, o, dest) {
    var v = new Voice(), end = t + (o.len || 0.3);
    var out = v.output(dest || G.sfxBus, o.pan || 0, !!o.wet);
    var n = v.s(noiseSrc(), t, end, Math.random() * 1.8);
    var f = v.n(filt(o.type || 'bandpass', o.f || 1800, o.q == null ? 1 : o.q));
    if (o.f2) f.frequency.setTargetAtTime(o.f2, t, o.ftau || 0.1);
    chain(n, f, out);
    envPerc(out.gain, t, o.peak || 0.2, o.att || 0.002, o.tau || 0.05, end);
    return v.done();
  }

  // ---------------------------------------------------------------------------
  // Peg / brick chains
  // ---------------------------------------------------------------------------
  var PENTA = [0, 2, 4, 7, 9];
  var CHAIN_STEPS = 16; // 3 octaves + 1 of major pentatonic
  function chainMidi(n, base) {
    var idx = Math.max(0, Math.min(CHAIN_STEPS - 1, (n | 0) - 1));
    return base + 12 * Math.floor(idx / 5) + PENTA[idx % 5];
  }

  function stealPegVoices(t) {
    for (var i = pegPool.length - 1; i >= 0; i--) {
      if (pegPool[i].freed || pegPool[i].end < t) pegPool.splice(i, 1);
    }
    while (pegPool.length >= MAX_PEG_VOICES) {
      var old = pegPool.shift();
      old.kill(t);
    }
  }

  function sparkle(t, count, baseF) {
    for (var i = 0; i < count; i++) {
      var tt = t + 0.03 + i * rand(0.035, 0.06);
      fmBell(tt, baseF * Math.pow(2, rand(0.6, 1.4)), { ratio: 2.0, index: 0.3, tau: 0.09, peak: 0.05, pan: rand(-0.7, 0.7) });
    }
  }

  function pegHitImpl(n, kind) {
    n = Math.max(1, +n || 1);
    var t = now();
    stealPegVoices(t);
    var m = chainMidi(n, pegRoot), f = mtof(m);
    var o = { ratio: 3.0, index: 1.3, modTau: 0.045, tau: 0.26, peak: 0.19, pan: rand(-0.25, 0.25) };
    if (kind === 'orange') { o.index = 2.0; o.peak = 0.21; o.extras = [{ type: 'triangle', r: 2, g: 0.06, tau: 0.12 }]; }
    else if (kind === 'green') { o.extras = [{ r: 2.008, g: 0.06, tau: 0.35 }, { r: 1.992, g: 0.06, tau: 0.35 }, { r: 4.01, g: 0.025, tau: 0.2 }]; }
    else if (kind === 'purple') { o.index = 1.0; o.extras = [{ r: 3.0, g: 0.08, tau: 0.42 }]; }
    pegPool.push(fmBell(t, f, o));
    if (n > CHAIN_STEPS) {
      sparkle(t, Math.min(4, 1 + Math.floor((n - CHAIN_STEPS) / 3)), f);
    }
  }

  function brickHitImpl(n, kind) {
    n = Math.max(1, +n || 1);
    var t = now();
    stealPegVoices(t);
    var m = chainMidi(n, pegRoot - 12), f = mtof(m);
    var v = new Voice(), end = t + 0.9;
    var out = v.output(G.sfxBus, rand(-0.25, 0.25), true);
    var a = v.s(oscN('sine', f, t), t, end);
    var b = v.s(oscN('sine', f * 3.93, t), t, end);
    var bg = v.n(gainN(0));
    envPerc(bg.gain, t, kind === 'orange' ? 0.35 : 0.22, 0.001, 0.025);
    a.connect(out); chain(b, bg, out);
    if (kind === 'green' || kind === 'purple') {
      var c = v.s(oscN('sine', f * (kind === 'purple' ? 3 : 2.01), t), t, end);
      var cg = v.n(gainN(0));
      envPerc(cg.gain, t, 0.1, 0.002, 0.15);
      chain(c, cg, out);
    }
    var nz = v.s(noiseSrc(), t, t + 0.05, Math.random() * 1.8);
    var bp = v.n(filt('bandpass', Math.min(6000, f * 2.5), 3));
    var ng = v.n(gainN(0));
    envPerc(ng.gain, t, 0.5, 0.001, 0.008);
    chain(nz, bp, ng, out);
    envPerc(out.gain, t, 0.26, 0.002, 0.13, end);
    v.done();
    pegPool.push(v);
    if (n > CHAIN_STEPS) sparkle(t, 1, f * 2);
  }

  // ---------------------------------------------------------------------------
  // One-shot SFX
  // ---------------------------------------------------------------------------
  function launchImpl() {
    var t = now(), v = new Voice(), end = t + 0.4;
    var out = v.output(G.sfxBus, 0, false);
    var o = v.s(oscN('sine', 190, t), t, end);
    o.frequency.setTargetAtTime(52, t, 0.03);
    o.connect(out);
    envPerc(out.gain, t, 0.42, 0.003, 0.06, end);
    v.done();
    noiseHit(t, { type: 'lowpass', f: 1400, f2: 300, ftau: 0.03, q: 0.5, peak: 0.12, tau: 0.035, len: 0.2 });
    var p = new Voice(), pe = t + 0.08;
    var po = p.output(G.sfxBus, 0, false);
    var pp = p.s(oscN('triangle', 1100, t), t, pe);
    pp.frequency.setTargetAtTime(420, t, 0.012);
    pp.connect(po);
    envPerc(po.gain, t, 0.08, 0.001, 0.012, pe);
    p.done();
  }

  function bounceWallImpl() {
    var t = now();
    if (t - lastBounce < 0.045 || activeVoices > SOFT_VOICE_LIMIT) return;
    lastBounce = t;
    var v = new Voice(), end = t + 0.08;
    var out = v.output(G.sfxBus, 0, false);
    var o = v.s(oscN('triangle', rand(2000, 2300), t), t, end);
    o.connect(out);
    envPerc(out.gain, t, 0.045, 0.001, 0.01, end);
    v.done();
  }

  function bucketImpl() {
    var t = now();
    noiseHit(t, { type: 'bandpass', f: 500, f2: 3500, ftau: 0.1, q: 1.2, peak: 0.12, att: 0.08, tau: 0.08, len: 0.45, wet: true });
    var steps = [12, 16, 19, 24, 28];
    for (var i = 0; i < steps.length; i++) {
      fmBell(t + 0.05 + i * 0.055, mtof(pegRoot + steps[i]), { ratio: 2.0, index: 0.9, tau: i === steps.length - 1 ? 0.45 : 0.18, peak: 0.13, pan: -0.4 + i * 0.2 });
    }
    sparkle(t + 0.3, 4, mtof(pegRoot + 31));
  }

  function extraBallImpl() {
    var t = now(), seq = [0, 7, 12, 16, 14, 19, 24];
    var base = pegRoot + 12;
    for (var i = 0; i < seq.length; i++) {
      var tt = t + i * 0.065, last = i === seq.length - 1;
      var v = new Voice(), end = tt + (last ? 0.7 : 0.16);
      var out = v.output(G.sfxBus, 0, true);
      var o = v.s(oscN('square', mtof(base + seq[i]), tt), tt, end);
      var lp = v.n(filt('lowpass', 2600, 0.5));
      if (last) {
        var lfo = v.s(oscN('sine', 7, tt), tt, end), lg = v.n(gainN(12));
        chain(lfo, lg); lg.connect(o.detune);
      }
      chain(o, lp, out);
      envPerc(out.gain, tt, 0.07, 0.003, last ? 0.2 : 0.05, end);
      v.done();
    }
    fmBell(t + 6 * 0.065, mtof(base + 24), { ratio: 2, index: 0.6, tau: 0.35, peak: 0.1 });
  }

  var POWER_CHORDS = [[0, 4, 7, 11, 14], [0, 4, 7, 9, 16], [0, 5, 7, 12, 14], [0, 2, 7, 11, 16]];
  function powerReadyImpl(name) {
    var t = now(), h = hashStr(name);
    var chord = POWER_CHORDS[h % POWER_CHORDS.length];
    var root = pegRoot + 12 + PENTA[(h >>> 3) % 5];
    var len = 1.1;
    // riser
    noiseHit(t, { type: 'bandpass', f: 300, f2: 5000, ftau: 0.22, q: 2.5, peak: 0.1, att: 0.45, tau: 0.08, len: 0.8, wet: true });
    // shimmering arpeggio with shared tremolo
    var v = new Voice(), end = t + len + 0.6;
    var out = v.output(G.sfxBus, 0, true);
    var trem = v.n(gainN(0.75));
    var lfo = v.s(oscN('sine', 6 + (h % 5), t), t, end), lfg = v.n(gainN(0.25));
    chain(lfo, lfg); lfg.connect(trem.gain);
    trem.connect(out);
    for (var i = 0; i < chord.length; i++) {
      var tt = t + i * 0.09;
      var o = v.s(oscN(i % 2 ? 'triangle' : 'sine', mtof(root + chord[i]), tt), tt, end);
      var g = v.n(gainN(0));
      g.gain.setValueAtTime(0, tt);
      g.gain.linearRampToValueAtTime(0.09, tt + 0.12);
      g.gain.setValueAtTime(0.09, t + len - 0.2);
      g.gain.setTargetAtTime(0, t + len - 0.2, 0.15);
      chain(o, g, trem);
    }
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(1, t + 0.3);
    out.gain.setValueAtTime(1, end - 0.25);
    out.gain.setTargetAtTime(0, end - 0.25, 0.06);
    v.done();
    fmBell(t + 0.5, mtof(root + 24), { ratio: 3.5, index: 0.8, tau: 0.4, peak: 0.12 });
    sparkle(t + 0.55, 3, mtof(root + 24));
  }

  function explosionImpl() {
    var t = now();
    // low thump
    var v = new Voice(), end = t + 0.9;
    var out = v.output(G.sfxBus, 0, true);
    var o = v.s(oscN('sine', 130, t), t, end);
    o.frequency.setTargetAtTime(38, t, 0.06);
    o.connect(out);
    envPerc(out.gain, t, 0.45, 0.004, 0.18, end);
    v.done();
    // burst
    noiseHit(t, { type: 'lowpass', f: 5000, f2: 260, ftau: 0.18, q: 0.6, peak: 0.32, att: 0.004, tau: 0.22, len: 1.2, wet: true });
    // crackle tail (shared filter)
    var c = new Voice(), cend = t + 1.6;
    var cout = c.output(G.sfxBus, 0, true);
    var hp = c.n(filt('highpass', 2800, 0.7));
    hp.connect(cout);
    cout.gain.setValueAtTime(1, t);
    for (var i = 0; i < 14; i++) {
      var tt = t + rand(0.12, 1.35);
      var n = c.s(noiseSrc(), tt, tt + 0.03, Math.random() * 1.8);
      var g = c.n(gainN(0));
      var p = c.n(panN(rand(-0.8, 0.8)));
      envPerc(g.gain, tt, rand(0.08, 0.22) * (1 - (tt - t) / 1.6), 0.001, 0.006);
      chain(n, g, p, hp);
    }
    // keep the group alive until the last crackle
    c.s(oscN('sine', 1, t), t, cend).connect(c.n(gainN(0)));
    c.done();
  }

  function fireImpl() {
    var t = now(), end = t + 0.8;
    var v = new Voice();
    var out = v.output(G.sfxBus, 0, true);
    var n = v.s(noiseSrc(), t, end, Math.random() * 1.8);
    var bp = v.n(filt('bandpass', 400, 1.4));
    bp.frequency.setValueAtTime(400, t);
    bp.frequency.exponentialRampToValueAtTime(2200, t + 0.25);
    bp.frequency.exponentialRampToValueAtTime(600, t + 0.7);
    chain(n, bp, out);
    var n2 = v.s(noiseSrc(), t, end, Math.random() * 1.8);
    var lp = v.n(filt('lowpass', 220, 0.7)), g2 = v.n(gainN(1.6));
    chain(n2, lp, g2, out);
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(0.32, t + 0.12);
    out.gain.setValueAtTime(0.32, t + 0.3);
    out.gain.setTargetAtTime(0, t + 0.3, 0.12);
    v.done();
  }

  function zapImpl() {
    var t = now(), end = t + 0.22;
    var v = new Voice();
    var out = v.output(G.sfxBus, rand(-0.2, 0.2), true);
    var o = v.s(oscN('sawtooth', 1700, t), t, end);
    o.frequency.exponentialRampToValueAtTime(240, t + 0.16);
    var lfo = v.s(oscN('square', 72, t), t, end), lg = v.n(gainN(260));
    chain(lfo, lg); lg.connect(o.frequency);
    var hp = v.n(filt('highpass', 450, 0.7));
    chain(o, hp, out);
    envPerc(out.gain, t, 0.12, 0.002, 0.05, end);
    v.done();
    noiseHit(t, { type: 'highpass', f: 4000, peak: 0.08, tau: 0.012, len: 0.06 });
  }

  function magnetImpl() {
    var t = now(), end = t + 0.85;
    var v = new Voice();
    var out = v.output(G.sfxBus, 0, true);
    var o = v.s(oscN('triangle', 180, t), t, end);
    o.frequency.exponentialRampToValueAtTime(540, t + 0.65);
    var o2 = v.s(oscN('sine', 270, t), t, end);
    o2.frequency.exponentialRampToValueAtTime(810, t + 0.65);
    var lfo = v.s(oscN('sine', 7, t), t, end);
    lfo.frequency.linearRampToValueAtTime(13, t + 0.65);
    var depth = v.n(gainN(0));
    depth.gain.setValueAtTime(0, t);
    depth.gain.linearRampToValueAtTime(40, t + 0.6);
    chain(lfo, depth); depth.connect(o.detune); depth.connect(o2.detune);
    var g2 = v.n(gainN(0.35));
    var lp = v.n(filt('lowpass', 2400, 0.6));
    o.connect(lp); chain(o2, g2, lp); lp.connect(out);
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(0.16, t + 0.25);
    out.gain.setValueAtTime(0.16, t + 0.62);
    out.gain.setTargetAtTime(0, t + 0.62, 0.05);
    v.done();
  }

  // Tension drumroll
  var ten = { v: null, end: 0, timer: null };
  function tensionImpl() {
    var t = now();
    if (ten.v && !ten.v.freed && t < ten.end) return;  // already rolling
    var len = 2.5, end = t + len + 0.1;
    var v = new Voice();
    var out = v.output(G.sfxBus, 0, true);
    // noise roll: noise amplitude-modulated by an accelerating LFO
    var n = v.s(noiseSrc(), t, end, Math.random() * 1.8);
    var bp = v.n(filt('bandpass', 2300, 0.8));
    var am = v.n(gainN(0.5));
    var lfo = v.s(oscN('triangle', 11, t), t, end);
    lfo.frequency.exponentialRampToValueAtTime(26, t + len - 0.1);
    var lg = v.n(gainN(0.5));
    chain(lfo, lg); lg.connect(am.gain);
    chain(n, bp, am, out);
    // rising tones (root + major third), climbing a fifth
    var r = mtof(pegRoot);
    var tones = [1, 1.26];
    for (var i = 0; i < tones.length; i++) {
      var o = v.s(oscN('sine', r * tones[i], t), t, end);
      o.frequency.exponentialRampToValueAtTime(r * tones[i] * 1.5, t + len);
      var tg = v.n(gainN(0.22));
      chain(o, tg, out);
    }
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(0.06, t + 0.2);
    out.gain.linearRampToValueAtTime(0.22, t + len - 0.1);
    out.gain.setTargetAtTime(0, t + len - 0.1, 0.03);
    v.done();
    ten.v = v; ten.end = end;
  }
  function stopTensionImpl() {
    if (!ctx || !ten.v) return;
    var t = ctx.currentTime;
    if (!ten.v.freed && t < ten.end) {
      ten.v.kill(t);
      ten.end = t + 0.05;
    }
    ten.v = null;
  }

  function feverStartImpl() {
    var t = now();
    stopTensionImpl();
    // crash
    noiseHit(t, { type: 'highpass', f: 3200, q: 0.5, peak: 0.26, att: 0.003, tau: 0.7, len: 3.2, wet: true });
    noiseHit(t, { type: 'lowpass', f: 900, f2: 150, ftau: 0.2, q: 0.6, peak: 0.3, tau: 0.25, len: 1.3, wet: true });
    // boom
    var b = new Voice(), be = t + 1.4;
    var bo = b.output(G.sfxBus, 0, true);
    var o = b.s(oscN('sine', 100, t), t, be);
    o.frequency.setTargetAtTime(36, t, 0.12);
    o.connect(bo);
    envPerc(bo.gain, t, 0.6, 0.004, 0.35, be);
    b.done();
    // "choir" pad: detuned saws through two vowel formants, swelling in
    var mids = [pegRoot - 12, pegRoot - 5, pegRoot, pegRoot + 4, pegRoot + 7, pegRoot + 12];
    var v = new Voice(), end = t + 3.6;
    var out = v.output(G.sfxBus, 0, true);
    var sum = v.n(gainN(1 / mids.length));
    var f1 = v.n(filt('bandpass', 720, 5)), f2 = v.n(filt('bandpass', 1150, 7)), f3 = v.n(filt('lowpass', 500, 0.5));
    var g1 = v.n(gainN(1.6)), g2 = v.n(gainN(1.0)), g3 = v.n(gainN(0.35));
    chain(sum, f1, g1, out); chain(sum, f2, g2, out); chain(sum, f3, g3, out);
    var vib = v.s(oscN('sine', 5.2, t), t, end), vg = v.n(gainN(9));
    chain(vib, vg);
    for (var i = 0; i < mids.length; i++) {
      for (var k = 0; k < 2; k++) {
        var s = v.s(oscN('sawtooth', mtof(mids[i]), t), t, end);
        s.detune.setValueAtTime(k ? 9 : -9, t);
        vg.connect(s.detune);
        s.connect(sum);
      }
    }
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(0.5, t + 1.3);
    out.gain.setValueAtTime(0.5, t + 2.4);
    out.gain.setTargetAtTime(0, t + 2.4, 0.3);
    v.done();
    sparkle(t + 0.2, 4, mtof(pegRoot + 36));
  }

  // ---------------------------------------------------------------------------
  // Fever fanfare (original), ~11 s, D-major-ish relative to root 62
  // ---------------------------------------------------------------------------
  var fever = { out: null, voices: [] };
  // [beat, beats, semitone above melody root]
  var FEVER_MEL = [
    [0, 0.33, 0], [0.33, 0.33, 4], [0.67, 0.33, 7], [1, 1.5, 12], [2.5, 0.5, 11], [3, 1, 9],
    [4, 0.5, 7], [4.5, 0.5, 9], [5, 1, 12], [6, 0.5, 14], [6.5, 0.5, 12], [7, 1, 9],
    [8, 0.33, 7], [8.33, 0.33, 9], [8.67, 0.33, 11], [9, 1.5, 16], [10.5, 0.5, 14], [11, 1, 12],
    [12, 0.5, 7], [12.5, 0.5, 9], [13, 0.5, 11], [13.5, 0.5, 12], [14, 2, 14],
    [16, 1, 17], [17, 0.5, 16], [17.5, 0.5, 14], [18, 1, 12], [19, 0.33, 14], [19.33, 0.33, 16], [19.67, 0.33, 17],
    [20, 3.5, 19]
  ];
  // [beat, root semis, minor?]
  var FEVER_CHORDS = [[0, 0, 0], [4, 5, 0], [8, 9, 1], [10, 5, 0], [12, 7, 0], [16, 5, 0], [18, 7, 0], [20, 0, 0]];

  function feverMusicImpl() {
    stopFeverImpl(true);
    var t0 = now() + 0.05;
    var bpm = 132, B = 60 / bpm;
    var out = gainN(0.8);
    out.connect(G.musicVol);       // post-duck, so the fanfare stays loud
    fever.out = out;
    var root = 62;                  // fanfare always in D for brightness
    var mel = root + 12;
    var i, k, t;
    for (i = 0; i < FEVER_MEL.length; i++) {
      var e = FEVER_MEL[i];
      t = t0 + e[0] * B;
      brass(t, mel + e[2], e[1] * B * 0.92, 0.16, out);
      if (e[0] >= 16) musicBox(t, mel + 12 + e[2], 0, 0.16, out);
    }
    // chords: stabs on every beat, held at the end
    for (k = 0; k < FEVER_CHORDS.length; k++) {
      var c = FEVER_CHORDS[k], nextBeat = k + 1 < FEVER_CHORDS.length ? FEVER_CHORDS[k + 1][0] : 24;
      var r = root + c[1];
      var tri = [r, r + (c[2] ? 3 : 4), r + 7];
      for (var j = 0; j < tri.length; j++) { while (tri[j] > 69) tri[j] -= 12; while (tri[j] < 55) tri[j] += 12; }
      if (c[0] >= 20) {
        t = t0 + c[0] * B;
        for (j = 0; j < 3; j++) brass(t, tri[j], 3.2 * B, 0.08, out);
        pad(t, [tri[0] - 12, tri[0], tri[1], tri[2]], 3 * B, 0.07, out);
        bass(t, r - 24, 3 * B, 0.4, out);
        continue;
      }
      for (var bt = c[0]; bt < nextBeat; bt++) {
        t = t0 + bt * B;
        for (j = 0; j < 3; j++) brass(t, tri[j], 0.3 * B, bt === c[0] ? 0.07 : 0.045, out);
        bass(t, r - 24 + (bt % 2 ? 7 : 0), 0.8 * B, 0.36, out);
      }
    }
    // percussion
    for (var beat = 0; beat < 20; beat++) {
      t = t0 + beat * B;
      if (beat % 2 === 0) softKick(t, 0.5, out);
      if (beat % 2 === 1) noiseHit(t, { f: 1900, q: 0.9, peak: 0.16, tau: 0.06, len: 0.25 }, out);
      shaker(t + B * 0.5, 0.08, out);
      if (beat % 4 === 3) {
        noiseHit(t + B * 0.5, { f: 2000, q: 0.9, peak: 0.08, tau: 0.04, len: 0.15 }, out);
        noiseHit(t + B * 0.75, { f: 2100, q: 0.9, peak: 0.11, tau: 0.04, len: 0.15 }, out);
      }
    }
    // snare roll into the final chord
    for (k = 0; k < 8; k++) noiseHit(t0 + (19 + k / 8) * B, { f: 2000, q: 0.9, peak: 0.05 + k * 0.012, tau: 0.03, len: 0.1 }, out);
    // crashes
    noiseHit(t0, { type: 'highpass', f: 3500, q: 0.5, peak: 0.16, tau: 0.6, len: 2.5 }, out);
    noiseHit(t0 + 20 * B, { type: 'highpass', f: 3200, q: 0.5, peak: 0.22, tau: 0.9, len: 3.2 }, out);
    // firework whistles and pops
    var pops = [6, 11, 15, 21.5];
    for (k = 0; k < pops.length; k++) {
      var pt = t0 + pops[k] * B;
      var wv = new Voice(), we = pt + 0.7;
      var wo = wv.output(out, rand(-0.6, 0.6), false);
      var wsc = wv.s(oscN('sine', 900, pt), pt, we);
      wsc.frequency.exponentialRampToValueAtTime(2600, pt + 0.6);
      wsc.connect(wo);
      wo.gain.setValueAtTime(0, pt);
      wo.gain.linearRampToValueAtTime(0.025, pt + 0.3);
      wo.gain.setValueAtTime(0.025, pt + 0.55);
      wo.gain.setTargetAtTime(0, pt + 0.55, 0.03);
      wv.done();
      noiseHit(pt + 0.68, { type: 'lowpass', f: 3000, f2: 400, ftau: 0.12, q: 0.6, peak: 0.12, tau: 0.15, len: 0.8, pan: rand(-0.6, 0.6) }, out);
      for (var cr = 0; cr < 5; cr++) {
        noiseHit(pt + 0.75 + rand(0.05, 0.6), { type: 'highpass', f: 3500, peak: 0.05, tau: 0.006, len: 0.04, pan: rand(-0.8, 0.8) }, out);
      }
    }
    // final rising bell flourish
    var fl = [0, 4, 7, 12, 16, 19, 24];
    for (k = 0; k < fl.length; k++) fmBell(t0 + 20 * B + 0.1 + k * 0.07, mtof(mel + 12 + fl[k]), { ratio: 2, index: 0.6, tau: 0.4, peak: 0.07, pan: -0.5 + k * 0.16 }, out);

    feverActive = true;
    applyDuck();
    var total = (24 * B + 2) * 1000;
    if (feverTimer) clearTimeout(feverTimer);
    feverTimer = setTimeout(function () {
      feverTimer = null;
      try { stopFeverImpl(); } catch (e) { report(e); }
    }, total);
  }

  function stopFeverImpl(silent) {
    if (feverTimer) { clearTimeout(feverTimer); feverTimer = null; }
    if (fever.out && ctx) {
      var o = fever.out;
      fever.out = null;
      smooth(o.gain, 0, 0.08);
      setTimeout(function () { try { o.disconnect(); } catch (e) {} }, 700);
    }
    if (feverActive) {
      feverActive = false;
      if (!silent) applyDuck();
    }
  }

  // ---------------------------------------------------------------------------
  // Jingles
  // ---------------------------------------------------------------------------
  function levelClearImpl() {
    var t = now(), base = pegRoot + 12, s = 0.11;
    var seq = [[0, 0], [1, 4], [2, 7], [3, 9], [4.5, 7], [5, 12]];
    for (var i = 0; i < seq.length; i++) {
      fmBell(t + seq[i][0] * s, mtof(base + seq[i][1]), { ratio: 3.0, index: 1.0, tau: 0.3, peak: 0.14, pan: -0.3 + i * 0.12 });
      kalimba(t + seq[i][0] * s, base + seq[i][1] - 12, 0, 0.12, G.sfxBus, 1.2);
    }
    var tc = t + 6 * s;
    var chord = [base - 12, base + 4, base + 7, base + 12, base + 16];
    for (var k = 0; k < chord.length; k++) fmBell(tc + k * 0.018, mtof(chord[k]), { ratio: 2.0, index: 0.7, tau: 0.6, len: 2.6, peak: 0.09 });
    bass(tc, base - 24, 0.6, 0.3, G.sfxBus);
    sparkle(tc + 0.15, 4, mtof(base + 24));
  }

  function failImpl() {
    var t = now(), base = pegRoot + 12;
    var seq = [[0, 7, 0.22], [0.24, 4, 0.22], [0.48, 2, 0.22], [0.74, 0, 0.9]];
    for (var i = 0; i < seq.length; i++) {
      var tt = t + seq[i][0], d = seq[i][2], last = i === seq.length - 1;
      var v = new Voice(), end = tt + d + 0.4;
      var out = v.output(G.sfxBus, 0, true);
      var o = v.s(oscN('triangle', mtof(base + seq[i][1]), tt), tt, end);
      var lp = v.n(filt('lowpass', 1600, 0.5));
      if (last) {
        o.detune.setValueAtTime(0, tt + 0.25);
        o.detune.linearRampToValueAtTime(-120, tt + d);
        var lfo = v.s(oscN('sine', 5.5, tt), tt, end), lg = v.n(gainN(0));
        lg.gain.setValueAtTime(0, tt);
        lg.gain.linearRampToValueAtTime(18, tt + 0.4);
        chain(lfo, lg); lg.connect(o.detune);
      }
      chain(o, lp, out);
      out.gain.setValueAtTime(0, tt);
      out.gain.linearRampToValueAtTime(0.16, tt + 0.03);
      out.gain.setTargetAtTime(0.1, tt + 0.03, 0.15);
      out.gain.setTargetAtTime(0, tt + d, 0.08);
      v.done();
    }
    pad(t, [base - 24, base - 17, base - 12], 1.4, 0.05, G.sfxBus);
  }

  function uiImpl() {
    var t = now(), v = new Voice(), end = t + 0.06;
    var out = v.output(G.sfxBus, 0, false);
    var o = v.s(oscN('sine', 1500, t), t, end);
    o.frequency.setTargetAtTime(1150, t, 0.01);
    o.connect(out);
    envPerc(out.gain, t, 0.09, 0.001, 0.01, end);
    v.done();
  }

  function ballLostImpl() {
    var t = now();
    var v = new Voice(), end = t + 0.35;
    var out = v.output(G.sfxBus, 0, true);
    var o = v.s(oscN('sine', 620, t), t, end);
    o.frequency.exponentialRampToValueAtTime(160, t + 0.3);
    o.connect(out);
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(0.09, t + 0.02);
    out.gain.setValueAtTime(0.09, t + 0.2);
    out.gain.setTargetAtTime(0, t + 0.2, 0.04);
    v.done();
    // river "plunk": quick upward bubble + soft splash
    var tp = t + 0.3;
    var b = new Voice(), be = tp + 0.25;
    var bo = b.output(G.sfxBus, 0, true);
    var bs = b.s(oscN('sine', 260, tp), tp, be);
    bs.frequency.exponentialRampToValueAtTime(720, tp + 0.07);
    bs.connect(bo);
    envPerc(bo.gain, tp, 0.18, 0.003, 0.04, be);
    b.done();
    noiseHit(tp, { type: 'lowpass', f: 1800, f2: 500, ftau: 0.08, q: 0.5, peak: 0.07, tau: 0.08, len: 0.35, wet: true });
  }

  // ---------------------------------------------------------------------------
  // Background music: lookahead sequencer ("two clocks")
  // ---------------------------------------------------------------------------
  var MAJOR = [0, 2, 4, 5, 7, 9, 11];
  var MINOR = [0, 2, 3, 5, 7, 8, 10];
  var LYDIAN = [0, 2, 4, 6, 7, 9, 11];

  // Motif notes: [step, scale-degree offset from the chord root, length in steps]
  var TRACKS = [
    { // 0: "Lanterns on the Water" - D major, kalimba, gentle swing
      name: 'Lanterns on the Water', root: 62, scale: MAJOR, step: 0.18, barSteps: 16, swing: 0.14,
      lead: 'kalimba', leadOct: 12, leadVel: 0.32, arp: 'musicBox', arpVel: 0.1, bassSteps: [[0, 7], [8, 6, 4]],
      motifs: {
        a: [[0, 4, 3], [3, 2, 1], [4, 0, 4], [8, 1, 2], [10, 2, 6]],
        b: [[0, 2, 2], [2, 4, 2], [4, 7, 4], [10, 4, 2], [12, 5, 4]],
        c: [[0, 4, 6], [6, 2, 2], [8, 0, 8]],
        d: [[0, 7, 4], [4, 6, 2], [6, 4, 2], [8, 2, 4], [12, 4, 4]],
        e: [[2, 0, 2], [4, 2, 2], [6, 4, 2], [8, 5, 6], [14, 4, 2]],
        f: [[0, 4, 4], [4, 3, 2], [6, 2, 2], [8, 4, 4], [12, 7, 4]],
        g: [[0, 0, 12]]
      },
      form: [
        { chords: [0, 5, 3, 4, 0, 5, 1, 4], lead: 'abacabdc', lvl: 0 },
        { chords: [0, 5, 3, 4, 0, 3, 4, 0], lead: 'abacabeg', lvl: 1 },
        { chords: [3, 4, 2, 5, 3, 4, 1, 4], lead: 'ddeedfec', lvl: 2, arp: true },
        { chords: [0, 5, 3, 4, 0, 3, 4, 0], lead: 'abacbdcg', lvl: 2 }
      ],
      perc: { shaker: '4.2.4.2.4.2.4.23', wood: '....3.......3..2', kick: '5.......4.......' },
      wood: 1050
    },
    { // 1: "Paper Boats" - A minor, 6/8, koto, wistful
      name: 'Paper Boats', root: 57, scale: MINOR, step: 0.2, barSteps: 12, swing: 0,
      lead: 'koto', leadOct: 12, leadVel: 0.42, arp: 'kalimba', arpVel: 0.11, bassSteps: [[0, 5], [6, 5, 4]],
      motifs: {
        a: [[0, 0, 2], [2, 2, 2], [4, 4, 4], [8, 5, 2], [10, 4, 2]],
        b: [[0, 7, 6], [6, 4, 3], [9, 2, 3]],
        c: [[0, 4, 2], [2, 2, 2], [4, 1, 2], [6, 0, 6]],
        d: [[0, 2, 3], [3, 4, 3], [6, 7, 4], [10, 6, 2]],
        e: [[0, 4, 9], [9, 2, 3]],
        h: [[0, 7, 2], [2, 6, 2], [4, 4, 2], [6, 2, 4], [10, 1, 2]],
        f: [[0, 0, 12]]
      },
      form: [
        { chords: [0, 5, 2, 6, 0, 5, 3, 4], lead: 'a-b-acbc', lvl: 0 },
        { chords: [0, 5, 2, 6, 0, 5, 4, 0], lead: 'abadahcf', lvl: 1 },
        { chords: [5, 6, 2, 0, 5, 6, 3, 4], lead: 'ddeehdec', lvl: 2, arp: true },
        { chords: [0, 5, 2, 6, 0, 5, 4, 0], lead: 'abadhbcf', lvl: 1, arp: true }
      ],
      perc: { shaker: '3.1.2.3.1.2.', wood: '......2.....', kick: '4.....2.....' },
      wood: 820
    },
    { // 2: "Fireflies over the Bridge" - F lydian, music box, sprightly
      name: 'Fireflies over the Bridge', root: 65, scale: LYDIAN, step: 0.15, barSteps: 16, swing: 0.1,
      lead: 'musicBox', leadOct: 12, leadVel: 0.2, arp: 'kalimba', arpVel: 0.12, bassSteps: [[0, 3], [6, 2, 4], [8, 3], [12, 3, 4]],
      motifs: {
        a: [[0, 0, 2], [2, 4, 2], [4, 7, 2], [6, 4, 2], [8, 9, 4], [12, 7, 4]],
        b: [[0, 7, 3], [3, 6, 1], [4, 4, 4], [8, 2, 2], [10, 4, 6]],
        c: [[0, 4, 2], [2, 5, 2], [4, 7, 4], [8, 4, 8]],
        d: [[0, 2, 2], [2, 4, 2], [4, 2, 2], [6, 0, 2], [8, 4, 8]],
        e: [[0, 9, 2], [2, 7, 2], [4, 9, 2], [6, 11, 2], [8, 9, 4], [12, 7, 4]],
        g: [[0, 7, 10], [12, 4, 4]]
      },
      form: [
        { chords: [0, 1, 0, 1, 5, 2, 4, 4], lead: 'abab dcd-', lvl: 0 },
        { chords: [0, 1, 0, 1, 5, 2, 4, 0], lead: 'ababecdg', lvl: 1 },
        { chords: [5, 2, 1, 4, 5, 2, 6, 4], lead: 'dcdcedc-', lvl: 2, arp: true },
        { chords: [0, 1, 0, 1, 5, 2, 4, 0], lead: 'ababedcg', lvl: 2 }
      ],
      perc: { shaker: '4.2.4.2.4.2.4.2.', wood: '..3...3...3..43.', kick: '5.......4...2...' },
      wood: 1250
    }
  ];
  // strip accidental spaces in lead strings
  for (var ti = 0; ti < TRACKS.length; ti++) {
    for (var fi = 0; fi < TRACKS[ti].form.length; fi++) TRACKS[ti].form[fi].lead = TRACKS[ti].form[fi].lead.replace(/\s/g, '');
  }

  var INSTR = { kalimba: kalimba, koto: koto, musicBox: musicBox };
  var LOOKAHEAD = 0.25;   // seconds scheduled ahead (generous for console timer jitter)
  var TICK_MS = 30;
  var mus = { st: null, timer: null, out: null, index: -1 };

  function scaleMidi(tr, deg, base) {
    var oct = Math.floor(deg / 7), idx = deg - oct * 7;
    return tr.root + base + 12 * oct + tr.scale[idx];
  }
  function wrapInto(m, lo, hi) { while (m < lo) m += 12; while (m > hi) m -= 12; return m; }
  function percVel(str, s) {
    var ch = str.charAt(s);
    if (!ch || ch === '.') return 0;
    return (+ch || 0) / 9;
  }

  function planBar(tr, bar, loop) {
    var secIdx = Math.floor(bar / 8) % tr.form.length, sec = tr.form[secIdx], b = bar % 8;
    var deg = sec.chords[b], mot = sec.lead.charAt(b) || '-';
    var rng = mkRng(1009 + loop * 7919 + bar * 131 + tr.root);
    var ev = [];
    function add(s, e) { if (s < 0 || s >= tr.barSteps) return; (ev[s] || (ev[s] = [])).push(e); }

    // lead (with variations on repeats)
    var notes = tr.motifs[mot];
    var dropBar = loop > 0 && mot !== 'g' && mot !== 'f' && rng() < 0.12;
    if (notes && !dropBar) {
      var base = deg >= 4 ? deg - 7 : deg;
      var lift = (secIdx === 3 && (loop % 2 === 1) && b < 4) ? 7 : 0;
      var taken = {};
      for (var i = 0; i < notes.length; i++) taken[notes[i][0]] = true;
      for (i = 0; i < notes.length; i++) {
        var nt = notes[i];
        var d = base + nt[1] + lift;
        var vel = tr.leadVel * (0.85 + 0.3 * rng()) * (nt[0] % 4 === 0 ? 1 : 0.88);
        add(nt[0], { k: 'lead', m: scaleMidi(tr, d, tr.leadOct), d: nt[2], v: vel });
        if (loop > 0 && nt[2] >= 4 && nt[0] >= 1 && !taken[nt[0] - 1] && rng() < 0.3) {
          add(nt[0] - 1, { k: 'lead', m: scaleMidi(tr, d + 1, tr.leadOct), d: 1, v: vel * 0.55 });
        }
      }
    }
    // arpeggio layer
    if (sec.arp || (loop > 0 && secIdx === 1 && b >= 4)) {
      var pat = [0, 2, 4, 7, 4, 2];
      var every = tr.barSteps === 12 ? 2 : 2;
      for (var s = 0, j = 0; s < tr.barSteps; s += every, j++) {
        add(s, { k: 'arp', m: wrapInto(scaleMidi(tr, deg + pat[j % pat.length], 0), 60, 84), d: 2, v: tr.arpVel * (s === 0 ? 1 : 0.8) });
      }
    }
    // pad and bass
    var chord = [scaleMidi(tr, deg, 0), scaleMidi(tr, deg + 2, 0), scaleMidi(tr, deg + 4, 0)];
    for (i = 0; i < 3; i++) chord[i] = wrapInto(chord[i], 52, 67);
    add(0, { k: 'pad', ms: chord, d: tr.barSteps, v: 0.05 });
    for (i = 0; i < tr.bassSteps.length; i++) {
      var bs = tr.bassSteps[i];
      if (secIdx === 0 && loop === 0 && i > 0 && b < 2) continue; // sparse opening
      add(bs[0], { k: 'bass', m: wrapInto(scaleMidi(tr, deg + (bs[2] || 0), 0), 36, 50), d: bs[1], v: 0.26 });
    }
    // percussion layers by section intensity
    var lvl = Math.max(sec.lvl, loop > 0 ? 1 : 0);
    for (s = 0; s < tr.barSteps; s++) {
      var sv = percVel(tr.perc.shaker, s);
      if (sv && !(lvl === 0 && s % 4 !== 0)) add(s, { k: 'shaker', v: sv * 0.09 });
      var wv = percVel(tr.perc.wood, s);
      if (wv && lvl >= 1) add(s, { k: 'wood', v: wv * 0.09, f: tr.wood * (s % 8 < 4 ? 1 : 1.19) });
      var kv = percVel(tr.perc.kick, s);
      if (kv && lvl >= 2) add(s, { k: 'kick', v: kv * 0.32 });
    }
    // occasional lantern-glint chime at phrase starts
    if (b % 4 === 0 && (secIdx > 0 || loop > 0)) add(0, { k: 'chime', m: scaleMidi(tr, deg + 4, 24), v: 0.06 });
    return ev;
  }

  function scheduleStep(st, t) {
    var tr = st.tr, bs = tr.barSteps;
    var s = st.step % bs;
    var barAbs = Math.floor(st.step / bs);
    var totalBars = tr.form.length * 8;
    if (s === 0 || !st.plan) st.plan = planBar(tr, barAbs % totalBars, Math.floor(barAbs / totalBars));
    var evs = st.plan[s];
    if (!evs) return;
    var tt = t + ((s % 2 === 1) ? tr.swing * tr.step : 0);
    var dest = st.out;
    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];
      switch (e.k) {
        case 'lead': INSTR[tr.lead](tt, e.m, e.d * tr.step, e.v, dest); break;
        case 'arp': INSTR[tr.arp](tt, e.m, e.d * tr.step, e.v, dest); break;
        case 'pad': pad(tt, e.ms, e.d * tr.step, e.v, dest); break;
        case 'bass': bass(tt, e.m, e.d * tr.step * 0.9, e.v, dest); break;
        case 'shaker': shaker(tt, e.v, dest); break;
        case 'wood': woodblock(tt, e.v, e.f, dest); break;
        case 'kick': softKick(tt, e.v, dest); break;
        case 'chime': musicBox(tt, e.m, 0, e.v, dest); break;
      }
    }
  }

  function pump(horizon) {
    var st = mus.st;
    if (!st) return;
    // Fell far behind (context was suspended / timers throttled): resync instead of bursting.
    if (st.next < ctx.currentTime - 0.08) st.next = ctx.currentTime + 0.05;
    var guard = 0;
    while (st.next < horizon && guard++ < 256) {
      try { scheduleStep(st, st.next); } catch (e) { report(e); }
      st.next += st.tr.step;
      st.step++;
    }
  }

  function tick() {
    mus.timer = null;
    if (!mus.st || !ctx) return;
    try {
      if (ctx.state === 'running' && !paused) pump(ctx.currentTime + LOOKAHEAD);
    } catch (e) { report(e); }
    mus.timer = setTimeout(tick, TICK_MS);
  }

  function musicStartImpl(idx) {
    idx = (+idx) | 0;
    if (!ctx) { pendingTrack = idx; return; }
    var n = ((idx % TRACKS.length) + TRACKS.length) % TRACKS.length;
    if (mus.st && mus.index === n) return; // already playing this track
    musicStopImpl();
    var tr = TRACKS[n];
    pegRoot = wrapInto(tr.root, 57, 68);
    var out = gainN(0);
    out.connect(G.musicIn);
    var t = ctx.currentTime;
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(1, t + 1.0);
    mus.index = n;
    mus.st = { tr: tr, step: 0, next: t + 0.1, plan: null, out: out };
    if (mus.timer) clearTimeout(mus.timer);
    tick();
  }

  function musicStopImpl() {
    pendingTrack = null;
    if (mus.timer) { clearTimeout(mus.timer); mus.timer = null; }
    var st = mus.st;
    mus.st = null; mus.index = -1;
    if (st && ctx) {
      var o = st.out;
      smooth(o.gain, 0, 0.12);
      setTimeout(function () { try { o.disconnect(); } catch (e) {} }, 1200);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  api.unlock = ctl(function () {
    if (!AC) return;
    if (!ctx) {
      try { ctx = new AC({ latencyHint: 'interactive' }); }
      catch (e) { ctx = new AC(); }
      buildGraph();
      // tiny silent buffer helps some browsers fully unlock output
      try {
        var sb = ctx.createBufferSource(); sb.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        sb.connect(ctx.destination); sb.start(0);
        sb.onended = function () { try { sb.disconnect(); } catch (e) {} };
      } catch (e) {}
    }
    if (!paused && ctx.state !== 'running' && ctx.resume) {
      var p = ctx.resume(); if (p && p.catch) p.catch(function () {});
    }
    if (pendingTrack != null) { var pt = pendingTrack; pendingTrack = null; musicStartImpl(pt); }
  });

  api.setMusicVolume = ctl(function (v) {
    musicVol = clamp01(v);
    if (ctx) smooth(G.musicVol.gain, curve(musicVol), 0.08);
  });
  api.setSfxVolume = ctl(function (v) {
    sfxVol = clamp01(v);
    if (ctx) { smooth(G.sfxBus.gain, curve(sfxVol), 0.08); smooth(G.sfxWet.gain, curve(sfxVol) * 0.32, 0.08); }
  });

  api.pegHit = sfx(pegHitImpl);
  api.brickHit = sfx(brickHitImpl);
  api.launch = sfx(launchImpl);
  api.bounceWall = sfx(bounceWallImpl);
  api.bucket = sfx(bucketImpl);
  api.extraBall = sfx(extraBallImpl);
  api.powerReady = sfx(powerReadyImpl);
  api.explosion = sfx(explosionImpl);
  api.fire = sfx(fireImpl);
  api.zap = sfx(zapImpl);
  api.magnet = sfx(magnetImpl);
  api.tension = sfx(tensionImpl);
  api.stopTension = ctl(function () { if (ctx) stopTensionImpl(); });
  api.feverStart = sfx(feverStartImpl);
  api.feverMusic = sfx(feverMusicImpl);
  api.stopFever = ctl(function () { if (ctx) stopFeverImpl(); });
  api.levelClear = sfx(levelClearImpl);
  api.fail = sfx(failImpl);
  api.ui = sfx(uiImpl);
  api.ballLost = sfx(ballLostImpl);

  api.music = {
    start: ctl(musicStartImpl),
    stop: ctl(musicStopImpl),
    duck: ctl(function (on) { userDuck = !!on; applyDuck(); }),
    trackCount: TRACKS.length
  };

  api.setPaused = ctl(function (on) {
    on = !!on;
    paused = on;
    if (!ctx) return;
    if (on) {
      stopTensionImpl();
      if (ctx.suspend) { var p = ctx.suspend(); if (p && p.catch) p.catch(function () {}); }
    } else {
      if (ctx.resume) { var q = ctx.resume(); if (q && q.catch) q.catch(function () {}); }
      // the scheduler resyncs itself if it fell behind
    }
  });

  // Test/diagnostic hooks (not part of the game contract).
  api._debug = {
    attachContext: function (c) { ctx = c; buildGraph(); if (pendingTrack != null) { var p = pendingTrack; pendingTrack = null; musicStartImpl(p); } },
    pumpMusic: function (horizon) { if (ctx) pump(horizon); },
    stopTimers: function () { if (mus.timer) { clearTimeout(mus.timer); mus.timer = null; } },
    activeVoices: function () { return activeVoices; },
    pegVoices: function () { return pegPool.length; },
    tracks: TRACKS.map(function (t) { return t.name; })
  };

  root.LanternAudio = api;
})(typeof window !== 'undefined' ? window : this);
