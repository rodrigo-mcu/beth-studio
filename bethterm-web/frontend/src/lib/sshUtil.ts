// Funcoes puras das telas SSH/Serial (testadas em tests/sshUtil.test.ts).

import type { SerialProfile, SshHost, SshRecent } from "./sshApi.ts";

export const NO_GROUP = "Sem grupo";

/** Busca por nome, endereco, usuario, grupo, etiqueta e notas (todas as palavras). */
export function matchesHost(h: SshHost, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [h.name, h.host, h.user, `${h.user}@${h.host}`, h.group ?? "", h.tag ?? "", h.notes ?? "", String(h.port)]
    .join(" ")
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function matchesProfile(p: SerialProfile, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [p.name, p.port, p.group ?? "", p.notes ?? "", String(p.baud)].join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Agrupa por `group` (ordem alfabetica; "Sem grupo" no fim). */
export function groupBy<T extends { group?: string; name: string }>(items: T[]): { group: string; items: T[] }[] {
  const map = new Map<string, T[]>();
  for (const it of items) {
    const g = it.group?.trim() || NO_GROUP;
    const list = map.get(g) ?? [];
    list.push(it);
    map.set(g, list);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a === NO_GROUP ? 1 : b === NO_GROUP ? -1 : a.localeCompare(b, "pt-BR")))
    .map(([group, list]) => ({ group, items: list.sort((x, y) => x.name.localeCompare(y.name, "pt-BR")) }));
}

/** Recentes que ainda existem, na ordem gravada. */
export function recentItems<T extends { id: string }>(recent: SshRecent[], items: T[], max = 6): T[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out: T[] = [];
  for (const r of recent) {
    const it = byId.get(r.id);
    if (it && out.length < max) out.push(it);
  }
  return out;
}

/** "user@host" ou "user@host:porta" (porta 22 omitida). */
export function hostTarget(h: Pick<SshHost, "user" | "host" | "port">): string {
  const host = h.host.includes(":") ? `[${h.host}]` : h.host;
  return `${h.user}@${host}${h.port && h.port !== 22 ? `:${h.port}` : ""}`;
}

/** Junta pasta remota (POSIX) e nome. */
export function joinRemote(dir: string, name: string): string {
  if (!dir || dir === ".") return name;
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

/** Nome valido para criar/renomear no servidor (sem barra, sem "." / ".."). */
export function validRemoteName(n: string): string | null {
  const t = n.trim();
  if (!t) return "Informe um nome.";
  if (t === "." || t === "..") return "Nome inválido.";
  if (t.includes("/")) return "O nome não pode ter “/”.";
  if (t.length > 255) return "Nome longo demais.";
  return null;
}

/** Migalhas de pao de um caminho absoluto: [{label, path}]. */
export function breadcrumbs(path: string): { label: string; path: string }[] {
  if (!path) return [];
  if (!path.startsWith("/")) return [{ label: path, path }];
  const parts = path.split("/").filter(Boolean);
  const out = [{ label: "/", path: "/" }];
  let acc = "";
  for (const p of parts) {
    acc += `/${p}`;
    out.push({ label: p, path: acc });
  }
  return out;
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString("pt-BR", { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}

export function formatTime(unix: number): string {
  if (!unix) return "";
  return new Date(unix * 1000).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

/** Validacao do formulario de host antes de mandar (o Go valida de novo). */
export function hostFormError(h: Partial<SshHost>): string | null {
  const host = (h.host ?? "").trim();
  if (!host) return "Informe o endereço (host ou IP).";
  if (/[\s@]/.test(host)) return "Endereço inválido: use só o nome ou IP (usuário e porta vão nos campos próprios).";
  if (!(h.user ?? "").trim()) return "Informe o usuário.";
  const port = Number(h.port ?? 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "Porta inválida (1–65535).";
  if (h.auth === "key" && !(h.key_path ?? "").trim()) return "Informe o arquivo da chave privada.";
  return null;
}

export const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000, 1500000, 2000000, 3000000];

/** "115200 8N1" */
export function serialShort(p: Pick<SerialProfile, "baud" | "data_bits" | "parity" | "stop_bits">): string {
  const par = { none: "N", odd: "O", even: "E", mark: "M", space: "S" }[p.parity] ?? "?";
  return `${p.baud} ${p.data_bits}${par}${p.stop_bits}`;
}

/** Rotulo de uma porta detectada: "COM3 — USB-SERIAL CH340 (1A86:7523)". */
export function portLabel(p: { port: string; friendly_name?: string; vid?: string; pid?: string }): string {
  let name = (p.friendly_name ?? "").replace(new RegExp(`\\s*\\(${p.port}\\)\\s*$`, "i"), "").trim();
  if (p.vid && p.pid) name = `${name}${name ? " " : ""}(${p.vid}:${p.pid})`;
  return name ? `${p.port} — ${name}` : p.port;
}

export function serialFormError(p: Partial<SerialProfile>): string | null {
  if (!/^COM[1-9][0-9]{0,2}$/i.test((p.port ?? "").trim())) return "Escolha a porta (ex.: COM3).";
  const baud = Number(p.baud);
  if (!Number.isInteger(baud) || baud < 50 || baud > 12_000_000) return "Velocidade inválida.";
  if (p.stop_bits === "1.5" && p.data_bits !== 5) return "1.5 bit de parada só vale com 5 bits de dados.";
  const log = (p.log_file ?? "").trim();
  if (log && !/^([a-zA-Z]:[\\/]|\\\\|~[\\/]|%USERPROFILE%)/i.test(log)) return "Use um caminho completo para o log (ex.: C:\\logs\\placa.log).";
  return null;
}
