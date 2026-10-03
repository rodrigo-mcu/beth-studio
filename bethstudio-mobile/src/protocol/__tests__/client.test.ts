import { ProtocolClient, TOKEN_HEADER, type WebSocketLike } from "../client";

// WebSocket falso: guarda o que o cliente enviaria ao servidor.
class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  ops() {
    return this.sent.map((s) => JSON.parse(s) as { op: string });
  }
}

function setup(readOnly: boolean) {
  const sockets: FakeSocket[] = [];
  const client = new ProtocolClient({
    url: "http://127.0.0.1:53123/?t=nao-deve-ir",
    token: "tok-0123456789abcdef",
    readOnly,
    reconnect: false,
    factory: (url, headers) => {
      const s = new FakeSocket(url, headers);
      sockets.push(s);
      return s;
    },
  });
  client.start();
  const ws = sockets[0]!;
  ws.open();
  return { client, ws, sockets };
}

const screen = (pane_id: number, extra: Record<string, unknown> = {}) => ({
  ev: "screen",
  pane_id,
  cols: 80,
  rows: 24,
  cursor_x: 0,
  cursor_y: 0,
  cursor_visible: true,
  text: "oi",
  offset: 0,
  scrollback: 10,
  ...extra,
});

describe("ProtocolClient", () => {
  it("token no header, Origin derivado, nada de token na URL", () => {
    const { ws } = setup(true);
    expect(ws.url).toBe("ws://127.0.0.1:53123/ws");
    expect(ws.headers[TOKEN_HEADER]).toBe("tok-0123456789abcdef");
    expect(ws.headers.Origin).toBe("http://127.0.0.1:53123");
  });

  it("pede a lista ao abrir e guarda os panes", () => {
    const { client, ws } = setup(true);
    expect(ws.ops()).toEqual([{ op: "list" }]);
    ws.receive({ ev: "list", panes: [{ pane_id: 9, window_id: 0, tab_id: 0, size: { cols: 80, rows: 24 } }] });
    expect(client.getSnapshot().panes?.map((p) => p.pane_id)).toEqual([9]);
    expect(client.getSnapshot().socket).toBe("open");
  });

  it("entrega screen so' para panes observados e repete o ultimo ao assinar", () => {
    const { client, ws } = setup(true);
    const got: number[] = [];
    client.onScreen(9, (s) => got.push(s.pane_id));
    ws.receive(screen(9)); // nao observado ainda
    expect(got).toEqual([]);
    client.setWatched([9]);
    expect(ws.ops().at(-1)).toEqual({ op: "watch", pane_ids: [9] });
    ws.receive(screen(9, { text: "a" }));
    expect(got).toEqual([9]);
    const late: string[] = [];
    client.onScreen(9, (s) => late.push(s.text));
    expect(late).toEqual(["a"]);
  });

  it("SOMENTE LEITURA: send/paste nunca saem do app; scroll sai", () => {
    const { client, ws } = setup(true);
    client.setWatched([9]);
    const before = ws.sent.length;
    expect(client.send(9, "rm -rf /\r")).toBe(false);
    expect(client.paste(9, "texto")).toBe(false);
    expect(ws.sent.length).toBe(before);
    expect(ws.sent.join("")).not.toMatch(/"op":"(send|paste)"/);
    expect(client.scroll(9, 20)).toBe(true);
    expect(ws.ops().at(-1)).toEqual({ op: "scroll", pane_id: 9, offset: 20 });
  });

  it("com escrita liberada envia send e paste", () => {
    const { client, ws } = setup(false);
    expect(client.send(9, "ls\r")).toBe(true);
    expect(client.paste(9, "a\nb")).toBe(true);
    expect(ws.ops().slice(-2)).toEqual([
      { op: "send", pane_id: 9, data: "ls\r" },
      { op: "paste", pane_id: 9, data: "a\nb" },
    ]);
  });

  it("servidor em somente leitura bloqueia mesmo com escrita liberada no app", () => {
    const { client, ws } = setup(false);
    ws.receive({ ev: "status", state: "up", message: "", read_only: true });
    expect(client.isReadOnly).toBe(true);
    expect(client.send(9, "x")).toBe(false);
    expect(ws.sent.join("")).not.toMatch(/"op":"send"/);
  });

  it("alternar somente leitura em tempo de execucao", () => {
    const { client, ws } = setup(false);
    client.setReadOnly(true);
    expect(client.send(9, "x")).toBe(false);
    client.setReadOnly(false);
    expect(client.send(9, "x")).toBe(true);
    expect(ws.ops().filter((o) => o.op === "send")).toHaveLength(1);
  });

  it("guarda o erro do servidor", () => {
    const { client, ws } = setup(true);
    ws.receive({ ev: "error", message: "modo somente leitura: entrada desabilitada" });
    expect(client.getSnapshot().lastError).toMatch(/somente leitura/);
  });

  it("ao reconectar reenvia list, watch e scroll pendente", () => {
    const sockets: FakeSocket[] = [];
    const client = new ProtocolClient({
      url: "ws://127.0.0.1:1/ws",
      token: "tok-0123456789abcdef",
      readOnly: true,
      factory: (u, h) => {
        const s = new FakeSocket(u, h);
        sockets.push(s);
        return s;
      },
    });
    jest.useFakeTimers();
    try {
      client.start();
      sockets[0]!.open();
      client.setWatched([3, 1]);
      client.scroll(3, 40);
      sockets[0]!.readyState = 3;
      sockets[0]!.onclose?.({});
      expect(client.getSnapshot().socket).toBe("closed");
      jest.advanceTimersByTime(600);
      expect(sockets).toHaveLength(2);
      sockets[1]!.open();
      expect(sockets[1]!.ops()).toEqual([{ op: "list" }, { op: "watch", pane_ids: [1, 3] }, { op: "scroll", pane_id: 3, offset: 40 }]);
      client.stop();
      expect(sockets[1]!.closed).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
