/**
 * @jest-environment node
 */
// Teste de ponta a ponta sem GUI: ProtocolClient (codigo do app) contra o
// servidor falso em tools/mock-server, por um WebSocket de verdade.
import WebSocket from "ws";
import { ProtocolClient, type WebSocketLike } from "../client";
import type { ScreenEvent } from "../types";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createMockServer } = require("../../../tools/mock-server/index.js") as {
  createMockServer: (o: { token?: string; readOnly?: boolean; tick?: boolean }) => Promise<{
    port: number;
    token: string;
    url: string;
    received: { op: string; pane_id?: number; data?: string; offset?: number }[];
    close: () => Promise<void>;
  }>;
};

type Mock = Awaited<ReturnType<typeof createMockServer>>;

const nodeFactory = (url: string, headers: Record<string, string>) =>
  new WebSocket(url, { headers }) as unknown as WebSocketLike;

function waitFor<T>(fn: () => T | null | undefined | false, ms = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error("tempo esgotado"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function nextScreen(client: ProtocolClient, paneId: number, pred: (s: ScreenEvent) => boolean): Promise<ScreenEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("screen não chegou"));
    }, 3000);
    const off = client.onScreen(paneId, (s) => {
      if (!pred(s)) return;
      clearTimeout(timer);
      off();
      resolve(s);
    });
  });
}

describe("mock server + ProtocolClient", () => {
  let mock: Mock;
  const clients: ProtocolClient[] = [];
  const make = (readOnly: boolean, token = mock.token) => {
    const c = new ProtocolClient({ url: mock.url, token, readOnly, factory: nodeFactory, reconnect: false });
    clients.push(c);
    c.start();
    return c;
  };

  beforeAll(async () => {
    mock = await createMockServer({ tick: false });
  });
  afterEach(() => {
    clients.splice(0).forEach((c) => c.stop());
  });
  afterAll(async () => {
    await mock.close();
  });

  it("recusa token errado", async () => {
    const c = make(true, "token-errado-0123456789");
    await waitFor(() => c.getSnapshot().socket === "closed");
    expect(c.getSnapshot().panes).toBeNull();
    expect(c.getSnapshot().lastError).toBe("O servidor recusou o token.");
  });

  it("lista, observa, rola e volta ao fim", async () => {
    const c = make(true);
    const panes = await waitFor(() => c.getSnapshot().panes);
    expect(panes.map((p) => p.pane_id)).toEqual([1, 2, 3, 4]);
    expect(c.getSnapshot().status?.state).toBe("up");

    const first = nextScreen(c, 2, () => true);
    c.setWatched([2]);
    const s = await first;
    expect([s.cols, s.rows, s.offset]).toEqual([80, 24, 0]);
    expect(s.scrollback).toBeGreaterThan(100);
    expect(s.text.split("\r\n")).toHaveLength(24);
    expect(s.text).toContain("\x1b[");

    const up = nextScreen(c, 2, (x) => x.offset === 20);
    c.scroll(2, 20);
    const u = await up;
    expect(u.cursor_visible).toBe(false);

    const clamped = nextScreen(c, 2, (x) => x.offset === x.scrollback && x.offset > 0);
    c.scroll(2, 999_999);
    await clamped;

    const live = nextScreen(c, 2, (x) => x.offset === 0);
    c.scroll(2, 0);
    await live;
  });

  it("somente leitura: nada de send/paste chega ao servidor", async () => {
    const before = mock.received.filter((r) => r.op === "send" || r.op === "paste").length;
    const c = make(true);
    await waitFor(() => c.getSnapshot().socket === "open");
    c.setWatched([1]);
    expect(c.send(1, "echo perigo\r")).toBe(false);
    expect(c.paste(1, "colado")).toBe(false);
    c.refreshList();
    await new Promise((r) => setTimeout(r, 150));
    expect(mock.received.filter((r) => r.op === "send" || r.op === "paste").length).toBe(before);
  });

  it("com escrita: send ecoa na tela do pane", async () => {
    const c = make(false);
    await waitFor(() => c.getSnapshot().socket === "open");
    c.setWatched([4]);
    await nextScreen(c, 4, () => true);
    const echoed = nextScreen(c, 4, (x) => x.text.includes("você digitou"));
    expect(c.send(4, "ola\r")).toBe(true);
    const s = await echoed;
    expect(s.text).toContain("ola");
    expect(mock.received).toContainEqual({ op: "send", pane_id: 4, data: "ola\r" });
  });
});

describe("mock server em --read-only", () => {
  it("o servidor tambem recusa send (defesa em profundidade)", async () => {
    const mock = await createMockServer({ tick: false, readOnly: true });
    const c = new ProtocolClient({ url: mock.url, token: mock.token, readOnly: false, factory: nodeFactory, reconnect: false });
    try {
      c.start();
      await waitFor(() => c.getSnapshot().status);
      expect(c.isReadOnly).toBe(true);
      expect(c.send(1, "x")).toBe(false);
    } finally {
      c.stop();
      await mock.close();
    }
  });
});
