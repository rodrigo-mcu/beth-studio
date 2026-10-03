import { useEffect, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { ProtocolClient, type ClientSnapshot } from "@/protocol/client";
import { getConnection, getToken, onConnectionsChanged, type SavedConnection } from "@/storage/connections";

// Um ProtocolClient por conexao salva, compartilhado entre as telas
// "Terminais" e "Terminal". O socket fecha quando nenhuma tela usa a
// conexao (com uma folga) e quando o app vai para segundo plano.

interface Entry {
  client: ProtocolClient;
  conn: SavedConnection;
  users: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

const registry = new Map<string, Entry>();
const IDLE_CLOSE_MS = 15_000;

AppState.addEventListener("change", (state) => {
  for (const e of registry.values()) {
    if (state === "active") {
      if (e.users > 0) e.client.start();
    } else if (state === "background") {
      e.client.stop();
    }
  }
});

onConnectionsChanged(() => {
  // Somente leitura alterado na tela de conexoes vale na hora.
  void (async () => {
    for (const [id, e] of registry) {
      const c = await getConnection(id);
      if (!c) {
        e.client.stop();
        registry.delete(id);
      } else {
        e.conn = c;
        e.client.setReadOnly(c.readOnly);
      }
    }
  })();
});

async function acquire(connId: string): Promise<Entry> {
  let e = registry.get(connId);
  if (!e) {
    const conn = await getConnection(connId);
    if (!conn) throw new Error("Conexão não encontrada.");
    const token = await getToken(connId);
    if (!token) throw new Error("Token não encontrado neste aparelho. Edite a conexão e informe o token de novo.");
    e = registry.get(connId); // outra tela pode ter criado enquanto esperavamos
    if (!e) {
      e = { client: new ProtocolClient({ url: conn.url, token, readOnly: conn.readOnly }), conn, users: 0 };
      registry.set(connId, e);
    }
  }
  clearTimeout(e.idleTimer);
  e.users++;
  if (AppState.currentState !== "background") e.client.start();
  return e;
}

function release(connId: string) {
  const e = registry.get(connId);
  if (!e) return;
  e.users = Math.max(0, e.users - 1);
  if (e.users === 0) {
    e.idleTimer = setTimeout(() => {
      if (e.users === 0) e.client.stop();
    }, IDLE_CLOSE_MS);
  }
}

/** Descarta o cliente (ex.: URL ou token editados). */
export function dropClient(connId: string) {
  const e = registry.get(connId);
  if (!e) return;
  clearTimeout(e.idleTimer);
  e.client.stop();
  registry.delete(connId);
}

export interface UseClient {
  client: ProtocolClient | null;
  conn: SavedConnection | null;
  error: string | null;
}

export function useConnectionClient(connId: string | undefined): UseClient {
  const [state, setState] = useState<UseClient>({ client: null, conn: null, error: null });
  useEffect(() => {
    if (!connId) return;
    let alive = true;
    let acquired = false;
    acquire(connId).then(
      (e) => {
        acquired = true;
        if (alive) setState({ client: e.client, conn: e.conn, error: null });
        else release(connId);
      },
      (err: unknown) => alive && setState({ client: null, conn: null, error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      alive = false;
      if (acquired) release(connId);
    };
  }, [connId]);
  return state;
}

const EMPTY: ClientSnapshot = { socket: "idle", status: null, panes: null, lastError: null, listAt: 0, readOnly: true };
const noop = () => () => {};

export function useClientSnapshot(client: ProtocolClient | null): ClientSnapshot {
  return useSyncExternalStore(client ? client.subscribe : noop, client ? client.getSnapshot : () => EMPTY);
}
