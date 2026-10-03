/** Cliente HTTP minimo (cookie/token) para a janela SFTP sem WebSocket. */

import { apiBase } from "./remote";
import type { SshApiClient } from "./sshApi";

function tokenAndHost() {
  const q = new URLSearchParams(window.location.search);
  const token = q.get("t") ?? "";
  const api = q.get("api") ?? window.location.host + apiBase();
  return { token, api };
}

export function makeHttpClient(): SshApiClient {
  const { token, api } = tokenAndHost();
  return {
    async api<T>(path: string, body?: unknown): Promise<T> {
      const headers: Record<string, string> = {};
      if (token) headers["X-BethStudio-Token"] = token;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const r = await fetch(`${location.protocol}//${api}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers,
        credentials: "include",
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
      return data as T;
    },
    async upload<T>(
      path: string,
      body: Blob,
      contentType: string,
      opts?: { signal?: AbortSignal; headers?: Record<string, string> },
    ): Promise<T> {
      const headers: Record<string, string> = { ...(opts?.headers ?? {}), "Content-Type": contentType };
      if (token) headers["X-BethStudio-Token"] = token;
      const r = await fetch(`${location.protocol}//${api}${path}`, {
        method: "POST",
        headers,
        credentials: "include",
        body,
        signal: opts?.signal,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
      return data as T;
    },
  };
}
