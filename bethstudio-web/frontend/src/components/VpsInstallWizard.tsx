import { useEffect, useRef, useState } from "react";
import type { Connection } from "@/lib/connection";
import {
  INSTALL_STEPS,
  STEP_ICON,
  emptyForm,
  fingerprintNotice,
  firstError,
  fullDomain,
  installBody,
  sshFields,
  stepStatuses,
  validatePhonePassword,
  validateServerForm,
  validateSubdomain,
  type ProbeStatus,
  type VpsEvent,
  type VpsJobView,
  type VpsServer,
  type WizardForm,
} from "@/lib/vpsInstall";

type Zone = { id: string; name: string; status: string };
type Probe = { fingerprint: string; key_type: string; status: ProbeStatus; known_fingerprint?: string };
type PlanStep = { id: string; title: string; detail: string; commands?: string[] };
type VpsState = { server: VpsServer | null; phone_has_pw: boolean; bins_embedded: boolean };

type Stage = "home" | "cloudflare" | "server" | "fingerprint" | "options" | "run" | "action";

const input = "mt-1 w-full max-w-xl rounded border border-border bg-bg-term px-2.5 py-2 text-[14px] text-text-1 outline-none focus:border-accent";
const label = "mt-3 block text-[12px] text-text-3";
const btn = "rounded bg-accent px-3 py-1.5 text-[13px] text-white disabled:opacity-50";
const btn2 = "rounded border border-border px-3 py-1.5 text-[13px] text-text-1 disabled:opacity-50";

/** Configurações > Celular > Instalar servidor: VPS limpo + bethstudio-proxy com HTTPS próprio + Cloudflare. */
export function VpsInstallWizard({ conn, onMessage }: { conn: Connection; onMessage: (m: string) => void }) {
  const [stage, setStage] = useState<Stage>("home");
  const [state, setState] = useState<VpsState | null>(null);
  const [f, setF] = useState<WizardForm>(emptyForm());
  const [zones, setZones] = useState<Zone[]>([]);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [replaceKnown, setReplaceKnown] = useState(false);
  const [plan, setPlan] = useState<PlanStep[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [job, setJob] = useState<VpsJobView | null>(null);
  const [events, setEvents] = useState<VpsEvent[]>([]);
  const [action, setAction] = useState<"update" | "status" | "logs" | "remove" | "password" | "">("");
  const [newPhonePw, setNewPhonePw] = useState("");
  const [alsoDns, setAlsoDns] = useState(true);
  const poll = useRef<number | null>(null);

  const set = <K extends keyof WizardForm>(k: K, v: WizardForm[K]) => setF((p) => ({ ...p, [k]: v }));

  async function loadState() {
    try {
      setState(await conn.api<VpsState>("/api/vps/state"));
    } catch {
      /* sem estado: a tela mostra o botão de instalar */
    }
  }
  useEffect(() => {
    void loadState();
    return () => {
      if (poll.current) window.clearInterval(poll.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function wipeSecrets() {
    setF((p) => ({ ...p, token: "", password: "", privateKey: "", passphrase: "" }));
  }

  async function guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setErr("");
    try {
      return await fn();
    } catch (e) {
      setErr((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function checkToken() {
    const r = await guard(() => conn.api<{ zones: Zone[] }>("/api/vps/cf/zones", { cf_token: f.token }));
    if (!r) return;
    setZones(r.zones);
    if (!f.zoneId && r.zones.length === 1) setF((p) => ({ ...p, zoneId: r.zones[0].id, zoneName: r.zones[0].name }));
  }

  async function doProbe() {
    const r = await guard(() => conn.api<Probe>("/api/vps/probe", { host: f.host.trim(), port: Number(f.port) || 22 }));
    if (!r) return;
    setProbe(r);
    setConfirmed(false);
    setReplaceKnown(false);
    setStage("fingerprint");
  }

  async function loadPlan() {
    const r = await guard(() => conn.api<{ steps: PlanStep[] }>("/api/vps/plan", installBody(f, probe?.fingerprint ?? "", replaceKnown)));
    if (r) setPlan(r.steps);
  }

  function follow(id: string, done: (v: VpsJobView) => void) {
    let since = 0;
    const all: VpsEvent[] = [];
    setEvents([]);
    if (poll.current) window.clearInterval(poll.current);
    const tick = async () => {
      try {
        const v = await conn.api<VpsJobView>(`/api/vps/job?id=${encodeURIComponent(id)}&since=${since}`);
        since = v.next;
        if (v.events.length) {
          all.push(...v.events);
          setEvents([...all]);
        }
        setJob(v);
        if (v.done) {
          if (poll.current) window.clearInterval(poll.current);
          poll.current = null;
          done(v);
        }
      } catch {
        /* o Studio pode estar ocupado; tenta no próximo tick */
      }
    };
    poll.current = window.setInterval(() => void tick(), 1000);
    void tick();
  }

  async function startInstall() {
    const r = await guard(() => conn.api<{ job: string }>("/api/vps/install", installBody(f, probe?.fingerprint ?? "", replaceKnown)));
    if (!r) return;
    setJob(null);
    setStage("run");
    follow(r.job, (v) => {
      void loadState();
      if (v.ok) {
        wipeSecrets(); // com sucesso, os segredos saem da memória da tela; em falha ficam para a nova tentativa
        onMessage("Servidor instalado e pareado");
      }
    });
  }

  async function startAction(kind: "update" | "status" | "logs" | "remove") {
    const body = { action: kind, ...sshFields(f), cf_token: alsoDns ? f.token : "" };
    const r = await guard(() => conn.api<{ job: string }>("/api/vps/action", body));
    if (!r) return;
    setJob(null);
    setStage("action");
    follow(r.job, () => {
      wipeSecrets();
      void loadState();
    });
  }

  async function changePhonePw() {
    const ok = await guard(() => conn.api<{ ok: boolean }>("/api/vps/phone-password", { phone_password: newPhonePw }));
    if (ok) {
      setNewPhonePw("");
      setAction("");
      onMessage("Senha do celular trocada. Quem estava logado no celular terá que entrar de novo.");
    }
  }

  function loadKeyFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 32 * 1024) {
      setErr("Esse arquivo é grande demais para ser uma chave privada.");
      return;
    }
    void file.text().then((t) => set("privateKey", t));
  }

  const domain = fullDomain(f.sub, f.zoneName);
  const srv = state?.server ?? null;

  // ---------- telas ----------
  if (stage === "run" || stage === "action") return renderRun();

  if (stage === "home") {
    return (
      <div className="mt-6 border-t border-border pt-4">
        <h3 className="text-[14px] font-semibold text-text-1">Servidor para o celular</h3>
        {srv ? (
          <>
            <p className="mt-1 max-w-xl text-[13px] text-text-2">
              Instalado em <b>{srv.host}</b> como <b>{srv.domain}</b> ({srv.proxied ? "com proxy da Cloudflare (instalação antiga)" : "somente DNS"}).
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {(
                [
                  ["update", "Atualizar o servidor"],
                  ["status", "Ver estado"],
                  ["logs", "Ver logs"],
                  ["password", "Trocar senha do celular"],
                  ["remove", "Remover o servidor"],
                ] as const
              ).map(([k, t]) => (
                <button key={k} type="button" className={k === "remove" ? btn2 + " text-status-err" : btn2} onClick={() => { setAction(k); setErr(""); }}>
                  {t}
                </button>
              ))}
            </div>
            {action === "password" && (
              <div className="mt-3">
                <label className={label} htmlFor="vps-newpw">Nova senha do celular (mínimo de 8 caracteres)</label>
                <input id="vps-newpw" type="password" autoComplete="new-password" className={input} value={newPhonePw} onChange={(e) => setNewPhonePw(e.target.value)} />
                <button type="button" className={btn + " mt-3"} disabled={busy || newPhonePw.trim().length < 8} onClick={() => void changePhonePw()}>
                  Trocar senha
                </button>
              </div>
            )}
            {(action === "update" || action === "status" || action === "logs" || action === "remove") && (
              <div className="mt-3">
                <p className="text-[12px] text-text-3">Por segurança, o Studio não guarda senha nem chave do servidor. Informe de novo (usuário: {srv.user}).</p>
                {authFields()}
                {action === "remove" && (
                  <>
                    <label className="mt-3 flex items-center gap-2 text-[13px] text-text-1">
                      <input type="checkbox" checked={alsoDns} onChange={(e) => setAlsoDns(e.target.checked)} />
                      Remover também o registro DNS que o assistente criou (precisa do token da Cloudflare)
                    </label>
                    {alsoDns && (
                      <input aria-label="Token da Cloudflare" type="password" autoComplete="off" placeholder="Token da Cloudflare" className={input} value={f.token} onChange={(e) => set("token", e.target.value)} />
                    )}
                    <p className="mt-2 max-w-xl text-[12px] text-text-3">
                      Remove o serviço, o programa, os dados do proxy (certificados incluídos) e o usuário de serviço bethstudio. Não desinstala o ufw nem pacotes, e não fecha portas. Só apaga registros DNS marcados pelo assistente.
                    </p>
                  </>
                )}
                <button
                  type="button"
                  className={btn + " mt-3"}
                  disabled={busy || (f.authKind === "password" ? f.password === "" : !f.privateKey.includes("PRIVATE KEY"))}
                  onClick={() => void startAction(action)}
                >
                  {action === "remove" ? "Remover agora" : "Continuar"}
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <p className="mt-1 max-w-xl text-[13px] text-text-2">
              Instala o servidor do celular num VPS Linux limpo e dedicado (Debian ou Ubuntu), com HTTPS automático (o próprio bethstudio-proxy obtém o certificado: nenhum outro programa é instalado no servidor) e o DNS na Cloudflare, sem abrir terminal. Este assistente <b>não apaga nada</b> do servidor: se ele não estiver limpo, para e explica.
            </p>
            {state && !state.bins_embedded && (
              <p className="mt-2 text-[12px] text-status-err">Este Studio foi compilado sem o programa do servidor; o assistente não vai conseguir instalar.</p>
            )}
            <button type="button" className={btn + " mt-3"} onClick={() => { setStage("cloudflare"); setErr(""); }}>
              Instalar servidor
            </button>
          </>
        )}
        {err && <p className="mt-2 text-[13px] text-status-err">{err}</p>}
      </div>
    );
  }

  const stepNo = stage === "cloudflare" ? 1 : stage === "server" ? 2 : stage === "fingerprint" ? 3 : 4;
  return (
    <div className="mt-6 border-t border-border pt-4">
      <h3 className="text-[14px] font-semibold text-text-1">Instalar servidor ({stepNo} de 4)</h3>

      {stage === "cloudflare" && (
        <>
          <p className="mt-1 max-w-xl text-[13px] text-text-2">
            Crie um token em dash.cloudflare.com → Meu perfil → Tokens de API, com as permissões <b>Zone → DNS → Edit</b> e <b>Zone → Zone → Read</b>, só na zona que vai usar. O token fica só na memória durante o assistente.
          </p>
          <label className={label} htmlFor="vps-cf">Token da Cloudflare</label>
          <input id="vps-cf" type="password" autoComplete="off" className={input} value={f.token} onChange={(e) => set("token", e.target.value)} />
          <button type="button" className={btn2 + " mt-3"} disabled={busy || !f.token.trim()} onClick={() => void checkToken()}>
            Verificar e listar zonas
          </button>
          {zones.length > 0 && (
            <>
              <label className={label} htmlFor="vps-zone">Zona</label>
              <select
                id="vps-zone"
                className={input}
                value={f.zoneId}
                onChange={(e) => {
                  const z = zones.find((x) => x.id === e.target.value);
                  setF((p) => ({ ...p, zoneId: z?.id ?? "", zoneName: z?.name ?? "" }));
                }}
              >
                <option value="">Escolha…</option>
                {zones.map((z) => (
                  <option key={z.id} value={z.id}>{z.name}</option>
                ))}
              </select>
              <label className={label} htmlFor="vps-sub">Subdomínio</label>
              <div className="flex max-w-xl items-center gap-2">
                <input id="vps-sub" className={input + " !mt-1"} value={f.sub} spellCheck={false} onChange={(e) => set("sub", e.target.value)} />
                <span className="mt-1 whitespace-nowrap text-[13px] text-text-2">.{f.zoneName || "zona"}</span>
              </div>
              {validateSubdomain(f.sub, f.zoneName) && <p className="mt-1 text-[12px] text-status-err">{validateSubdomain(f.sub, f.zoneName)}</p>}
              <p className="mt-4 max-w-xl text-[13px] text-text-1">
                <b>Registro somente DNS (nuvem cinza).</b> O servidor pede o certificado HTTPS à Let&apos;s Encrypt sozinho, e isso exige que a internet chegue direto nele. A nuvem laranja da Cloudflare não é usada: ela fica no meio do desafio do certificado.
              </p>
              <p className="mt-2 text-[12px] text-text-3">Endereço final: https://{domain}</p>
            </>
          )}
        </>
      )}

      {stage === "server" && (
        <>
          <p className="mt-1 max-w-xl text-[13px] text-text-2">Um VPS recém-criado, só para isso (Debian 11/12/13 ou Ubuntu 22.04/24.04/26.04, amd64 ou arm64), com acesso root ou sudo.</p>
          <label className={label} htmlFor="vps-host">IP ou nome do servidor</label>
          <input id="vps-host" className={input} value={f.host} spellCheck={false} onChange={(e) => set("host", e.target.value)} />
          <div className="flex max-w-xl gap-3">
            <div className="flex-1">
              <label className={label} htmlFor="vps-user">Usuário</label>
              <input id="vps-user" className={input} value={f.user} spellCheck={false} onChange={(e) => set("user", e.target.value)} />
            </div>
            <div className="w-28">
              <label className={label} htmlFor="vps-port">Porta SSH</label>
              <input id="vps-port" className={input} value={f.port} onChange={(e) => set("port", e.target.value)} />
            </div>
          </div>
          {authFields()}
        </>
      )}

      {stage === "fingerprint" && probe && (
        <>
          <p className="mt-1 max-w-xl text-[13px] text-text-2">Confira a impressão digital da chave do servidor antes de enviar qualquer senha.</p>
          <p className={`mt-3 max-w-xl rounded border px-3 py-2 text-[13px] ${fingerprintNotice(probe.status, probe.known_fingerprint).tone === "danger" ? "border-status-err text-status-err" : "border-border text-text-2"}`}>
            {fingerprintNotice(probe.status, probe.known_fingerprint).text}
          </p>
          <p className="mt-3 break-all font-mono text-[13px] text-text-1">{probe.fingerprint}</p>
          <p className="text-[12px] text-text-3">Tipo: {probe.key_type}</p>
          <label className="mt-3 flex items-center gap-2 text-[13px] text-text-1">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            Esta é a impressão digital do meu servidor
          </label>
          {probe.status === "changed" && (
            <label className="mt-2 flex items-center gap-2 text-[13px] text-status-err">
              <input type="checkbox" checked={replaceKnown} onChange={(e) => setReplaceKnown(e.target.checked)} />
              Sei que ela mudou e quero substituir a antiga
            </label>
          )}
        </>
      )}

      {stage === "options" && (
        <>
          <label className={label} htmlFor="vps-phonepw">Senha do celular {state?.phone_has_pw ? "(deixe em branco para manter a atual)" : "(mínimo de 8 caracteres)"}</label>
          <input id="vps-phonepw" type="password" autoComplete="new-password" className={input} value={f.phonePassword} onChange={(e) => set("phonePassword", e.target.value)} />
          <label className="mt-3 flex items-start gap-2 text-[13px] text-text-1">
            <input type="checkbox" checked={f.unattended} onChange={(e) => set("unattended", e.target.checked)} />
            <span>Ligar atualizações de segurança automáticas no servidor (não reinicia sozinho)</span>
          </label>
          <button type="button" className={btn2 + " mt-3"} disabled={busy} onClick={() => void loadPlan()}>
            Ver o que será feito
          </button>
          {plan && (
            <ol className="mt-3 max-w-2xl list-decimal space-y-2 pl-5 text-[13px] text-text-1">
              {plan.map((s) => (
                <li key={s.id}>
                  <b>{s.title}.</b> <span className="text-text-2">{s.detail}</span>
                  {s.commands && s.commands.length > 0 && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-[12px] text-text-3">Comandos</summary>
                      <pre className="mt-1 max-h-48 overflow-auto rounded bg-bg-term p-2 text-[11px] text-text-2">{s.commands.join("\n\n")}</pre>
                    </details>
                  )}
                </li>
              ))}
            </ol>
          )}
          <p className="mt-3 max-w-xl text-[12px] text-text-3">Endereço: https://{domain}. A instalação pode ser repetida sem duplicar nada, se algo falhar no meio.</p>
        </>
      )}

      {err && <p className="mt-3 max-w-xl text-[13px] text-status-err">{err}</p>}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          className={btn2}
          onClick={() => {
            setErr("");
            if (stage === "cloudflare") setStage("home");
            else if (stage === "server") setStage("cloudflare");
            else if (stage === "fingerprint") setStage("server");
            else setStage("fingerprint");
          }}
        >
          Voltar
        </button>
        {stage === "cloudflare" && (
          <button type="button" className={btn} disabled={!f.zoneId || !!validateSubdomain(f.sub, f.zoneName)} onClick={() => setStage("server")}>
            Continuar
          </button>
        )}
        {stage === "server" && (
          <button
            type="button"
            className={btn}
            disabled={busy}
            onClick={() => {
              const e = validateServerForm(f);
              if (e) setErr(e);
              else void doProbe();
            }}
          >
            Conectar e ver a impressão digital
          </button>
        )}
        {stage === "fingerprint" && (
          <button type="button" className={btn} disabled={!confirmed || (probe?.status === "changed" && !replaceKnown)} onClick={() => setStage("options")}>
            Confirmar e continuar
          </button>
        )}
        {stage === "options" && (
          <button
            type="button"
            className={btn}
            disabled={busy || !!validatePhonePassword(f.phonePassword, !!state?.phone_has_pw)}
            onClick={() => void startInstall()}
          >
            Instalar
          </button>
        )}
      </div>
      {stage === "options" && validatePhonePassword(f.phonePassword, !!state?.phone_has_pw) && (
        <p className="mt-1 text-[12px] text-text-3">{validatePhonePassword(f.phonePassword, !!state?.phone_has_pw)}</p>
      )}
    </div>
  );

  // ---------- partes reaproveitadas ----------
  function authFields() {
    return (
      <>
        <div className="mt-3 flex gap-4 text-[13px] text-text-1">
          <label className="flex items-center gap-1"><input type="radio" name="vps-auth" checked={f.authKind === "password"} onChange={() => set("authKind", "password")} /> Senha</label>
          <label className="flex items-center gap-1"><input type="radio" name="vps-auth" checked={f.authKind === "key"} onChange={() => set("authKind", "key")} /> Chave privada</label>
        </div>
        {f.authKind === "password" ? (
          <>
            <label className={label} htmlFor="vps-pw">Senha do servidor</label>
            <input id="vps-pw" type="password" autoComplete="off" className={input} value={f.password} onChange={(e) => set("password", e.target.value)} />
          </>
        ) : (
          <>
            <label className={label} htmlFor="vps-key">Chave privada (cole o texto ou escolha o arquivo)</label>
            <textarea id="vps-key" rows={4} spellCheck={false} className={input + " font-mono text-[12px]"} value={f.privateKey} onChange={(e) => set("privateKey", e.target.value)} />
            <input type="file" aria-label="Arquivo da chave privada" className="mt-1 text-[12px] text-text-2" onChange={(e) => loadKeyFile(e.target.files?.[0])} />
            <label className={label} htmlFor="vps-pass">Passphrase da chave (se tiver)</label>
            <input id="vps-pass" type="password" autoComplete="off" className={input} value={f.passphrase} onChange={(e) => set("passphrase", e.target.value)} />
            <label className={label} htmlFor="vps-pw2">Senha do usuário, só se não for root e o sudo pedir senha (opcional)</label>
            <input id="vps-pw2" type="password" autoComplete="off" className={input} value={f.password} onChange={(e) => set("password", e.target.value)} />
          </>
        )}
      </>
    );
  }

  function renderRun() {
    const isInstall = stage === "run";
    const st = stepStatuses(events);
    const fail = firstError(events);
    const done = !!job?.done;
    return (
      <div className="mt-6 border-t border-border pt-4">
        <h3 className="text-[14px] font-semibold text-text-1">{isInstall ? "Instalando o servidor" : "Servidor"}</h3>
        {isInstall && (
          <ul className="mt-2 max-w-xl space-y-1 text-[13px]">
            {INSTALL_STEPS.map((s) => (
              <li key={s.id} className={st[s.id] === "error" ? "text-status-err" : st[s.id] === "pending" ? "text-text-3" : "text-text-1"}>
                <span className="inline-block w-5">{STEP_ICON[st[s.id]]}</span>
                {s.label}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 max-h-56 max-w-2xl overflow-y-auto rounded bg-bg-term p-2 font-mono text-[12px] text-text-2" aria-live="polite">
          {events.map((e) => (
            <div key={e.seq} className={e.status === "error" ? "text-status-err" : ""}>
              {e.msg}
              {e.hint ? ` — ${e.hint}` : ""}
            </div>
          ))}
          {!done && <div>…</div>}
        </div>
        {job?.text && <pre className="mt-3 max-h-72 max-w-2xl overflow-auto rounded bg-bg-term p-2 text-[11px] text-text-2">{job.text}</pre>}
        {done && !job?.ok && (
          <div className="mt-3 max-w-xl text-[13px] text-status-err">
            <p><b>{fail ? `Parou em “${INSTALL_STEPS.find((s) => s.id === fail.step)?.label ?? fail.step}”.` : "Parou."}</b> {job?.error}</p>
            {(job?.hint || fail?.hint) && <p className="mt-1 text-text-2">{job?.hint || fail?.hint}</p>}
            <p className="mt-1 text-text-2">Nada foi apagado do servidor. Corrija e rode de novo: o assistente continua de onde parou, sem duplicar.</p>
          </div>
        )}
        {done && job?.ok && job.outcome && (
          <div className="mt-3">
            <p className="text-[14px] text-text-1">Pronto. No celular, abra <b>{job.outcome.url}</b></p>
            <p className="text-[13px] text-text-2">Ligação PC ↔ servidor: {job.outcome.link === "up" ? "no ar" : job.outcome.link}</p>
            {job.outcome.qr && <img alt="QR code do endereço do servidor" src={job.outcome.qr} className="mt-2 h-40 w-40 rounded bg-white p-1" />}
          </div>
        )}
        <div className="mt-4 flex gap-2">
          {!done && (
            <button type="button" className={btn2} onClick={() => void conn.api("/api/vps/cancel", {})}>
              Cancelar
            </button>
          )}
          {done && (
            <button type="button" className={btn2} onClick={() => { wipeSecrets(); setStage("home"); setAction(""); setPlan(null); setErr(""); void loadState(); }}>
              Fechar
            </button>
          )}
          {done && !job?.ok && isInstall && (
            <button type="button" className={btn} onClick={() => setStage("options")}>
              Voltar e tentar de novo
            </button>
          )}
        </div>
      </div>
    );
  }
}
