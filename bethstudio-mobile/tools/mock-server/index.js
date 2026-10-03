// Servidor WS FALSO que imita o protocolo do bethstudio-web (patch 0171) para
// desenvolver e testar o app sem tocar no host real.
//
//   node tools/mock-server/index.js [--port 8787] [--token <token>] [--host 127.0.0.1] [--read-only]
//
// Regras copiadas do bethstudio-web/server.go: token no header
// X-BethStudio-Token (ou ?t=), Origin obrigatorio no WS, send/paste recusados
// em --read-only, watch limitado a 16 panes, scroll 0..1000000.
// Nada aqui fala com o Beth Studio de verdade: os terminais sao inventados.

const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const TOKEN_HEADER = "x-bethstudio-token";
const COLS = 80;
const ROWS = 24;

function makePanes() {
  const defs = [
    { window_id: 0, tab_id: 0, pane_id: 1, title: "pwsh", cwd: "file://PC/C:/Users/dev/projetos/bethstudio", tab_title: "Beth Studio", window_title: "Trabalho" },
    { window_id: 0, tab_id: 0, pane_id: 2, title: "claude", cwd: "file://PC/C:/Users/dev/projetos/bethstudio/upstream-wezterm", tab_title: "Beth Studio", window_title: "Trabalho" },
    { window_id: 0, tab_id: 1, pane_id: 3, title: "htop", cwd: "file://ubuntu/home/dev", tab_title: "WSL", window_title: "Trabalho" },
    { window_id: 1, tab_id: 2, pane_id: 4, title: "", cwd: "file://PC/C:/src/repo", tab_title: "", window_title: "" },
  ];
  return defs.map((d, i) => {
    const history = [];
    for (let n = 1; n <= 200; n++) {
      history.push(`\x1b[2m${String(n).padStart(4, " ")}\x1b[0m linha antiga ${n} do pane ${d.pane_id} \x1b[3${(n % 6) + 1}mcor ${(n % 6) + 1}\x1b[0m`);
    }
    history.push(`\x1b[1;32mPS C:\\mock>\x1b[0m echo "pane ${d.pane_id}"`, `pane ${d.pane_id}`);
    return {
      info: {
        ...d,
        workspace: "default",
        size: { rows: ROWS, cols: COLS, pixel_width: 0, pixel_height: 0, dpi: 96 },
        cursor_x: 0,
        cursor_y: 0,
        is_active: i !== 1,
        is_zoomed: false,
      },
      lines: history,
      input: "",
      offset: 0,
    };
  });
}

const PROMPT = "\x1b[1;32mPS C:\\mock>\x1b[0m ";
const PROMPT_VISIBLE = "PS C:\\mock> ";

function screenOf(p) {
  const all = [...p.lines, PROMPT + p.input];
  const live = all.length > ROWS ? all.length - ROWS : 0;
  const scrollback = live;
  const offset = Math.min(p.offset, scrollback);
  const start = Math.max(0, live - offset);
  const view = all.slice(start, start + ROWS);
  const cursorRow = all.length - 1 - start;
  return {
    ev: "screen",
    pane_id: p.info.pane_id,
    cols: COLS,
    rows: ROWS,
    cursor_x: Math.min(COLS - 1, PROMPT_VISIBLE.length + p.input.length),
    cursor_y: Math.max(0, Math.min(ROWS - 1, cursorRow)),
    cursor_visible: offset === 0,
    text: view.join("\r\n"),
    offset,
    scrollback,
  };
}

/**
 * Cria e inicia o servidor. Devolve { port, url, token, close(), received, panes }.
 * `received` guarda cada requisicao aceita (para os testes conferirem).
 */
function createMockServer(opts = {}) {
  const token = opts.token || crypto.randomBytes(24).toString("base64url");
  const readOnly = !!opts.readOnly;
  const host = opts.host || "127.0.0.1";
  const panes = makePanes();
  const byId = new Map(panes.map((p) => [p.info.pane_id, p]));
  const received = [];
  const clients = new Set();

  const listJSON = () => JSON.stringify({ ev: "list", panes: panes.map((p) => p.info) });
  const sendTo = (c, obj) => {
    if (c.ws.readyState === 1) c.ws.send(typeof obj === "string" ? obj : JSON.stringify(obj));
  };
  const pushScreen = (p) => {
    const s = JSON.stringify(screenOf(p));
    for (const c of clients) if (c.watch.has(p.info.pane_id)) sendTo(c, s);
  };

  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok\n");
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 << 20 });

  const tokenOK = (req) => {
    const eq = (v) => {
      if (typeof v !== "string" || !v) return false;
      const a = Buffer.from(v);
      const b = Buffer.from(token);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    };
    const q = new URL(req.url, "http://x").searchParams.get("t");
    return eq(req.headers[TOKEN_HEADER]) || eq(q);
  };

  server.on("upgrade", (req, socket, head) => {
    const reject = (code, msg) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (new URL(req.url, "http://x").pathname !== "/ws") return reject(404, "Not Found");
    if (!tokenOK(req)) return reject(401, "Unauthorized");
    if (!req.headers.origin) return reject(403, "Forbidden");
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });

  wss.on("connection", (ws) => {
    const c = { ws, watch: new Set() };
    clients.add(c);
    sendTo(c, { ev: "status", state: "up", message: "mock", read_only: readOnly, exe: "mock" });
    sendTo(c, listJSON());
    ws.on("close", () => clients.delete(c));
    ws.on("message", (buf, isBinary) => {
      if (isBinary) return;
      let req;
      try {
        req = JSON.parse(buf.toString("utf8"));
      } catch {
        return sendTo(c, { ev: "error", message: "requisição inválida" });
      }
      handle(c, req);
    });
  });

  function handle(c, req) {
    const err = (message) => sendTo(c, { ev: "error", message });
    switch (req.op) {
      case "list":
        received.push({ op: "list" });
        return sendTo(c, listJSON());
      case "watch": {
        const ids = [];
        const add = (id) => {
          if (Number.isInteger(id) && id >= 0 && !ids.includes(id) && ids.length < 16) ids.push(id);
        };
        (Array.isArray(req.pane_ids) ? req.pane_ids : []).forEach(add);
        if (req.pane_id !== undefined) add(req.pane_id);
        received.push({ op: "watch", pane_ids: ids });
        const before = c.watch;
        c.watch = new Set(ids);
        for (const id of ids) if (!before.has(id) && byId.has(id)) sendTo(c, screenOf(byId.get(id)));
        return;
      }
      case "scroll": {
        const id = req.pane_id;
        const off = req.offset;
        if (!Number.isInteger(id) || id < 0 || !Number.isInteger(off) || off < 0 || off > 1_000_000) {
          return err("scroll: pane_id e offset (0..1000000) são obrigatórios");
        }
        received.push({ op: "scroll", pane_id: id, offset: off });
        const p = byId.get(id);
        if (!p) return;
        p.offset = off;
        return pushScreen(p);
      }
      case "send":
      case "paste": {
        if (readOnly) return err("modo somente leitura: entrada desabilitada");
        if (!Number.isInteger(req.pane_id) || req.pane_id < 0 || typeof req.data !== "string") return err("pane_id e data são obrigatórios");
        received.push({ op: req.op, pane_id: req.pane_id, data: req.data });
        const p = byId.get(req.pane_id);
        if (!p || !req.data) return;
        p.offset = 0;
        typeInto(p, req.data);
        return pushScreen(p);
      }
      default:
        return err("operação desconhecida: " + req.op);
    }
  }

  // Um "shell" de brinquedo: ecoa, Enter responde, Backspace apaga, Ctrl+C cancela.
  function typeInto(p, data) {
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        p.lines.push(PROMPT + p.input);
        if (p.input.trim()) p.lines.push(`mock: você digitou \x1b[1;36m${p.input}\x1b[0m`);
        p.input = "";
      } else if (ch === "\x7f" || ch === "\b") {
        p.input = p.input.slice(0, -1);
      } else if (ch === "\x03") {
        p.lines.push(PROMPT + p.input + "^C");
        p.input = "";
      } else if (ch >= " ") {
        p.input += ch;
      }
    }
  }

  // Relogio no pane 1 (mostra que a tela e' ao vivo).
  let ticker = null;
  if (opts.tick !== false) {
    ticker = setInterval(() => {
      const p = byId.get(1);
      p.lines.push(`\x1b[33m[${new Date().toLocaleTimeString("pt-BR")}]\x1b[0m tique do mock`);
      pushScreen(p);
    }, opts.tickMs || 2000);
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port || 0, host, () => {
      const port = server.address().port;
      resolve({
        port,
        token,
        url: `ws://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/ws`,
        received,
        panes,
        close: () =>
          new Promise((done) => {
            if (ticker) clearInterval(ticker);
            for (const c of clients) c.ws.terminate();
            wss.close();
            server.close(() => done());
          }),
      });
    });
  });
}

module.exports = { createMockServer, screenOf };

if (require.main === module) {
  const args = process.argv.slice(2);
  const val = (name, d) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : d;
  };
  const host = val("--host", "127.0.0.1");
  createMockServer({
    port: Number(val("--port", "8787")),
    token: val("--token", undefined),
    host,
    readOnly: args.includes("--read-only"),
  }).then((s) => {
    const shown = host === "0.0.0.0" ? "<IP-do-PC>" : host;
    const url = `ws://${shown}:${s.port}/ws`;
    console.log(`mock bethstudio-web em ${url}${args.includes("--read-only") ? " (somente leitura)" : ""}`);
    console.log(`token: ${s.token}`);
    console.log(`QR/pareamento: bethstudio://pair?v=1&url=${encodeURIComponent(url)}&token=${encodeURIComponent(s.token)}&name=Mock&ro=0`);
    if (host !== "127.0.0.1") console.log("AVISO: escutando fora do loopback (dados falsos, sem TLS). Só para desenvolvimento.");
  });
}
