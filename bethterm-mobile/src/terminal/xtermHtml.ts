import { XTERM_THEME } from "@/ui/theme";
import { UNICODE11_JS, XTERM_CSS, XTERM_JS } from "./xtermAssets.generated";

// Pagina do WebView: xterm.js inline (sem CDN). Mostra a imagem da tela que
// a ponte manda (grid cols x rows do host) e ajusta a FONTE para caber; o
// pane do host nunca e' redimensionado.
//
// RN -> pagina: window.bt.recv({t:"screen",ev} | {t:"config",readOnly} | {t:"focus"} | {t:"blur"})
// pagina -> RN: {t:"ready"} | {t:"data",data} | {t:"paste",data} | {t:"scroll",lines} | {t:"tap"}

const PAGE_JS = String.raw`
(function () {
  var RN = window.ReactNativeWebView;
  function post(m) { if (RN) RN.postMessage(JSON.stringify(m)); }
  var readOnly = true;
  var term = new window.Terminal({
    cols: 80, rows: 24, scrollback: 0,
    fontFamily: '"Cascadia Mono", Menlo, "SF Mono", "Roboto Mono", "DejaVu Sans Mono", monospace',
    fontSize: 14, lineHeight: 1, theme: window.__BT_THEME, cursorBlink: true,
    allowProposedApi: true, disableStdin: true
  });
  try {
    var U = window.Unicode11Addon;
    var Addon = U && (U.Unicode11Addon || U);
    term.loadAddon(new Addon());
    term.unicode.activeVersion = "11";
  } catch (e) {}
  var host = document.getElementById("t");
  var wrap = document.getElementById("wrap");
  term.open(host);

  // Teclado do sistema: o textarea escondido do xterm.
  var ta = host.querySelector("textarea");
  var lastInput = 0;
  function mark() { lastInput = Date.now(); }
  if (ta) {
    ["autocapitalize", "autocorrect", "autocomplete"].forEach(function (a) { ta.setAttribute(a, "off"); });
    ta.setAttribute("spellcheck", "false");
    ["keydown", "beforeinput", "input", "compositionend"].forEach(function (n) { ta.addEventListener(n, mark, true); });
    ta.addEventListener("paste", function (e) {
      e.preventDefault(); e.stopPropagation();
      var d = e.clipboardData && e.clipboardData.getData("text/plain");
      if (d && !readOnly) post({ t: "paste", data: d });
    }, true);
  }
  // So' repassa o que veio de uma tecla de verdade ha' pouco: respostas
  // automaticas do xterm nunca viram entrada no host.
  term.onData(function (d) {
    if (readOnly) return;
    if (Date.now() - lastInput > 1500) return;
    post({ t: "data", data: d });
  });

  // Ajusta a fonte para o grid caber na tela.
  var fs = 14, steps = 0, raf = 0;
  function step() {
    raf = 0;
    var s = host.querySelector(".xterm-screen");
    if (!s) return;
    var aw = window.innerWidth - 4, ah = window.innerHeight - 4;
    var sw = s.offsetWidth, sh = s.offsetHeight;
    if (!sw || !sh || aw <= 0 || ah <= 0) return;
    var next = Math.floor(fs * Math.min(aw / sw, ah / sh) * 4) / 4;
    // Garante que converge para dentro: se ainda passa da tela, reduz mais.
    if ((sw > aw || sh > ah) && next >= fs) next = fs - 0.25;
    next = Math.max(3, Math.min(28, next));
    if (next !== fs && steps++ < 12) {
      fs = next;
      term.options.fontSize = fs;
      raf = requestAnimationFrame(step);
    }
  }
  function fit() { steps = 0; if (!raf) raf = requestAnimationFrame(step); }
  window.addEventListener("resize", fit);
  fit();

  function screen(ev) {
    if (term.cols !== ev.cols || term.rows !== ev.rows) { term.resize(ev.cols, ev.rows); fit(); }
    // Autowrap (DECAWM) desligado + cada linha posicionada: se o xterm medir
    // um caractere mais largo que o host (emoji, simbolos), a linha nao
    // quebra nem empurra a tela (a ultima linha continua visivel).
    var rows = ev.text.split("\r\n");
    var out = "\x1b[?7l\x1b[0m\x1b[H\x1b[2J";
    for (var i = 0; i < rows.length && i < ev.rows; i++) out += "\x1b[" + (i + 1) + ";1H" + rows[i];
    term.write(out + "\x1b[0m\x1b[" + (ev.cursor_y + 1) + ";" + (ev.cursor_x + 1) + "H" +
      (ev.cursor_visible ? "\x1b[?25h" : "\x1b[?25l"));
  }

  function setReadOnly(v) {
    readOnly = !!v;
    term.options.disableStdin = readOnly;
    if (ta) { ta.readOnly = readOnly; ta.setAttribute("inputmode", readOnly ? "none" : "text"); }
    if (readOnly) { term.blur(); if (ta) ta.blur(); }
  }
  setReadOnly(true);

  // Toque: arrastar rola o historico (op scroll), tocar abre o teclado.
  function cellH() {
    var s = host.querySelector(".xterm-screen");
    return s && term.rows ? Math.max(4, s.offsetHeight / term.rows) : 16;
  }
  var ty = null, tx = 0, t0 = 0, moved = false, acc = 0;
  wrap.addEventListener("touchstart", function (e) {
    if (e.touches.length !== 1) { ty = null; return; }
    ty = e.touches[0].clientY; tx = e.touches[0].clientX; t0 = Date.now(); moved = false; acc = 0;
  }, { passive: true, capture: true });
  wrap.addEventListener("touchmove", function (e) {
    if (ty === null) return;
    var y = e.touches[0].clientY;
    if (!moved && Math.abs(y - ty) < 8 && Math.abs(e.touches[0].clientX - tx) < 8) return;
    moved = true;
    e.preventDefault(); e.stopPropagation();
    acc += y - ty; ty = y;
    var ch = cellH();
    var lines = acc > 0 ? Math.floor(acc / ch) : Math.ceil(acc / ch);
    if (lines) { acc -= lines * ch; post({ t: "scroll", lines: lines }); }
  }, { passive: false, capture: true });
  wrap.addEventListener("touchend", function (e) {
    if (ty !== null && moved) { e.preventDefault(); e.stopPropagation(); }
    else if (ty !== null && Date.now() - t0 < 400) { post({ t: "tap" }); if (!readOnly) term.focus(); }
    ty = null;
  }, { passive: false, capture: true });

  window.bt = {
    recv: function (m) {
      if (!m) return;
      if (m.t === "screen") screen(m.ev);
      else if (m.t === "config") setReadOnly(m.readOnly);
      else if (m.t === "focus") { if (!readOnly) term.focus(); }
      else if (m.t === "blur") { term.blur(); if (ta) ta.blur(); }
    }
  };
  post({ t: "ready" });
})();
`;

const safeScript = (s: string) => s.replace(/<\/script/gi, "<\\/script");

let cached: string | null = null;

export function terminalHtml(): string {
  if (cached) return cached;
  cached = `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:">
<style>${XTERM_CSS}
html,body{margin:0;padding:0;height:100%;overflow:hidden;background:${XTERM_THEME.background};}
#wrap{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;touch-action:none;overscroll-behavior:none;}
.xterm .xterm-viewport{overflow:hidden!important;}
</style></head>
<body><div id="wrap"><div id="t"></div></div>
<script>window.__BT_THEME=${JSON.stringify(XTERM_THEME)};</script>
<script>${safeScript(XTERM_JS)}</script>
<script>${safeScript(UNICODE11_JS)}</script>
<script>${safeScript(PAGE_JS)}</script>
</body></html>`;
  return cached;
}
