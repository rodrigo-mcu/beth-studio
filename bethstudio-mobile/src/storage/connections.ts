import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

// Conexoes salvas. O que NAO e' segredo (nome, URL, somente leitura) fica no
// AsyncStorage; o token fica SO' no SecureStore (Keychain no iOS, Keystore
// no Android), preso a este aparelho e so' legivel com ele desbloqueado.

export interface SavedConnection {
  id: string;
  name: string;
  /** Endpoint WS normalizado (ws://... ou wss://...). */
  url: string;
  readOnly: boolean;
  /** Pin SHA-256 da chave publica do certificado (futuro, ver REMOTE_ACCESS.md). */
  pin: string | null;
  createdAt: number;
}

const LIST_KEY = "bethstudio.connections.v1";
const tokenKey = (id: string) => `bethstudio_token_${id}`;
const SECURE_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

type Listener = () => void;
const listeners = new Set<Listener>();
const notify = () => listeners.forEach((fn) => fn());

export function onConnectionsChanged(fn: Listener) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export async function listConnections(): Promise<SavedConnection[]> {
  const raw = await AsyncStorage.getItem(LIST_KEY);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter(
      (c): c is SavedConnection =>
        typeof c === "object" && c !== null && typeof c.id === "string" && typeof c.name === "string" && typeof c.url === "string",
    );
  } catch {
    return [];
  }
}

export async function getConnection(id: string): Promise<SavedConnection | null> {
  return (await listConnections()).find((c) => c.id === id) ?? null;
}

async function writeList(list: SavedConnection[]) {
  await AsyncStorage.setItem(LIST_KEY, JSON.stringify(list));
  notify();
}

export function newConnectionId(): string {
  return Crypto.randomUUID().replace(/-/g, "");
}

/** Cria ou atualiza. `token` null = manter o token ja' salvo. */
export async function saveConnection(conn: SavedConnection, token: string | null): Promise<void> {
  if (token !== null) await SecureStore.setItemAsync(tokenKey(conn.id), token, SECURE_OPTS);
  const list = await listConnections();
  const i = list.findIndex((c) => c.id === conn.id);
  if (i >= 0) list[i] = conn;
  else list.push(conn);
  await writeList(list);
}

export async function setConnectionReadOnly(id: string, readOnly: boolean): Promise<void> {
  const list = await listConnections();
  const c = list.find((x) => x.id === id);
  if (!c) return;
  c.readOnly = readOnly;
  await writeList(list);
}

export async function deleteConnection(id: string): Promise<void> {
  await SecureStore.deleteItemAsync(tokenKey(id), SECURE_OPTS);
  await writeList((await listConnections()).filter((c) => c.id !== id));
}

export async function getToken(id: string): Promise<string | null> {
  return SecureStore.getItemAsync(tokenKey(id), SECURE_OPTS);
}
