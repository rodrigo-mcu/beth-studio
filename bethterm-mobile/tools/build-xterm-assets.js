// Gera src/terminal/xtermAssets.generated.ts com o xterm.js, o CSS e o addon
// unicode11 como strings. O WebView carrega tudo inline: nada de CDN, o app
// funciona sem internet e o conteudo nao muda sem um novo build.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const out = path.join(root, "src", "terminal", "xtermAssets.generated.ts");

function read(rel) {
  const p = path.join(root, "node_modules", rel);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8");
}

const js = read("@xterm/xterm/lib/xterm.js");
const css = read("@xterm/xterm/css/xterm.css");
const uni = read("@xterm/addon-unicode11/lib/addon-unicode11.js");

if (!js || !css || !uni) {
  // Primeira instalacao parcial: nao derruba o `npm install`.
  console.warn("[gen:xterm] @xterm/* ainda nao instalado; pulei a geracao.");
  process.exit(0);
}

// Tira o comentario de sourcemap (o .map nao vai junto).
const strip = (s) => s.replace(/\/\/# sourceMappingURL=.*$/gm, "");
const ver = (pkg) => JSON.parse(read(`${pkg}/package.json`)).version;

const body =
  "// ARQUIVO GERADO por tools/build-xterm-assets.js — nao editar.\n" +
  `// @xterm/xterm ${ver("@xterm/xterm")}, @xterm/addon-unicode11 ${ver("@xterm/addon-unicode11")}\n` +
  "/* eslint-disable */\n" +
  `export const XTERM_JS: string = ${JSON.stringify(strip(js))};\n` +
  `export const XTERM_CSS: string = ${JSON.stringify(css)};\n` +
  `export const UNICODE11_JS: string = ${JSON.stringify(strip(uni))};\n`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, body);
console.log(`[gen:xterm] ${path.relative(root, out)} (${Math.round(body.length / 1024)} KiB)`);
