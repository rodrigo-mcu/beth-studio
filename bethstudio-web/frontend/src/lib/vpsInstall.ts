// Lógica pura do assistente "Instalar servidor" (Configurações > Celular).
// Os segredos (senha SSH, chave, token) ficam só no estado do componente;
// nada daqui toca o disco nem o localStorage.

export type VpsEvent = { seq: number; step: string; status: "running" | "ok" | "skip" | "info" | "warn" | "error"; msg: string; hint?: string };

export type VpsJobView = {
  id: string;
  kind: string;
  events: VpsEvent[];
  next: number;
  done: boolean;
  ok: boolean;
  error?: string;
  hint?: string;
  outcome?: { domain: string; url: string; qr: string; link: string; detail?: string };
  text?: string;
};

export type VpsServer = {
  host: string;
  port: number;
  user: string;
  domain: string;
  zone_name: string;
  proxied: boolean;
  fingerprint: string;
  installed_at: string;
};

export type StepStatus = "pending" | "running" | "ok" | "skip" | "error";

/** Passos mostrados na tela, na ordem em que o Go os executa. */
export const INSTALL_STEPS: { id: string; label: string }[] = [
  { id: "connect", label: "Conectar por SSH" },
  { id: "preflight", label: "Verificar o servidor" },
  { id: "dns", label: "Conferir o DNS" },
  { id: "proxy", label: "Instalar o bethstudio-proxy" },
  { id: "firewall", label: "Firewall" },
  { id: "upgrades", label: "Atualizações de segurança" },
  { id: "cert", label: "Certificado HTTPS (Let's Encrypt)" },
  { id: "pair", label: "Parear este Studio" },
  { id: "verify", label: "Teste de ponta a ponta" },
];

/** Estado de cada passo a partir dos eventos (o último evento de status do passo vale). */
export function stepStatuses(events: VpsEvent[], steps = INSTALL_STEPS): Record<string, StepStatus> {
  const out: Record<string, StepStatus> = {};
  for (const s of steps) out[s.id] = "pending";
  for (const e of events) {
    if (!(e.step in out)) continue;
    if (e.status === "running" || e.status === "ok" || e.status === "skip" || e.status === "error") out[e.step] = e.status;
  }
  return out;
}

/** Mensagem de erro e dica do primeiro passo com falha. */
export function firstError(events: VpsEvent[]): { step: string; msg: string; hint?: string } | null {
  const e = events.find((x) => x.status === "error");
  return e ? { step: e.step, msg: e.msg, hint: e.hint } : null;
}

export function validateSubdomain(sub: string, zone: string): string | null {
  const s = sub.trim().toLowerCase();
  if (!zone) return "Escolha a zona";
  if (s === "") return null; // domínio raiz da zona
  if (s.length > 190) return "Subdomínio grande demais";
  const labels = s.split(".");
  for (const l of labels) {
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) return "Use só letras, números e hífen (ex.: agentes)";
  }
  return null;
}

export function fullDomain(sub: string, zone: string): string {
  const s = sub.trim().toLowerCase().replace(/\.$/, "");
  return s ? `${s}.${zone}` : zone;
}

/** Endereço final do celular (o nome que aponta para o servidor). */
export function validateDomain(d: string): string | null {
  const v = d.trim().toLowerCase().replace(/\.$/, "");
  if (!v) return "Informe o endereço do celular (ex.: agentes.exemplo.com)";
  if (/^[0-9.]+$/.test(v) || /^[0-9a-f:]+$/.test(v) && v.includes(":")) return "Use um nome (agentes.exemplo.com), não um IP";
  if (/[\s/\:@;|&$`'"<>()]/.test(v)) return "Só o nome, sem https:// nem porta";
  const labels = v.split(".");
  if (labels.length < 2) return "O nome precisa ter pelo menos dois pedaços (agentes.exemplo.com)";
  if (v.length > 253 || !labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return "Nome inválido: só letras, números e hífen";
  return null;
}

/** IP do servidor para o registro DNS (v4 ou v6). */
export function validateIp(ip: string): string | null {
  const v = ip.trim();
  const v4 = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4 && v4.slice(1).every((n) => Number(n) <= 255)) return null;
  if (v.includes(":") && /^[0-9a-fA-F:.]+$/.test(v) && !v.includes(":::")) return null;
  return "Informe o IP do servidor (ex.: 203.0.113.9)";
}

export function validateHost(h: string): string | null {
  const v = h.trim();
  if (!v) return "Informe o IP ou o nome do servidor";
  if (/[\s/\\:@;|&$`'"<>()]/.test(v) && !/^[0-9a-fA-F:]+$/.test(v)) return "Só o IP ou o nome, sem https:// nem porta";
  return null;
}

export function validatePort(p: string): string | null {
  const n = Number(p);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? null : "Porta inválida";
}

export function validateUser(u: string): string | null {
  return /^[a-z_][a-z0-9_-]{0,31}$/.test(u.trim()) ? null : "Usuário inválido (minúsculas, números, _ e -)";
}

export function validatePhonePassword(p: string, alreadySet: boolean): string | null {
  if (p === "" && alreadySet) return null;
  return p.trim().length >= 8 ? null : "A senha do celular precisa de pelo menos 8 caracteres";
}

export type ProbeStatus = "new" | "known" | "changed";

/** Texto e tom do aviso sobre a impressão digital. */
export function fingerprintNotice(status: ProbeStatus, known?: string): { tone: "info" | "ok" | "danger"; text: string } {
  switch (status) {
    case "known":
      return { tone: "ok", text: "Você já confirmou esta impressão digital antes para este servidor." };
    case "changed":
      return {
        tone: "danger",
        text: `ATENÇÃO: a impressão digital MUDOU (antes: ${known ?? "?"}). Isso é normal se você reinstalou o servidor; se não, alguém pode estar se passando por ele. Só continue se tiver certeza.`,
      };
    default:
      return { tone: "info", text: "Primeira conexão com este servidor. Compare a impressão digital abaixo com a do painel do seu provedor (ou com `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` no servidor)." };
  }
}

export type WizardForm = {
  token: string;
  zoneId: string;
  zoneName: string;
  sub: string;
  /** IP do servidor, só para o registro DNS do passo opcional */
  ip: string;
  /** endereço final do celular; vem do passo de DNS ou é digitado */
  domain: string;
  /** registros criados no passo de DNS (para o Remover apagá-los) */
  recordIds: string[];
  proxied: boolean;
  host: string;
  port: string;
  user: string;
  authKind: "password" | "key";
  password: string;
  privateKey: string;
  passphrase: string;
  phonePassword: string;
  unattended: boolean;
};

export const emptyForm = (): WizardForm => ({
  token: "",
  zoneId: "",
  zoneName: "",
  sub: "agentes",
  ip: "",
  domain: "",
  recordIds: [],
  proxied: false,
  host: "",
  port: "22",
  user: "root",
  authKind: "password",
  password: "",
  privateKey: "",
  passphrase: "",
  phonePassword: "",
  unattended: true,
});

/** Primeira validação do formulário do servidor (antes de abrir a conexão). */
export function validateServerForm(f: WizardForm): string | null {
  return (
    validateHost(f.host) ??
    validatePort(f.port) ??
    validateUser(f.user) ??
    (f.authKind === "password" && f.password === "" ? "Informe a senha do servidor" : null) ??
    (f.authKind === "key" && !f.privateKey.includes("PRIVATE KEY") ? "Cole a chave privada (começa com -----BEGIN … PRIVATE KEY-----)" : null)
  );
}

/** Credenciais SSH para o pedido (só o que o modo escolhido usa). */
export function sshFields(f: WizardForm): { host: string; port: number; user: string; password: string; private_key: string; passphrase: string } {
  return {
    host: f.host.trim(),
    port: Number(f.port) || 22,
    user: f.user.trim(),
    password: f.password, // com chave, a senha (opcional) serve só ao sudo
    private_key: f.authKind === "key" ? f.privateKey : "",
    passphrase: f.authKind === "key" ? f.passphrase : "",
  };
}

/** Pedido do passo opcional "Endereço (DNS)". O token só serve a ele. */
export function dnsBody(f: WizardForm) {
  return { cf_token: f.token, zone_id: f.zoneId, zone_name: f.zoneName, domain: fullDomain(f.sub, f.zoneName), ip: f.ip.trim() };
}

/** Pedido de instalação do servidor. Sem o token da Cloudflare: o DNS é outro passo. */
export function installBody(f: WizardForm, fingerprint: string, replaceKnown: boolean) {
  return {
    ...sshFields(f),
    fingerprint,
    replace_known: replaceKnown,
    domain: f.domain.trim().toLowerCase(),
    zone_id: f.zoneId,
    zone_name: f.zoneName,
    record_ids: f.recordIds,
    cf_token: "",
    proxied: false,
    phone_password: f.phonePassword,
    unattended: f.unattended,
  };
}

export const STEP_ICON: Record<StepStatus, string> = { pending: "○", running: "…", ok: "✓", skip: "–", error: "✕" };
