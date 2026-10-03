import { useEffect, useState } from "react";
import type { Connection } from "@/lib/connection";

type PhoneSetup = {
  domain: string;
  configured: boolean;
  link: "off" | "connecting" | "up" | "down";
  detail: string;
};

function applySetup(s: PhoneSetup, set: { domain: (v: string) => void; configured: (v: boolean) => void; link: (v: PhoneSetup["link"]) => void; detail: (v: string) => void }) {
  set.domain(s.domain || "");
  set.configured(!!s.configured);
  set.link(s.link || "off");
  set.detail(s.detail || "");
}

/** Configurações → Celular: código do bethstudio-proxy e senha do celular. */
export function PhoneRemoteSection({ conn, onMessage }: { conn: Connection; onMessage: (m: string) => void }) {
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [domain, setDomain] = useState("");
  const [configured, setConfigured] = useState(false);
  const [link, setLink] = useState<PhoneSetup["link"]>("off");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stop = false;
    const load = () => {
      void conn
        .api<PhoneSetup>("/api/phone/setup")
        .then((s) => {
          if (stop) return;
          applySetup(s, { domain: setDomain, configured: setConfigured, link: setLink, detail: setDetail });
        })
        .catch(() => undefined);
    };
    load();
    const t = window.setInterval(load, 2000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [conn]);

  async function save() {
    setBusy(true);
    try {
      const s = await conn.api<PhoneSetup>("/api/phone/setup", {
        code: code.trim(),
        password,
      });
      applySetup(s, { domain: setDomain, configured: setConfigured, link: setLink, detail: setDetail });
      setPassword("");
      setCode("");
      onMessage(s.configured ? `Salvo. Conectando em ${s.domain}` : "Senha do celular salva");
    } catch (e) {
      onMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const up = link === "up";
  const busyLink = link === "connecting";
  const statusText = !configured
    ? "Cole a linha do servidor"
    : up
      ? "Conectado"
      : busyLink
        ? "Conectando…"
        : detail
          ? `Desconectado. ${detail}`
          : "Desconectado";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <h2 className="text-[15px] font-semibold text-text-1">Celular</h2>
      <p className="mt-1 max-w-xl text-[13px] text-text-2">
        No servidor, copie a linha que começa com bethstudio://link e cole abaixo. A senha é a que você digita no celular. Mínimo de 8 caracteres. Deixe a senha em branco para manter a atual.
      </p>
      <p className="mt-3 flex items-center gap-2 text-[13px] text-text-1">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${up ? "bg-status-ok" : busyLink ? "animate-pulse bg-status-busy" : configured ? "bg-status-err" : "bg-text-3"}`}
        />
        {statusText}
      </p>
      {configured && domain && <p className="mt-1 text-[13px] text-text-2">No celular, abra https://{domain}</p>}
      {configured && link === "down" && <p className="mt-1 text-[12px] text-text-3">O computador tenta de novo sozinho.</p>}
      <label className="mt-4 block text-[12px] text-text-3" htmlFor="phone-code">
        Linha do servidor
      </label>
      <textarea
        id="phone-code"
        value={code}
        rows={3}
        spellCheck={false}
        placeholder="bethstudio://link?domain=..."
        className="mt-1 w-full max-w-xl resize-none rounded border border-border bg-bg-term px-2.5 py-2 font-mono text-[13px] text-text-1 outline-none focus:border-accent"
        onChange={(e) => setCode(e.target.value)}
      />
      <label className="mt-3 block text-[12px] text-text-3" htmlFor="phone-password">
        Senha do celular
      </label>
      <input
        id="phone-password"
        type="password"
        value={password}
        autoComplete="new-password"
        className="mt-1 w-full max-w-xl rounded border border-border bg-bg-term px-2.5 py-2 text-[14px] text-text-1 outline-none focus:border-accent"
        onChange={(e) => setPassword(e.target.value)}
      />
      <button
        type="button"
        disabled={busy || !code.trim()}
        className="mt-4 rounded bg-accent px-3 py-1.5 text-[13px] text-white disabled:opacity-50"
        onClick={() => void save()}
      >
        Salvar
      </button>
    </div>
  );
}
