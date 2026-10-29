// Node test for levels.js: node test/levels.test.js
"use strict";
const assert = require("assert");
const path = require("path");
const file = path.join(__dirname, "..", "src", "levels.js");

function load() {
  globalThis.window = globalThis;
  delete require.cache[require.resolve(file)];
  delete globalThis.LANTERN_LEVELS;
  delete globalThis.LANTERN_CHAPTERS;
  require(file);
  return { levels: globalThis.LANTERN_LEVELS, chapters: globalThis.LANTERN_CHAPTERS };
}

function movePos(m, t) {
  if (m.type === "circle") {
    const a = m.phase + m.speed * t;
    return [m.cx + m.r * Math.cos(a), m.cy + m.r * Math.sin(a)];
  }
  let u = m.phase + m.speed * t;
  u -= Math.floor(u);
  const s = u < 0.5 ? 2 * u : 2 - 2 * u;
  return [m.ax + (m.bx - m.ax) * s, m.ay + (m.by - m.ay) * s];
}
const period = (m) => (m.type === "circle" ? (2 * Math.PI) / Math.abs(m.speed) : 1 / Math.abs(m.speed));
const num = (v) => typeof v === "number" && Number.isFinite(v);
const EPS = 1e-6;

const LA = load();
const LB = load();
assert.deepStrictEqual(LA.chapters, LB.chapters, "chapters not deterministic");
const A = LA.levels, B = LB.levels, CH = LA.chapters;
assert.deepStrictEqual(A, B, "levels not deterministic");
assert.ok(Array.isArray(A), "LANTERN_LEVELS not an array");
assert.ok(A.length >= 25, "expected at least 25 levels");

let failures = 0;
const names = new Set();
A.forEach((L, li) => {
  const tag = `#${li + 1} ${L.name}`;
  try {
    assert.ok(typeof L.name === "string" && L.name.length > 0, "name");
    assert.ok(!names.has(L.name), "duplicate name");
    names.add(L.name);
    assert.ok(typeof L.hint === "string" && L.hint.length > 0, "hint");
    assert.ok(L.pegs.length >= 70 && L.pegs.length <= 120, `peg count ${L.pegs.length}`);

    const statics = [], movers = [];
    for (const p of L.pegs) {
      assert.ok(num(p.x) && num(p.y), "coords");
      assert.ok(p.shape === "round" || p.shape === "brick", "shape");
      if (p.shape === "brick") assert.ok(num(p.angle), "brick angle");
      const ext = p.shape === "brick" ? 14 : 9;
      const pts = [];
      if (p.move) {
        const m = p.move;
        assert.strictEqual(p.shape, "round", "moving pegs are round");
        if (m.type === "circle") ["cx", "cy", "r", "speed", "phase"].forEach((k) => assert.ok(num(m[k]), "circle." + k));
        else if (m.type === "line") {
          ["ax", "ay", "bx", "by", "speed", "phase"].forEach((k) => assert.ok(num(m[k]), "line." + k));
          assert.ok(m.phase >= 0 && m.phase <= 1, "line phase 0..1");
        } else assert.fail("move type");
        assert.ok(m.speed !== 0, "speed nonzero");
        const p0 = movePos(m, 0);
        assert.ok(Math.abs(p0[0] - p.x) < 0.02 && Math.abs(p0[1] - p.y) < 0.02, "static x,y equals t=0 position");
        const T = period(m);
        for (let i = 0; i < 200; i++) pts.push(movePos(m, (T * i) / 200));
        movers.push({ p, pts });
      } else {
        pts.push([p.x, p.y]);
        statics.push(p);
      }
      for (const [x, y] of pts) {
        assert.ok(x - ext >= 30 - EPS && x + ext <= 770 + EPS, `x bounds ${x}`);
        assert.ok(y - ext >= 110 - EPS && y <= 545 + EPS, `y bounds ${y}`);
        assert.ok(Math.hypot(x - 400, y - 36) >= 70, "launcher clear zone");
      }
    }
    // static spacing
    for (let i = 0; i < statics.length; i++)
      for (let j = i + 1; j < statics.length; j++) {
        const a = statics[i], b = statics[j];
        const need = a.shape === "brick" || b.shape === "brick" ? 30 : 22;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        assert.ok(d >= need - 0.02, `static spacing ${d.toFixed(1)} < ${need} at (${a.x},${a.y})-(${b.x},${b.y})`);
      }
    // moving vs static (path samples)
    for (const m of movers)
      for (const s of statics) {
        const need = s.shape === "brick" ? 30 : 22;
        for (const [x, y] of m.pts) assert.ok(Math.hypot(x - s.x, y - s.y) >= need - 0.02, `mover near static (${s.x},${s.y})`);
      }
    // moving vs moving: sample 200 steps over the longest period in the pair (simultaneous positions)
    for (let i = 0; i < movers.length; i++)
      for (let j = i + 1; j < movers.length; j++) {
        const a = movers[i].p.move, b = movers[j].p.move;
        const T = Math.max(period(a), period(b));
        for (let k = 0; k < 200; k++) {
          const t = (T * k) / 200, pa = movePos(a, t), pb = movePos(b, t);
          assert.ok(Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) >= 22 - 0.02, "movers collide");
        }
      }
    const nb = L.pegs.filter((p) => p.shape === "brick").length;
    const nm = movers.length;
    console.log(`ok  ${tag.padEnd(26)} pegs=${L.pegs.length} bricks=${nb} moving=${nm}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${tag}: ${e.message}`);
  }
});
// chapters
try {
  assert.ok(Array.isArray(CH) && CH.length === 5, "expected exactly 5 chapters");
  const used = new Set();
  CH.forEach((c, ci) => {
    assert.ok(typeof c.name === "string" && c.name.trim().length > 0, `chapter ${ci + 1} name`);
    assert.ok(typeof c.blurb === "string" && c.blurb.trim().length > 0, `chapter ${ci + 1} blurb`);
    assert.ok(Array.isArray(c.levels) && c.levels.length === 5, `chapter ${ci + 1} needs 5 levels`);
    for (const idx of c.levels) {
      assert.ok(Number.isInteger(idx) && idx >= 0 && idx < A.length, `chapter ${ci + 1} bad index ${idx}`);
      assert.ok(!used.has(idx), `level index ${idx} used twice`);
      used.add(idx);
      if (ci === 0) assert.ok(!A[idx].pegs.some((p) => p.move), `chapter 1 level ${idx} has moving pegs`);
    }
    console.log(`ok  chapter ${ci + 1} "${c.name}": ${c.levels.map((i) => A[i].name).join(", ")}`);
  });
} catch (e) {
  failures++;
  console.log(`FAIL chapters: ${e.message}`);
}
const movingLevels = A.filter((L) => L.pegs.some((p) => p.move)).length;
if (movingLevels < 4) { failures++; console.log(`FAIL only ${movingLevels} levels with moving pegs`); }
if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log("All level tests passed.");
