/*
 * Lantern Drop - level layouts.
 * Classic script: assigns window.LANTERN_LEVELS. No dependencies, deterministic.
 * Board: 800 x 620, launcher at (400, 36). Pegs are glowing lanterns; colours are assigned at runtime.
 *
 * Moving pegs:
 *   circle: pos = (cx + r*cos(phase + speed*t), cy + r*sin(phase + speed*t))
 *   line:   u = frac(phase + speed*t); s = u < 0.5 ? 2u : 2 - 2u; pos = A + (B - A) * s   (triangle ping-pong)
 */
(function () {
  "use strict";

  var W = 800;
  var TAU = Math.PI * 2;
  var ROUND_R = 9, BRICK_HALF = 14;
  var MIN_X = 30, MAX_X = 770, MIN_Y = 110, MAX_Y = 545;
  var LAUNCH_X = 400, LAUNCH_Y = 36, LAUNCH_CLEAR = 70;
  var SPACE_ROUND = 22, SPACE_BRICK = 30, SPACE_MOVE = 22;
  var PATH_SAMPLES = 200;

  function r2(v) { return Math.round(v * 100) / 100; }
  function normAngle(a) {
    a = a % Math.PI; // bricks are symmetric under rotation by PI
    if (a < 0) a += Math.PI;
    return r2(a);
  }

  // ---------- seeded PRNG (mulberry32) ----------
  function prng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- motion ----------
  function movePos(m, t) {
    if (m.type === "circle") {
      var a = m.phase + m.speed * t;
      return [m.cx + m.r * Math.cos(a), m.cy + m.r * Math.sin(a)];
    }
    var u = m.phase + m.speed * t;
    u = u - Math.floor(u);
    var s = u < 0.5 ? 2 * u : 2 - 2 * u;
    return [m.ax + (m.bx - m.ax) * s, m.ay + (m.by - m.ay) * s];
  }
  function movePeriod(m) {
    return m.type === "circle" ? TAU / Math.abs(m.speed) : 1 / Math.abs(m.speed);
  }
  function samplePath(m) {
    var pts = [], T = movePeriod(m);
    for (var i = 0; i < PATH_SAMPLES; i++) pts.push(movePos(m, (T * i) / PATH_SAMPLES));
    return pts;
  }

  // ---------- curve sampling (even arc-length spacing, tangent angles) ----------
  // f(t) -> [x, y] for t in [t0, t1]. Returns [{x, y, a}] spaced `gap` apart along the curve.
  function along(f, t0, t1, gap, offset) {
    var N = 600, pts = [], i;
    for (i = 0; i <= N; i++) pts.push(f(t0 + ((t1 - t0) * i) / N));
    var out = [], acc = 0, next = offset || 0;
    for (i = 1; i <= N; i++) {
      var p = pts[i - 1], q = pts[i];
      var seg = Math.hypot(q[0] - p[0], q[1] - p[1]);
      while (seg > 0 && next <= acc + seg) {
        var k = (next - acc) / seg;
        out.push({ x: p[0] + (q[0] - p[0]) * k, y: p[1] + (q[1] - p[1]) * k, a: Math.atan2(q[1] - p[1], q[0] - p[0]) });
        next += gap;
      }
      acc += seg;
    }
    return out;
  }
  function arcFn(cx, cy, r) { return function (t) { return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; }; }
  function lineFn(x0, y0, x1, y1) { return function (t) { return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]; }; }
  function polyFn(points) {
    // piecewise-linear over t in [0, points.length - 1]
    return function (t) {
      var i = Math.min(Math.floor(t), points.length - 2), k = t - i;
      var p = points[i], q = points[i + 1];
      return [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k];
    };
  }
  function spiralFn(cx, cy, r0, growPerRad, rot) {
    return function (t) { var r = r0 + growPerRad * t; return [cx + r * Math.cos(t + rot), cy + r * Math.sin(t + rot)]; };
  }
  function waveFn(x0, x1, yMid, amp, waves, phase) {
    return function (t) { return [x0 + (x1 - x0) * t, yMid + amp * Math.sin(phase + TAU * waves * t)]; };
  }
  // catenary hanging between (x1, yp) and (x2, yp), lowest point `sag` below
  function catenaryFn(x1, x2, yp, sag) {
    var h = (x2 - x1) / 2, xm = (x1 + x2) / 2, lo = 1, hi = 1e5;
    for (var i = 0; i < 80; i++) {
      var a = (lo + hi) / 2;
      if (a * (Math.cosh(h / a) - 1) > sag) lo = a; else hi = a;
    }
    var A = (lo + hi) / 2;
    return function (t) { var x = x1 + (x2 - x1) * t; return [x, yp + sag - A * (Math.cosh((x - xm) / A) - 1)]; };
  }

  // ---------- level builder: every add is validated, invalid pegs are skipped ----------
  function Builder(name, hint) {
    this.name = name;
    this.hint = hint;
    this.pegs = [];
    this.statics = [];   // {x, y, brick}
    this.movers = [];    // {m, path}
  }
  Builder.prototype.inBounds = function (x, y, ext) {
    return x - ext >= MIN_X && x + ext <= MAX_X && y - ext >= MIN_Y && y <= MAX_Y &&
      Math.hypot(x - LAUNCH_X, y - LAUNCH_Y) >= LAUNCH_CLEAR + ext;
  };
  Builder.prototype.staticFits = function (x, y, brick) {
    if (!this.inBounds(x, y, brick ? BRICK_HALF : ROUND_R)) return false;
    var i, j, s;
    for (i = 0; i < this.statics.length; i++) {
      s = this.statics[i];
      var need = brick || s.brick ? SPACE_BRICK : SPACE_ROUND;
      if (Math.hypot(s.x - x, s.y - y) < need) return false;
    }
    for (i = 0; i < this.movers.length; i++) {
      var need2 = brick ? SPACE_BRICK : SPACE_MOVE, path = this.movers[i].path;
      for (j = 0; j < path.length; j++) if (Math.hypot(path[j][0] - x, path[j][1] - y) < need2) return false;
    }
    return true;
  };
  Builder.prototype.round = function (x, y) {
    if (!this.staticFits(x, y, false)) return false;
    this.statics.push({ x: x, y: y, brick: false });
    this.pegs.push({ x: r2(x), y: r2(y), shape: "round" });
    return true;
  };
  Builder.prototype.brick = function (x, y, a) {
    if (!this.staticFits(x, y, true)) return false;
    this.statics.push({ x: x, y: y, brick: true });
    this.pegs.push({ x: r2(x), y: r2(y), shape: "brick", angle: normAngle(a) });
    return true;
  };
  // mirrored helpers (left-right symmetry about x = 400)
  Builder.prototype.round2 = function (x, y) { this.round(x, y); if (Math.abs(x - W / 2) > 1) this.round(W - x, y); };
  Builder.prototype.brick2 = function (x, y, a) { this.brick(x, y, a); if (Math.abs(x - W / 2) > 1) this.brick(W - x, y, Math.PI - a); };
  Builder.prototype.rounds = function (pts, mirror) { for (var i = 0; i < pts.length; i++) mirror ? this.round2(pts[i].x, pts[i].y) : this.round(pts[i].x, pts[i].y); };
  Builder.prototype.bricks = function (pts, mirror) { for (var i = 0; i < pts.length; i++) mirror ? this.brick2(pts[i].x, pts[i].y, pts[i].a) : this.brick(pts[i].x, pts[i].y, pts[i].a); };

  // Moving round peg. Rejected if its path leaves bounds or comes too close to anything.
  Builder.prototype.mover = function (m) {
    var path = samplePath(m), i, j, k;
    for (i = 0; i < path.length; i++) if (!this.inBounds(path[i][0], path[i][1], ROUND_R)) return false;
    for (i = 0; i < this.statics.length; i++) {
      var s = this.statics[i], need = s.brick ? SPACE_BRICK : SPACE_MOVE;
      for (j = 0; j < path.length; j++) if (Math.hypot(path[j][0] - s.x, path[j][1] - s.y) < need) return false;
    }
    // other movers: compare at equal times over a long horizon
    var T = 120, steps = 2400;
    for (k = 0; k < this.movers.length; k++) {
      var o = this.movers[k].m;
      for (j = 0; j <= steps; j++) {
        var t = (T * j) / steps, p = movePos(m, t), q = movePos(o, t);
        if (Math.hypot(p[0] - q[0], p[1] - q[1]) < SPACE_MOVE) return false;
      }
    }
    var mm = {};
    for (var key in m) mm[key] = typeof m[key] === "number" && key !== "type" ? r2(m[key]) : m[key];
    // re-derive with rounded params so stored data is self-consistent
    path = samplePath(mm);
    this.movers.push({ m: mm, path: path });
    var p0 = movePos(mm, 0);
    this.pegs.push({ x: r2(p0[0]), y: r2(p0[1]), shape: "round", move: mm });
    return true;
  };
  // rotating ring of n movers
  Builder.prototype.spinRing = function (cx, cy, r, n, speed, phase0) {
    for (var i = 0; i < n; i++)
      this.mover({ type: "circle", cx: cx, cy: cy, r: r, speed: speed, phase: (phase0 || 0) + (TAU * i) / n });
  };
  // sliding bar: `count` pegs in a row (direction dx,dy step `gap`), all sliding by (sx, sy)
  Builder.prototype.slideBar = function (x0, y0, count, gap, sx, sy, speed, phase) {
    for (var i = 0; i < count; i++) {
      var ax = x0 + i * gap, ay = y0;
      this.mover({ type: "line", ax: ax, ay: ay, bx: ax + sx, by: ay + sy, speed: speed, phase: phase });
    }
  };
  Builder.prototype.done = function () { return { name: this.name, hint: this.hint, pegs: this.pegs }; };

  // ---------- small layout helpers ----------
  function ringPts(cx, cy, r, gap, rot) { return along(arcFn(cx, cy, r), rot || 0, (rot || 0) + TAU - 1e-6, gap); }
  function arcPts(cx, cy, r, a0, a1, gap) { return along(arcFn(cx, cy, r), a0, a1, gap); }
  function linePts(x0, y0, x1, y1, gap) { return along(lineFn(x0, y0, x1, y1), 0, 1, gap); }
  // jittered grid inside a predicate region, seeded
  function jitterGrid(rand, x0, y0, x1, y1, step, jit, keep) {
    var out = [];
    for (var y = y0; y <= y1; y += step)
      for (var x = x0; x <= x1; x += step) {
        var px = x + (rand() * 2 - 1) * jit, py = y + (rand() * 2 - 1) * jit;
        if (!keep || keep(px, py)) out.push({ x: px, y: py, a: rand() * Math.PI });
      }
    return out;
  }

  var levels = [];

  // 1. Riverbank Steps - gentle mirrored staircases
  (function () {
    var L = new Builder("Riverbank Steps", "Bounce down the steps - shots that skim a staircase tend to keep rolling.");
    for (var s = 0; s < 2; s++) {
      var x0 = 60, y0 = s === 0 ? 170 : 330;
      for (var k = 0; k < 6; k++) {
        var x = x0 + k * 60, y = y0 + k * 34;
        L.brick2(x, y, 0);
        L.round2(x + 30, y + 17);
      }
    }
    for (var gy = 0; gy < 5; gy++)
      for (var gx = 0; gx < 5; gx++) L.round(340 + gx * 30, 180 + gy * 30 + (gx % 2) * 10);
    L.rounds(linePts(60, 540, 740, 540, 34));
    levels.push(L.done());
  })();

  // 2. Moonrise Arc - concentric arches
  (function () {
    var L = new Builder("Moonrise Arc", "Aim for the gaps between the arches to drop deep into the moon.");
    L.bricks(arcPts(400, 560, 340, Math.PI * 1.08, Math.PI * 1.92, 38));
    L.rounds(arcPts(400, 560, 290, Math.PI * 1.06, Math.PI * 1.94, 34));
    L.bricks(arcPts(400, 560, 230, Math.PI * 1.04, Math.PI * 1.96, 37));
    L.rounds(arcPts(400, 560, 170, Math.PI * 1.04, Math.PI * 1.96, 32));
    L.bricks(arcPts(400, 560, 110, Math.PI * 1.05, Math.PI * 1.95, 33));
    L.rounds(arcPts(400, 545, 50, Math.PI, Math.PI * 2, 26));
    // stars
    var rnd = prng(202);
    var st = jitterGrid(rnd, 50, 130, 750, 160, 90, 10);
    L.rounds(st.filter(function (p) { return p.x < 400; }), true);
    levels.push(L.done());
  })();

  // 3. Willow Rain - drooping waves
  (function () {
    var L = new Builder("Willow Rain", "Willow fronds sway in waves - ride a crest to reach the far side.");
    for (var i = 0; i < 5; i++) {
      var y = 160 + i * 88, phase = i % 2 ? Math.PI : 0;
      var pts = along(waveFn(50, 750, y, 22, 2.5, phase), 0, 1, i % 2 ? 34 : 36);
      if (i % 2) L.rounds(pts); else L.bricks(pts);
    }
    levels.push(L.done());
  })();

  // 4. Lantern String - catenary strings of bricks with hanging lanterns
  (function () {
    var L = new Builder("Lantern String", "Strings sag in the middle - a soft shot will follow the curve down.");
    var spans = [[40, 400], [400, 760]];
    var rows = [[150, 70], [290, 80], [430, 70]];
    for (var r = 0; r < rows.length; r++) {
      for (var s = 0; s < spans.length; s++) {
        var f = catenaryFn(spans[s][0], spans[s][1], rows[r][0], rows[r][1]);
        var pts = along(f, 0, 1, 32, 16);
        L.bricks(pts);
        // hanging lanterns every other brick
        for (var i = 1; i < pts.length; i += 2) L.round(pts[i].x, pts[i].y + 30);
      }
    }
    L.rounds(linePts(60, 540, 740, 540, 40));
    levels.push(L.done());
  })();

  // 5. Firefly Meadow - seeded mirrored clusters
  (function () {
    var L = new Builder("Firefly Meadow", "Fireflies gather in clusters - split a swarm to set off a chain.");
    var rnd = prng(5150);
    var centres = [[110, 190], [250, 160], [160, 330], [300, 290], [90, 470], [230, 450], [350, 420]];
    for (var c = 0; c < centres.length; c++) {
      var cx = centres[c][0], cy = centres[c][1];
      L.brick2(cx, cy, rnd() * Math.PI);
      for (var k = 0; k < 9; k++) {
        var a = rnd() * TAU, d = 28 + rnd() * 34;
        L.round2(cx + Math.cos(a) * d, cy + Math.sin(a) * d);
      }
    }
    L.rounds(linePts(400, 200, 400, 520, 30));
    levels.push(L.done());
  })();

  // 6. Lotus Pond - concentric rings with petals
  (function () {
    var L = new Builder("Lotus Pond", "The pond's rings are tight - glance off the outer petals to slip inside.");
    var cx = 400, cy = 340;
    L.rounds(ringPts(cx, cy, 34, 26));
    L.bricks(ringPts(cx, cy, 78, 32, 0.1));
    L.rounds(ringPts(cx, cy, 120, 34));
    L.bricks(ringPts(cx, cy, 165, 38, 0.05));
    // lily pads in the corners
    var pads = [[95, 170], [705, 170], [95, 480], [705, 480]];
    for (var p = 0; p < pads.length; p++) L.rounds(ringPts(pads[p][0], pads[p][1], 42, 25));
    L.round(pads[0][0], pads[0][1]); L.round(pads[1][0], pads[1][1]);
    L.round(pads[2][0], pads[2][1]); L.round(pads[3][0], pads[3][1]);
    levels.push(L.done());
  })();

  // 7. Paper Pinwheel - curved arms (static)
  (function () {
    var L = new Builder("Paper Pinwheel", "Each blade curls the same way - spin your aim with the blades, not against them.");
    var cx = 400, cy = 330, arms = 6;
    for (var a = 0; a < arms; a++) {
      var rot = (TAU * a) / arms;
      var f = function (t) { var r = 40 + 190 * t, th = rot + 1.4 * t; return [cx + r * Math.cos(th), cy + r * Math.sin(th)]; };
      L.bricks(along(f, 0, 1, 32, 6));
      var g = function (t) { var r = 55 + 175 * t, th = rot + 0.45 + 1.4 * t; return [cx + r * Math.cos(th), cy + r * Math.sin(th)]; };
      L.rounds(along(g, 0, 1, 32, 4));
    }
    L.round(cx, cy);
    var rnd = prng(77);
    L.rounds(jitterGrid(rnd, 50, 130, 750, 540, 84, 8, function (x, y) { return Math.hypot(x - cx, y - cy) > 250; }));
    levels.push(L.done());
  })();

  // 8. Crooked Footbridge - asymmetric
  (function () {
    var L = new Builder("Crooked Footbridge", "The bridge leans right - shots from the high side roll a long way.");
    var f = function (t) { var x = 50 + 700 * t; return [x, 470 - 300 * t + 120 * Math.sin(Math.PI * t) * -1 + 0]; };
    var deck = along(f, 0, 1, 32, 10);
    L.bricks(deck);
    for (var i = 0; i < deck.length; i += 2) L.round(deck[i].x, deck[i].y + 38);
    // stepping stones on the river below, curving left
    L.rounds(along(function (t) { return [80 + 520 * t, 540 - 70 * t * t]; }, 0, 1, 34));
    // reeds on the left bank
    for (var r = 0; r < 4; r++) L.bricks(linePts(70 + r * 34, 200, 80 + r * 34, 330, 31));
    // hanging lanterns on the high right
    L.rounds(arcPts(640, 140, 90, 0.2, Math.PI - 0.2, 26));
    var rnd = prng(808);
    L.rounds(jitterGrid(rnd, 300, 140, 560, 260, 40, 7));
    levels.push(L.done());
  })();

  // 9. Whirlpool - spiral (asymmetric)
  (function () {
    var L = new Builder("Whirlpool", "The current spirals inward - the deeper you go the tighter it turns.");
    var cx = 410, cy = 335;
    L.bricks(along(spiralFn(cx, cy, 30, 16, 0.3), 0, TAU * 2.25, 40, 20));
    L.rounds(along(spiralFn(cx, cy, 30, 16, 0.3 + Math.PI), 0.4, TAU * 2.1, 40, 10));
    var rnd = prng(909);
    L.rounds(jitterGrid(rnd, 45, 130, 755, 540, 72, 8, function (x, y) { return Math.hypot(x - cx, y - cy) > 245; }));
    levels.push(L.done());
  })();

  // 10. Turning Rings - rotating rings (moving circle pegs)
  (function () {
    var L = new Builder("Turning Rings", "The rings turn in opposite directions - time your shot for an opening.");
    L.spinRing(400, 330, 70, 14, 0.6, 0);
    L.spinRing(400, 330, 125, 22, -0.4, 0.1);
    L.round(400, 330);
    L.bricks(arcPts(400, 330, 190, Math.PI * 0.05, Math.PI * 0.95, 33));
    L.bricks(arcPts(400, 330, 190, Math.PI * 1.15, Math.PI * 1.85, 33));
    L.rounds(arcPts(400, 330, 230, Math.PI * 1.15, Math.PI * 1.85, 30));
    var cols = [70, 120, 680, 730];
    for (var c = 0; c < cols.length; c++) L.rounds(linePts(cols[c], 150 + (c % 2) * 20, cols[c], 540, 40));
    levels.push(L.done());
  })();

  // 11. Ferry Lines - sliding bars (moving line pegs)
  (function () {
    var L = new Builder("Ferry Lines", "Ferries glide across the river - lead your shot to meet them.");
    // three ferries sliding across mid-board
    L.slideBar(160, 250, 6, 26, 330, 0, 0.12, 0);
    L.slideBar(310, 330, 6, 26, -230, 0, 0.16, 0.25);
    L.slideBar(160, 410, 6, 26, 330, 0, 0.1, 0.5);
    // V funnel banks
    L.bricks(linePts(60, 140, 360, 215, 32), true);
    L.bricks(linePts(60, 470, 330, 530, 32), true);
    L.rounds(linePts(50, 180, 50, 450, 30), true);
    L.rounds(linePts(95, 290, 95, 380, 30), true);
    L.rounds(linePts(110, 140, 320, 140, 30), true);
    levels.push(L.done());
  })();

  // 12. Night Market Funnel - funnel with orbiting lanterns (asymmetric orbits)
  (function () {
    var L = new Builder("Night Market Funnel", "Stalls crowd into a funnel - lanterns orbit the left stall, so pick your moment.");
    var vl = linePts(50, 140, 340, 470, 32);
    L.bricks(vl, true);
    L.rounds(linePts(110, 140, 360, 425, 28), true);
    L.rounds(linePts(175, 140, 380, 375, 28), true);
    // orbiting lanterns: left orbit, right static cluster
    L.spinRing(220, 470, 45, 8, 0.9, 0);
    L.round(220, 470);
    L.rounds(ringPts(580, 470, 45, 30));
    L.round(580, 470);
    L.spinRing(400, 210, 50, 9, -0.7, 0);
    L.round(400, 210);
    L.rounds(linePts(400, 290, 400, 540, 34));
    levels.push(L.done());
  })();

  // 13. Dragonfly Wings - wings with vertical sliders
  (function () {
    var L = new Builder("Dragonfly Wings", "The body slides through the wings - a bounce off a slider changes everything.");
    var wings = [[225, 220, 130, 55, -0.3], [235, 400, 115, 48, 0.3]];
    for (var w = 0; w < wings.length; w++) {
      var cx = wings[w][0], cy = wings[w][1], rx = wings[w][2], ry = wings[w][3], tilt = wings[w][4];
      var ell = function (s) { return function (t) {
        var x = rx * s * Math.cos(t), y = ry * s * Math.sin(t);
        return [cx + x * Math.cos(tilt) - y * Math.sin(tilt), cy + x * Math.sin(tilt) + y * Math.cos(tilt)];
      }; };
      L.bricks(along(ell(1), 0, TAU - 1e-6, 33), true);
      L.rounds(along(ell(0.55), 0, TAU - 1e-6, 26), true);
      L.round2(cx, cy);
    }
    // body: vertical sliders through the centre
    L.slideBar(400, 150, 1, 0, 0, 120, 0.2, 0);
    L.slideBar(400, 180, 1, 0, 0, 120, 0.2, 0);
    L.slideBar(400, 210, 1, 0, 0, 120, 0.2, 0);
    L.slideBar(400, 330, 1, 0, 0, 140, 0.15, 0.5);
    L.slideBar(400, 360, 1, 0, 0, 140, 0.15, 0.5);
    L.slideBar(400, 390, 1, 0, 0, 120, 0.15, 0.5);
    L.rounds(linePts(60, 540, 740, 540, 36));
    levels.push(L.done());
  })();

  // 14. Festival Finale - everything at once
  (function () {
    var L = new Builder("Festival Finale", "The whole festival is moving - read the rhythm before you fire.");
    L.spinRing(220, 300, 55, 10, 0.8, 0);
    L.spinRing(580, 300, 55, 10, -0.8, 0);
    L.spinRing(400, 250, 60, 11, 0.5, 0.2);
    L.round(220, 300); L.round(580, 300); L.round(400, 250);
    L.slideBar(250, 470, 5, 26, 170, 0, 0.14, 0);
    L.slideBar(420, 420, 5, 26, -170, 0, 0.11, 0.3);
    L.bricks(arcPts(220, 300, 100, Math.PI * 0.55, Math.PI * 1.5, 33), true);
    L.rounds(arcPts(220, 300, 130, Math.PI * 0.6, Math.PI * 1.45, 28), true);
    L.bricks(along(catenaryFn(60, 740, 140, 40), 0, 1, 34, 10));
    L.rounds(linePts(60, 535, 740, 535, 52));
    levels.push(L.done());
  })();

  // ======================= Expansion levels (indices 14+) =======================
  // Indices 0-13 above must never change: saved best scores are keyed by index.

  // 15 (index 14). Stepping-Stone Ford - rows of stones with gaps (easy)
  (function () {
    var L = new Builder("Stepping-Stone Ford", "Some stones are missing - aim for the gaps to drop straight through the ford.");
    for (var row = 0; row < 6; row++) {
      var y = 175 + row * 66, shift = (row % 2) * 15;
      var pts = along(waveFn(45 + shift, 400, y, 8, 1.5, row), 0, 1, 31);
      for (var i = 0; i < pts.length; i++) if ((i + 2 * row) % 6 < 4) L.round2(pts[i].x, pts[i].y);
    }
    // reed banks: short tilted bricks at the edges
    for (var k = 0; k < 5; k++) L.brick2(60 + (k % 2) * 18, 205 + k * 66, Math.PI / 2 - 0.35);
    L.bricks(along(waveFn(60, 740, 530, 6, 2, 0), 0, 1, 40));
    levels.push(L.done());
  })();

  // 16 (index 15). Boat Moon - a crescent lying on its back, with stars (easy)
  (function () {
    var L = new Builder("Boat Moon", "The crescent cradles its lanterns - shots that roll along the rim find them.");
    var ox = 400, oy = 330, R = 200, ix = 400, iy = 250, r = 175;
    var outer = along(arcFn(ox, oy, R), 0, TAU - 1e-6, 34).filter(function (p) { return Math.hypot(p.x - ix, p.y - iy) > r + 12; });
    var inner = along(arcFn(ix, iy, r), 0, TAU - 1e-6, 34).filter(function (p) { return Math.hypot(p.x - ox, p.y - oy) < R - 12; });
    L.bricks(outer); L.bricks(inner);
    L.rounds(jitterGrid(prng(1616), 160, 380, 640, 530, 30, 0, function (x, y) {
      return Math.hypot(x - ox, y - oy) < R - 30 && Math.hypot(x - ix, y - iy) > r + 28;
    }));
    var rnd = prng(1617);
    L.rounds(jitterGrid(rnd, 50, 130, 400, 540, 62, 14, function (x, y) {
      return Math.hypot(x - ox, y - oy) > R + 30 || (Math.hypot(x - ix, y - iy) < r - 40 && y < 330);
    }), true);
    levels.push(L.done());
  })();

  // 17 (index 16). Teahouse Eaves - three tiers of upturned roofs
  (function () {
    var L = new Builder("Teahouse Eaves", "Upturned eaves flick the ball outward - land it on a ridge to slide inward.");
    var tiers = [[175, 130], [285, 225], [400, 330]];
    for (var i = 0; i < tiers.length; i++) {
      var ty = tiers[i][0], w = tiers[i][1];
      var roof = function (t) { var u = 2 * t - 1; return [400 + w * u, ty + 34 * u * u - 42 * Math.pow(u, 8)]; };
      var pts = along(roof, 0, 1, 32, (2 * w * 1.02) % 32 / 2);
      L.bricks(pts);
      for (var k = 1; k < pts.length - 1; k += 2) L.round(pts[k].x, pts[k].y + 30);
    }
    // pillars and porch
    for (var c = 0; c < 3; c++) L.bricks(linePts(150 + c * 50, 455, 150 + c * 50, 520, 32), true);
    L.rounds(linePts(330, 470, 470, 470, 28));
    L.rounds(linePts(45, 540, 755, 540, 30));
    levels.push(L.done());
  })();

  // 18 (index 17). Falling Water - vertical brick columns with splash fans
  (function () {
    var L = new Builder("Falling Water", "Columns of falling water funnel the ball down - find a splash to break out sideways.");
    var tops = [0, 60, 20, 90, 40, 110, 70];
    for (var k = 0; k < 13; k++) {
      var x = 70 + k * 55, d = Math.abs(k - 6), top = 150 + tops[d];
      var n = 4, bottom = top + (n - 1) * 32;
      for (var j = 0; j < n; j++) L.brick(x, top + j * 32, Math.PI / 2);
      L.round(x - 14, bottom + 30); L.round(x + 14, bottom + 30); L.round(x, bottom + 56);
    }
    L.rounds(linePts(70 + 27.5, 530, 730 - 27.5, 530, 55));
    L.rounds(linePts(70 + 27.5, 490, 730 - 27.5, 490, 110));
    levels.push(L.done());
  })();

  // 19 (index 18). Nested Kites - concentric diamonds
  (function () {
    var L = new Builder("Nested Kites", "Kite frames nest inside each other - a steep shot slips between the struts.");
    var cx = 400, cy = 330;
    var sizes = [[320, 200, "brick", 36], [215, 134, "round", 30], [110, 68, "brick", 34]];
    for (var s = 0; s < sizes.length; s++) {
      var hx = sizes[s][0], hy = sizes[s][1];
      var pts = along(polyFn([[cx, cy - hy], [cx + hx, cy], [cx, cy + hy], [cx - hx, cy], [cx, cy - hy]]), 0, 4 - 1e-9, sizes[s][3], 6);
      if (sizes[s][2] === "brick") L.bricks(pts); else L.rounds(pts);
    }
    L.round(cx, cy); L.round(cx - 34, cy); L.round(cx + 34, cy);
    // corner tails of the kites
    for (var c = 0; c < 2; c++) {
      var tail = along(waveFn(60, 230, 0, 12, 1.5, c * Math.PI), 0, 1, 28);
      for (var i = 0; i < tail.length; i++) L.round2(tail[i].x, (c ? 515 : 145) + tail[i].y + (c ? -1 : 1) * i * 4);
    }
    levels.push(L.done());
  })();

  // 20 (index 19). Skyburst - firework rays with a spinning core (moving)
  (function () {
    var L = new Builder("Skyburst", "The firework's core never stops spinning - hit it and the sparks fly everywhere.");
    var cx = 400, cy = 325;
    L.spinRing(cx, cy, 32, 6, 1.1, 0);
    for (var r = 0; r < 12; r++) {
      var a = (TAU * r) / 12 + Math.PI / 12;
      var pts = along(lineFn(cx + 66 * Math.cos(a), cy + 66 * Math.sin(a), cx + 200 * Math.cos(a), cy + 200 * Math.sin(a)), 0, 1, r % 2 ? 30 : 33);
      if (r % 2) L.rounds(pts); else L.bricks(pts);
    }
    var minis = [[95, 175], [95, 470], [705, 175], [705, 470]];
    for (var m = 0; m < minis.length; m++) {
      L.round(minis[m][0], minis[m][1]);
      L.rounds(ringPts(minis[m][0], minis[m][1], 34, 27, 0.3));
    }
    levels.push(L.done());
  })();

  // 21 (index 20). Wind Chimes - hanging chime clusters with swinging clappers (moving)
  (function () {
    var L = new Builder("Wind Chimes", "Clappers swing beneath the chimes - catch one mid-swing for a long ring.");
    var clusters = [[170, 150], [400, 170], [630, 150]];
    var lens = [2, 3, 4, 3, 2];
    for (var c = 0; c < clusters.length; c++) {
      var cx = clusters[c][0], top = clusters[c][1];
      L.bricks(along(catenaryFn(cx - 80, cx + 80, top - 6, 12), 0, 1, 32, 16));
      for (var k = 0; k < 5; k++)
        for (var j = 0; j < lens[k]; j++) L.brick(cx - 64 + k * 32, top + 34 + j * 32, Math.PI / 2);
      var cy = top + 34 + 3 * 32 + 44;
      L.mover({ type: "line", ax: cx - 72, ay: cy, bx: cx + 72, by: cy, speed: 0.22, phase: c * 0.2 });
      L.mover({ type: "line", ax: cx + 72, ay: cy + 30, bx: cx - 72, by: cy + 30, speed: 0.22, phase: c * 0.2 });
    }
    L.rounds(along(catenaryFn(45, 400, 410, 50), 0, 1, 30, 4), true);
    L.rounds(along(catenaryFn(110, 400, 485, 40), 0, 1, 34, 10), true);
    L.rounds(linePts(285, 230, 285, 330, 33), true);
    levels.push(L.done());
  })();

  // 22 (index 21). Dragon Boat - asymmetric boat silhouette with rowing oars (moving)
  (function () {
    var L = new Builder("Dragon Boat", "The oars pull in time beneath the hull - the dragon's head guards the right.");
    L.bricks(along(function (t) { return [140 + 520 * t, 400 + 80 * Math.sin(Math.PI * t)]; }, 0, 1, 32, 4));
    L.bricks(along(polyFn([[672, 395], [705, 330], [718, 265], [702, 218], [660, 200]]), 0, 4, 32, 4));
    L.bricks(along(polyFn([[128, 392], [100, 335], [92, 280], [112, 238], [152, 230]]), 0, 4, 32, 4));
    L.round(680, 250); L.round(642, 222); L.round(628, 250); L.round(132, 268);
    L.rounds(linePts(205, 395, 595, 395, 30));
    L.rounds(linePts(220, 360, 580, 360, 40));
    L.bricks(along(catenaryFn(50, 750, 140, 34), 0, 1, 33, 8));
    L.rounds(jitterGrid(prng(2222), 200, 215, 600, 315, 58, 9));
    for (var x = 220; x <= 580; x += 60)
      L.mover({ type: "line", ax: x + 20, ay: 518, bx: x - 22, by: 530, speed: 0.3, phase: 0 });
    levels.push(L.done());
  })();

  // 23 (index 22). Figure of Eight - two counter-rotating loops that share a crossing (moving)
  (function () {
    var L = new Builder("Figure of Eight", "Lanterns trade places at the crossing - fire through the waist as it clears.");
    var R = 110, cy = 320, n = 12, w = 0.55;
    for (var k = 0; k < n; k++) {
      L.mover({ type: "circle", cx: 400 - R, cy: cy, r: R, speed: w, phase: (TAU * k) / n });
      L.mover({ type: "circle", cx: 400 + R, cy: cy, r: R, speed: -w, phase: Math.PI + Math.PI / n + (TAU * k) / n });
    }
    for (var s = -1; s <= 1; s += 2) {
      var c = 400 + s * R;
      L.round(c, cy);
      L.rounds(ringPts(c, cy, 55, 27));
      var a0 = s < 0 ? 0.95 : -Math.PI + 0.95, a1 = s < 0 ? TAU - 0.95 : Math.PI - 0.95;
      L.bricks(arcPts(c, cy, 160, a0, a1, 34));
    }
    L.rounds(linePts(330, 520, 470, 520, 35));
    L.rounds(linePts(330, 130 + 20, 470, 150, 35));
    levels.push(L.done());
  })();

  // 24 (index 23). Turning Tide - mirrored rows of sliders at staggered phases (moving)
  (function () {
    var L = new Builder("Turning Tide", "Each row of the tide arrives a beat after the last - wait for the gaps to line up.");
    for (var row = 0; row < 6; row++) {
      var y = 170 + row * 70, ph = (row * 0.13) % 1;
      for (var i = 0; i < 3; i++) {
        var ax = 45 + i * 28;
        L.mover({ type: "line", ax: ax, ay: y, bx: ax + 270, by: y, speed: 0.12, phase: ph });
        L.mover({ type: "line", ax: W - ax, ay: y, bx: W - ax - 270, by: y, speed: 0.12, phase: ph });
      }
    }
    for (var s = 0; s < 5; s++) {
      var sy = 205 + s * 70;
      var pts = linePts(45 + (s % 2) * 25, sy, 395, sy, 50);
      for (var j = 0; j < pts.length; j++) (j % 3 === 1) ? L.brick2(pts[j].x, sy, 0) : L.round2(pts[j].x, sy);
    }
    L.rounds(linePts(50, 540, 750, 540, 50));
    levels.push(L.done());
  })();

  // 25 (index 24). Lantern Pendulums - three rods swinging in unison over a starfield (moving)
  (function () {
    var L = new Builder("Lantern Pendulums", "Three rods swing as one - the ball can ride a rod down if your timing is perfect.");
    var th = 0.42, sp = 0.18;
    var rods = [[400, 120, 100, 370], [160, 120, 70, 270], [640, 120, 70, 270]];
    for (var p = 0; p < rods.length; p++)
      for (var r = rods[p][2]; r <= rods[p][3]; r += 30) {
        var px = rods[p][0], py = rods[p][1];
        L.mover({ type: "line", ax: px - r * Math.sin(th), ay: py + r * Math.cos(th), bx: px + r * Math.sin(th), by: py + r * Math.cos(th), speed: sp, phase: 0 });
      }
    var rnd = prng(2525);
    var pts = jitterGrid(rnd, 45, 130, 400, 540, 44, 6);
    for (var i = 0; i < pts.length; i++) (i % 4 === 0) ? L.brick2(pts[i].x, pts[i].y, pts[i].a) : L.round2(pts[i].x, pts[i].y);
    levels.push(L.done());
  })();

  window.LANTERN_LEVELS = levels;

  // Campaign chapters: 5 x 5 level indices, difficulty rising within and across chapters.
  window.LANTERN_CHAPTERS = [
    { name: "Lanterns on the Riverbank", blurb: "The first lanterns are lit along the quiet water's edge.", levels: [0, 14, 1, 15, 2] },
    { name: "Downstream by Paper Light", blurb: "Follow the drifting lights past willows, ponds and teahouses.", levels: [3, 4, 16, 5, 17] },
    { name: "The Bridges at Dusk", blurb: "Footbridges and whirlpools stand between you and the town.", levels: [6, 18, 7, 8, 9] },
    { name: "Currents and Ferries", blurb: "The river comes alive with ferries, chimes and racing boats.", levels: [19, 10, 20, 11, 21] },
    { name: "The Festival's Last Night", blurb: "Everything moves on the final night - only steady aim will do.", levels: [12, 22, 23, 24, 13] },
  ];
})();
