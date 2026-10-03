import { buildRequest, MAX_DATA_BYTES, parseServerEvent } from "../parse";
import { applyCtrl, arrow } from "../keys";
import { groupPanes, shortCwd } from "../panes";
import { parsePairingPayload } from "../pairing";
import { parseServerUrl, transportWarning } from "../url";

const pane = (o: Record<string, unknown>) => ({
  window_id: 0,
  tab_id: 0,
  pane_id: 1,
  workspace: "default",
  size: { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0, dpi: 96 },
  title: "pwsh",
  cwd: "",
  cursor_x: 0,
  cursor_y: 0,
  tab_title: "",
  window_title: "",
  is_active: true,
  is_zoomed: false,
  ...o,
});

describe("parseServerEvent", () => {
  it("le um list (mesmo formato de `cli list --format json`)", () => {
    const ev = parseServerEvent(JSON.stringify({ ev: "list", panes: [pane({ pane_id: 9 }), pane({ pane_id: 10, title: "vim" })] }));
    expect(ev?.ev).toBe("list");
    if (ev?.ev !== "list") return;
    expect(ev.panes.map((p) => p.pane_id)).toEqual([9, 10]);
    expect(ev.panes[1]!.title).toBe("vim");
    expect(ev.panes[0]!.size).toMatchObject({ cols: 80, rows: 24 });
  });

  it("descarta panes invalidos sem derrubar a lista", () => {
    const ev = parseServerEvent(JSON.stringify({ ev: "list", panes: [pane({ pane_id: 1 }), { pane_id: "x" }, null, pane({ pane_id: -1 })] }));
    expect(ev?.ev === "list" && ev.panes.map((p) => p.pane_id)).toEqual([1]);
  });

  it("le um screen com SGR, cursor, offset e scrollback", () => {
    const raw = {
      ev: "screen",
      pane_id: 9,
      cols: 96,
      rows: 27,
      cursor_x: 3,
      cursor_y: 26,
      cursor_visible: true,
      text: "\x1b[1;32mok\x1b[0m\r\nlinha 2",
      offset: 20,
      scrollback: 1094,
    };
    const ev = parseServerEvent(JSON.stringify(raw));
    expect(ev).toEqual(raw);
  });

  it("screen sem offset/scrollback (ponte antiga) vira 0", () => {
    const ev = parseServerEvent(JSON.stringify({ ev: "screen", pane_id: 1, cols: 80, rows: 24, cursor_x: 0, cursor_y: 0, cursor_visible: false, text: "" }));
    expect(ev?.ev === "screen" && [ev.offset, ev.scrollback]).toEqual([0, 0]);
  });

  it("limita o cursor ao grid e recusa grid absurdo", () => {
    const ev = parseServerEvent(JSON.stringify({ ev: "screen", pane_id: 1, cols: 10, rows: 5, cursor_x: 99, cursor_y: -3, cursor_visible: true, text: "" }));
    expect(ev?.ev === "screen" && [ev.cursor_x, ev.cursor_y]).toEqual([9, 0]);
    expect(parseServerEvent(JSON.stringify({ ev: "screen", pane_id: 1, cols: 0, rows: 5, text: "" }))).toBeNull();
    expect(parseServerEvent(JSON.stringify({ ev: "screen", pane_id: 1, cols: 10, rows: 5 }))).toBeNull();
  });

  it("le status e error; ignora lixo e eventos desconhecidos", () => {
    expect(parseServerEvent('{"ev":"status","state":"up","message":"ok","read_only":true}')).toEqual({
      ev: "status",
      state: "up",
      message: "ok",
      read_only: true,
      exe: undefined,
    });
    expect(parseServerEvent('{"ev":"error","message":"falhou"}')).toEqual({ ev: "error", message: "falhou" });
    expect(parseServerEvent("nao e json")).toBeNull();
    expect(parseServerEvent('{"ev":"settings","panes":{}}')).toBeNull();
    expect(parseServerEvent("[1,2]")).toBeNull();
  });
});

describe("buildRequest", () => {
  it("monta as operacoes do protocolo", () => {
    expect(JSON.parse(buildRequest({ op: "list" }))).toEqual({ op: "list" });
    expect(JSON.parse(buildRequest({ op: "watch", pane_ids: [10, 9, 9, -1] }))).toEqual({ op: "watch", pane_ids: [9, 10] });
    expect(JSON.parse(buildRequest({ op: "scroll", pane_id: 9, offset: 20.4 }))).toEqual({ op: "scroll", pane_id: 9, offset: 20 });
    expect(JSON.parse(buildRequest({ op: "scroll", pane_id: 9, offset: 5_000_000 }))).toEqual({ op: "scroll", pane_id: 9, offset: 1_000_000 });
    expect(JSON.parse(buildRequest({ op: "send", pane_id: 9, data: "ls\r" }))).toEqual({ op: "send", pane_id: 9, data: "ls\r" });
    expect(JSON.parse(buildRequest({ op: "paste", pane_id: 9, data: "a\nb" }))).toEqual({ op: "paste", pane_id: 9, data: "a\nb" });
  });

  it("watch no maximo 16 panes", () => {
    const ids = Array.from({ length: 20 }, (_, i) => i);
    expect(JSON.parse(buildRequest({ op: "watch", pane_ids: ids })).pane_ids).toHaveLength(16);
  });

  it("recusa pane invalido, texto vazio e texto grande demais", () => {
    expect(() => buildRequest({ op: "send", pane_id: -1, data: "x" })).toThrow();
    expect(() => buildRequest({ op: "send", pane_id: 1, data: "" })).toThrow();
    expect(() => buildRequest({ op: "paste", pane_id: 1, data: "a".repeat(MAX_DATA_BYTES + 1) })).toThrow(/grande/);
  });
});

describe("url", () => {
  it("normaliza para o endpoint WS e deriva o Origin", () => {
    expect(parseServerUrl("127.0.0.1:53123")).toMatchObject({ wsUrl: "ws://127.0.0.1:53123/ws", origin: "http://127.0.0.1:53123", secure: false });
    expect(parseServerUrl("http://127.0.0.1:53123/?t=segredo")).toMatchObject({ wsUrl: "ws://127.0.0.1:53123/ws" });
    expect(parseServerUrl("https://pc.tail1234.ts.net")).toMatchObject({ wsUrl: "wss://pc.tail1234.ts.net/ws", origin: "https://pc.tail1234.ts.net", secure: true });
    expect(parseServerUrl("wss://bt.exemplo.com.br:8443/bethstudio/ws")).toMatchObject({ wsUrl: "wss://bt.exemplo.com.br:8443/bethstudio/ws" });
  });

  it("recusa esquemas e credenciais na URL", () => {
    expect(() => parseServerUrl("ftp://x")).toThrow();
    expect(() => parseServerUrl("ws://user:senha@x:1/ws")).toThrow();
    expect(() => parseServerUrl("ws://x:99999")).toThrow();
    expect(() => parseServerUrl("  ")).toThrow();
  });

  it("avisa sobre ws:// fora do loopback", () => {
    expect(transportWarning(parseServerUrl("ws://127.0.0.1:1"))).toBeNull();
    expect(transportWarning(parseServerUrl("wss://8.8.8.8"))).toBeNull();
    expect(transportWarning(parseServerUrl("ws://192.168.0.3:8787"))).toMatch(/rede/);
    expect(transportWarning(parseServerUrl("ws://8.8.8.8:8787"))).toMatch(/público/);
  });
});

describe("pareamento por QR", () => {
  const token = "abcdefghijklmnopqrstuvwxyz012345";
  it("le o formato bethstudio://pair", () => {
    const url = encodeURIComponent("wss://pc.tail1234.ts.net/ws");
    const p = parsePairingPayload(`bethstudio://pair?v=1&url=${url}&token=${token}&name=PC%20do%20escrit%C3%B3rio`);
    expect(p).toEqual({ name: "PC do escritório", url: "wss://pc.tail1234.ts.net/ws", token, pin: null, readOnly: true });
  });

  it("le o formato JSON e so' desliga o somente leitura se pedido", () => {
    const p = parsePairingPayload(JSON.stringify({ bethstudio: 1, url: "ws://192.168.0.3:8787", token, ro: false }));
    expect(p).toMatchObject({ url: "ws://192.168.0.3:8787/ws", readOnly: false, name: "192.168.0.3" });
  });

  it("recusa QR de outra coisa, token curto e versao desconhecida", () => {
    expect(() => parsePairingPayload("https://exemplo.com")).toThrow(/não é do Beth Studio/);
    expect(() => parsePairingPayload(`bethstudio://pair?v=1&url=ws%3A%2F%2Fx%3A1&token=curto`)).toThrow(/token/);
    expect(() => parsePairingPayload(`bethstudio://pair?v=2&url=ws%3A%2F%2Fx%3A1&token=${token}`)).toThrow(/Versão/);
  });
});

describe("teclas", () => {
  it("aplica Ctrl ao primeiro caractere", () => {
    expect(applyCtrl("c")).toBe("\x03");
    expect(applyCtrl("C")).toBe("\x03");
    expect(applyCtrl("a")).toBe("\x01");
    expect(applyCtrl("[")).toBe("\x1b");
    expect(applyCtrl("dx")).toBe("\x04x");
    expect(applyCtrl("1")).toBe("1");
  });
  it("setas normais e com Ctrl", () => {
    expect(arrow("up")).toBe("\x1b[A");
    expect(arrow("left", true)).toBe("\x1b[1;5D");
  });
});

describe("agrupamento", () => {
  it("agrupa Janela -> Aba -> terminal com rotulos padrao", () => {
    const g = groupPanes([
      pane({ window_id: 1, tab_id: 5, pane_id: 7 }),
      pane({ window_id: 0, tab_id: 2, pane_id: 4, window_title: "Trabalho", tab_title: "WSL" }),
      pane({ window_id: 0, tab_id: 1, pane_id: 3 }),
      pane({ window_id: 0, tab_id: 1, pane_id: 2 }),
    ]);
    expect(g.map((w) => w.label)).toEqual(["Janela 1", "Janela 2"]);
    expect(g[0]!.tabs.map((t) => [t.label, t.panes.map((p) => p.pane_id)])).toEqual([
      ["Aba 1", [2, 3]],
      ["WSL", [4]],
    ]);
  });
  it("encurta cwd", () => {
    expect(shortCwd("file://PC/C:/Users/dev/projetos/bethstudio")).toBe("~\\projetos\\bethstudio");
    expect(shortCwd("file://ubuntu/home/dev/a/b/c/d")).toBe("\u2026/b/c/d");
  });
});
