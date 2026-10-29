// Headless browser smoke test: loads the built index.html and plays every level.
// Run: npm run build && node test/smoke.test.js
// Needs Playwright's Chromium (`npx playwright install chromium`).
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const PAGE = 'file://' + path.join(__dirname, '..', 'index.html');
const SHOTS_PER_LEVEL = 25;

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  let failed = false;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => {
      // Google Fonts can't load in some CI sandboxes; that isn't a game error.
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
    });
    // Generous rules so levels finish quickly and every power gets exercised.
    await page.addInitScript(() => {
      localStorage.setItem('ld.settings', JSON.stringify({ infinite: true, greens: 12, strength: 2, guide: 'full' }));
    });
    await page.goto(PAGE);
    await page.waitForFunction(() => window.__LD && window.LANTERN_LEVELS);

    // Title screen renders and menus open.
    assert.strictEqual(await page.title(), 'Lantern Drop');
    await page.click('#btnSettings');
    assert.ok(await page.locator('#settingsBody .pw').count() >= 11, 'all powers listed in settings');
    await page.click('#settings .panel-head [data-back]');

    const levelCount = await page.evaluate(() => window.LANTERN_LEVELS.length);
    assert.ok(levelCount >= 14, `expected at least 14 levels, got ${levelCount}`);

    let cleared = 0, finales = 0;
    for (let lvl = 0; lvl < levelCount; lvl++) {
      const r = await page.evaluate(({ lvl, maxShots }) => {
        const D = window.__LD;
        D.startLevel(lvl);
        let shots = 0, fever = false, lit = 0;
        for (let i = 0; i < 40000; i++) {
          if (D.G.state === 'aim') {
            if (shots >= maxShots) break;
            if (D.G.banner) D.G.banner.t += 10;
            D.setAim(0.15 + Math.random() * (Math.PI - 0.3));
            D.fire();
            shots++;
          }
          D.update(1 / 20);
          if (D.G.fever) fever = true;
          if (D.G.state === 'done') break;
        }
        lit = D.L.pegs.filter(p => p.removed || p.hit).length;
        return { shots, fever, state: D.G.state, score: D.G.score, lit, name: D.L.name };
      }, { lvl, maxShots: SHOTS_PER_LEVEL });
      assert.ok(r.lit > 0, `level ${lvl + 1} (${r.name}): no lanterns lit`);
      assert.ok(r.score > 0, `level ${lvl + 1} (${r.name}): no score`);
      if (r.state === 'done') cleared++;
      if (r.fever) finales++;
      console.log(`  ok  level ${String(lvl + 1).padStart(2)} ${r.name.padEnd(22)} shots ${String(r.shots).padStart(2)}  score ${r.score}${r.state === 'done' ? '  cleared' : ''}`);
    }
    assert.ok(cleared > 0, 'at least one level should be cleared');
    assert.ok(finales > 0, 'at least one Grand Finale should trigger');
    assert.deepStrictEqual(errors, [], 'page errors:\n' + errors.join('\n'));
    console.log(`PASSED (${levelCount} levels played, ${cleared} cleared)`);
  } catch (e) {
    failed = true;
    console.error(e.message);
    if (errors.length) console.error('page errors:\n' + errors.join('\n'));
  } finally {
    await browser.close();
  }
  process.exit(failed ? 1 : 0);
})();
