# Lantern Drop

An original peg-shooting game set at a night lantern festival by a river. Fire a moonstone from the launcher, light every amber lantern, and catch the stone in the drifting boat for a free ball.

Everything runs in the browser from one HTML file: the art is drawn on a canvas and the music and sound effects are synthesized live with the Web Audio API. There are no image or audio files and no dependencies.

**Play:** https://oldstarchy.github.io/lantern-drop/

## Lanterns

| Lantern | What it does |
|---|---|
| Amber | Targets. Light them all to clear the level. |
| Blue | 10 points. |
| Jade | Triggers a power from the enabled pool. |
| Violet | 500 points. Moves to a new lantern every turn. |

Lighting more amber raises the multiplier (×2 at 40%, ×3 at 60%, ×5 at 76%, ×10 at 88%). Lighting the last one starts the Grand Finale, where the stone drops into one of five prize lanterns.

## Powers

| Power | Type | Effect |
|---|---|---|
| Destiny Shot | Next shot | Searches nearby angles and fires the one that lights the most lanterns. |
| Long Sight | Next 3 shots | Shows the full bouncing path. |
| Twin Moons | Immediate | Splits off a second ball. |
| Firework | Immediate | Lights every lantern in a radius. |
| Chain Spark | Immediate | Arcs to the five closest unlit lanterns, amber first. |
| Ember Stone | Next shot | Burns through lanterns without bouncing. |
| Moth Light | Next 2 shots | Curves toward the closest amber lantern. |
| Feather Fall | Next 2 shots | Lower gravity. |
| Wide Boat | Next 3 turns | Doubles the boat's width. |
| Moon Bridge | Immediate | The river bounces the ball back up once. |
| Second Wind | Immediate | A ball that falls out drops back in from the top once. |

## Rules & powers menu

Everything is adjustable from the title screen and saved in the browser:

- Infinite balls, starting balls (3–30), free balls from big shots
- Amber target count (5–50), jade power lantern count (0–20), violet lantern on/off
- Which powers are in the pool, power strength (×1–×3), a power to start each level with
- Aim guide length, boat speed and size, gravity, game speed
- Always-on Destiny, Ember or Moon Bridge
- Music and effects volume

## Controls

| Input | Aim | Fire | Fast-forward | Pause |
|---|---|---|---|---|
| Controller | Left stick; right stick, bumpers or D-pad to fine-tune | A | Hold Y | Menu or B |
| Keyboard | ← → (Shift to fine-tune) | Space or Enter | Hold F | Esc or P |
| Mouse | Point | Left click | Hold right button | Pause button |
| Touch | Drag | Lift finger (lift above the launcher to cancel) | Hold during a shot | Pause button |

Controllers work through the Gamepad API, including Edge on Xbox.

## Project layout

```
src/shell.html   page markup and styles
src/game.js      engine: physics, powers, rendering, input, menus
src/levels.js    14 level layouts, generated deterministically
src/audio.js     synthesized sound effects and three music tracks
test/            Node tests for levels and audio
build.js         inlines everything into index.html
```

## Development

Requires Node 18 or later.

```sh
npm ci                          # installs Playwright (dev only)
npm test                        # level geometry checks and audio API checks
npm run build                   # regenerates index.html and dist/lantern-drop.html
npx playwright install chromium # once, for the smoke test
npm run test:smoke              # plays every level headlessly in Chromium
npm run test:all                # all of the above
```

Edit files in `src/`, then rebuild and commit `index.html` along with your changes.

### CI and deployment

`.github/workflows/ci.yml` runs on every push and pull request. It runs the unit tests, rebuilds the game, fails if the committed `index.html` doesn't match the build, and runs the browser smoke test. Pushes to `main` then deploy to GitHub Pages. The repo's Pages source must be set to **GitHub Actions**.

### Level format

`src/levels.js` sets `window.LANTERN_LEVELS` to an array of `{ name, hint, pegs }`. The board is 800 × 620 with the launcher at (400, 36). A peg is `{ x, y, shape: "round" }` or `{ x, y, shape: "brick", angle }`, with an optional `move` of type `circle` or `line`. The game assigns lantern colours when a level starts.
