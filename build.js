// Builds the game into self-contained pages.
//   index.html               full HTML document for GitHub Pages (or any static host)
//   dist/lantern-drop.html   body-only page for publishing as a Claude artifact
// Usage: node build.js
const fs = require('fs');
const path = require('path');

const src = f => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');
const esc = s => s.replace(/<\/script/gi, '<\\/script');

const shell = src('shell.html');
const scripts = ['levels.js', 'audio.js', 'game.js']
  .map(f => `<script>\n${esc(src(f))}\n</script>`)
  .join('\n');

// Artifact page: the host wraps it in its own document skeleton.
const artifact = `${shell}\n${scripts}\n`;
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'lantern-drop.html'), artifact);

// Standalone page: split the shell into head material and body markup.
const split = shell.indexOf('<div id="stage">');
if (split < 0) throw new Error('shell.html must contain <div id="stage">');
const head = shell.slice(0, split).trim();
const body = shell.slice(split).trim();
const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Lantern Drop: an original peg-shooting game set at a night lantern festival.">
${head}
</head>
<body>
${body}
${scripts}
</body>
</html>
`;
fs.writeFileSync(path.join(__dirname, 'index.html'), page);

console.log(`built index.html (${(page.length / 1024).toFixed(1)} KB) and dist/lantern-drop.html`);
