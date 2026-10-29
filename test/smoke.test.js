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
        return { shots, fever, state: D.G.state, score: D.G.players[0].score, lit, name: D.L.name };
      }, { lvl, maxShots: SHOTS_PER_LEVEL });
      assert.ok(r.lit > 0, `level ${lvl + 1} (${r.name}): no lanterns lit`);
      assert.ok(r.score > 0, `level ${lvl + 1} (${r.name}): no score`);
      if (r.state === 'done') cleared++;
      if (r.fever) finales++;
      console.log(`  ok  level ${String(lvl + 1).padStart(2)} ${r.name.padEnd(22)} shots ${String(r.shots).padStart(2)}  score ${r.score}${r.state === 'done' ? '  cleared' : ''}`);
    }
    assert.ok(cleared > 0, 'at least one level should be cleared');
    assert.ok(finales > 0, 'at least one Grand Finale should trigger');

    // Destiny: thinking state, then a launch with a "% destiny discovered" text.
    const destiny = await page.evaluate(() => {
      const D = window.__LD; D.startLevel(0, { mode: 'free' }); D.G.banner = null;
      D.G.players[0].charges.destiny = 1; D.setAim(1.1); D.fire();
      const thinking = D.G.state === 'destiny';
      for (let i = 0; i < 60 && D.G.state === 'destiny'; i++) D.update(1 / 20);
      const text = D.G.texts.find(t => t.destiny);
      return { thinking, after: D.G.state, text: text && text.s, charges: D.G.players[0].charges.destiny };
    });
    assert.ok(destiny.thinking, 'Destiny should enter its thinking state');
    assert.strictEqual(destiny.after, 'fly', 'Destiny should launch after thinking');
    assert.ok(/destiny discovered|Aim already true/.test(destiny.text || ''), 'Destiny text shown: ' + destiny.text);
    assert.strictEqual(destiny.charges, 0, 'Destiny charge consumed');
    console.log(`  ok  destiny: "${destiny.text}"`);

    // Campaign: map, power pick, classic rules, stars recorded on a win.
    await page.evaluate(() => { localStorage.removeItem('ld.progress'); });
    await page.reload();
    await page.waitForFunction(() => window.__LD);
    await page.click('#btnCampaign');
    assert.ok(await page.locator('#chapterList .chapter').count() === 5, 'five chapters listed');
    assert.ok(await page.locator('#slot-0-1').isDisabled(), 'second level locked at the start');
    await page.click('#slot-0-0');
    assert.ok(await page.locator('#ppGrid .pw:not([disabled])').count() === 3, 'three powers unlocked at the start');
    await page.click('#pp-foresight');
    await page.click('#ppStart');
    const camp = await page.evaluate(() => {
      const D = window.__LD; const R = D.R();
      const info = { balls: D.G.players[0].balls, pool: R.pool.join(','), infinite: R.infinite };
      // force a quick win: light every amber but one, then let shots finish the level
      D.L.pegs.filter(p => p.type === 'orange').slice(1).forEach(p => { p.hit = true; p.removed = true; });
      for (let i = 0; i < 60000; i++) {
        if (D.G.state === 'aim') { if (D.G.banner) D.G.banner.t += 10; D.setAim(0.15 + Math.random() * (Math.PI - 0.3)); D.fire(); }
        D.update(1 / 20); if (D.G.state === 'done') break;
      }
      return info;
    });
    assert.strictEqual(camp.pool, 'foresight', 'campaign uses the chosen power');
    assert.strictEqual(camp.balls, 10, 'campaign uses classic ball count');
    assert.strictEqual(camp.infinite, false, 'campaign ignores infinite balls');
    await page.waitForSelector('#result:not([hidden])', { timeout: 5000 });
    const stars = await page.evaluate(() => JSON.parse(localStorage.getItem('ld.progress')).camp.stars);
    assert.ok(Object.values(stars).some(n => n >= 1), 'campaign win records stars');
    console.log(`  ok  campaign: win recorded with ${Object.values(stars)[0]} star(s)`);

    // Hot-seat: turns rotate between players and the match ends with a ranking.
    const vs = await page.evaluate(() => {
      const D = window.__LD; const S = D.S(); S.infinite = false; S.balls = 5;
      D.startLevel(1, { mode: 'versus', players: ['A', 'B', 'C'] });
      const turns = [];
      for (let i = 0; i < 80000; i++) {
        if (D.G.state === 'aim') { if (D.G.banner) D.G.banner.t += 10; if (turns.length < 6) turns.push(D.G.cur); D.setAim(0.15 + Math.random() * (Math.PI - 0.3)); D.fire(); }
        D.update(1 / 20); if (D.G.state === 'done') break;
      }
      return { turns, state: D.G.state, players: D.G.players.length };
    });
    assert.deepStrictEqual(vs.turns, [0, 1, 2, 0, 1, 2], 'turns rotate A, B, C');
    assert.strictEqual(vs.state, 'done', 'match finishes');
    await page.waitForSelector('#resRanking:not([hidden]) li', { timeout: 5000 });
    assert.strictEqual(await page.locator('#resRanking li').count(), 3, 'ranking lists every player');
    console.log('  ok  hot-seat: turns rotate and the match ends with a ranking');
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
