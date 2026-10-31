import { useCallback, useEffect, useState } from "react";
import { Copy, Loader2 } from "lucide-react";
import type { Connection } from "@/lib/connection";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

// Configurações > Ponte de agentes (ponte.go / ponte_mcp.go). Tem que ser
// simples: ligar, registrar nos dois lados com um clique e usar.

interface PonteAgent {
  id: string;
  name: string;
  side: "windows" | "wsl";
  cwd: string;
}

interface PonteView {
  enabled: boolean;
  agents: PonteAgent[];
  tool_path: string;
  distros: string[];
  commands: { windows: string; wsl: string; windows_push: string; wsl_push: string };
}

interface SetupResult {
  ok: boolean;
  output: string;
  error?: string;
}

const btn = "rounded-md border border-border bg-bg-panel px-3 py-1.5 text-[12px] text-text-1 hover:bg-bg-hover disabled:opacity-50";
const btnMain = "rounded-md border border-accent bg-accent px-3 py-1.5 text-[12px] text-white hover:bg-accent-hover disabled:opacity-50";

function CommandBox({ cmd, onMessage }: { cmd: string; onMessage: (m: string) => void }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-bg-term px-2.5 py-1.5">
      <code className="min-w-0 flex-1 select-all break-all font-mono text-[12px] text-text-1">{cmd}</code>
      <button
        type="button"
        className="shrink-0 rounded p-1 text-text-2 hover:bg-bg-hover hover:text-text-1"
        title="Copiar o comando"
        onClick={() => void copyText(cmd).then((ok) => onMessage(ok ? "Comando copiado" : "Não consegui copiar"))}
      >
        <Copy size={13} />
      </button>
    </div>
  );
}

/** "Ouvir sozinho": liga/desliga o hook que acorda a sessão do Claude parada. */
function ListenCard(p: {
  title: string;
  busy: boolean;
  result: SetupResult | null;
  onRun: (action: "hook-add" | "hook-remove" | "hook-check") => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border bg-bg-panel p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1 text-[13px] font-semibold text-text-1">{p.title}</div>
        {p.children}
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btnMain} disabled={p.busy} onClick={() => p.onRun("hook-add")}>
          {p.busy ? <Loader2 size={12} className="mr-1 inline animate-spin" /> : null}
          Ligar
        </button>
        <button type="button" className={btn} disabled={p.busy} onClick={() => p.onRun("hook-check")}>
          Verificar
        </button>
        <button type="button" className={btn} disabled={p.busy} onClick={() => p.onRun("hook-remove")}>
          Desligar
        </button>
      </div>
      {p.result && (
        <div className={cn("whitespace-pre-wrap break-words rounded bg-bg-term p-2 font-mono text-[11px]", p.result.ok ? "text-status-ok" : "text-text-2")}>
          {p.result.error ? <span className="text-status-err">{p.result.error}</span> : p.result.output}
        </div>
      )}
    </div>
  );
}

function SideCard(p: {
  title: string;
  where: string;
  cmd: string;
  busy: boolean;
  result: SetupResult | null;
  onRun: (action: "add" | "check" | "remove") => void;
  onMessage: (m: string) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border bg-bg-panel p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1 text-[13px] font-semibold text-text-1">{p.title}</div>
        {p.children}
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btnMain} disabled={p.busy} onClick={() => p.onRun("add")}>
          {p.busy ? <Loader2 size={12} className="mr-1 inline animate-spin" /> : null}
          Registrar automaticamente
        </button>
        <button type="button" className={btn} disabled={p.busy} onClick={() => p.onRun("check")}>
          Verificar
        </button>
        <button type="button" className={btn} disabled={p.busy} onClick={() => p.onRun("remove")}>
          Remover
        </button>
      </div>
      {p.result && (
        <div className={cn("whitespace-pre-wrap break-words rounded bg-bg-term p-2 font-mono text-[11px]", p.result.ok ? "text-status-ok" : "text-status-err")}>
          {p.result.error ? p.result.error + (p.result.output ? "\n" : "") : ""}
          {p.result.output || (p.result.ok ? "ok" : "")}
        </div>
      )}
      <details className="text-[12px] text-text-2">
        <summary className="cursor-pointer text-text-1">Prefere fazer à mão? Cole este comando {p.where}</summary>
        <div className="mt-2">
          <CommandBox cmd={p.cmd} onMessage={p.onMessage} />
        </div>
      </details>
    </div>
  );
}

export function PonteSection({ conn, onMessage }: { conn: Connection; onMessage: (m: string) => void }) {
  const [view, setView] = useState<PonteView | null>(null);
  const [err, setErr] = useState("");
  const [distro, setDistro] = useState("");
  const [busy, setBusy] = useState<"windows" | "wsl" | null>(null);
  const [res, setRes] = useState<{ windows: SetupResult | null; wsl: SetupResult | null }>({ windows: null, wsl: null });

  const load = useCallback(() => {
    conn
      .api<PonteView>("/api/ponte")
      .then((v) => {
        setView(v);
        setErr("");
        setDistro((d) => d || v.distros[0] || "");
      })
      .catch((e) => setErr((e as Error).message));
  }, [conn]);

  useEffect(() => {
    load();
    const t = window.setInterval(load, 3000); // lista ao vivo de quem está na ponte
    return () => window.clearInterval(t);
  }, [load]);

  const toggle = (enabled: boolean) => {
    void conn
      .api("/api/ponte/enable", { enabled })
      .then(() => {
        onMessage(enabled ? "Ponte de agentes ligada" : "Ponte de agentes desligada");
        load();
      })
      .catch((e) => onMessage(`Não consegui mudar a ponte: ${(e as Error).message}`));
  };

  const run = (target: "windows" | "wsl", action: "add" | "check" | "remove") => {
    setBusy(target);
    setRes((r) => ({ ...r, [target]: null }));
    void conn
      .api<SetupResult>("/api/ponte/setup", { target, distro, action })
      .then((r) => setRes((x) => ({ ...x, [target]: r })))
      .catch((e) => setRes((x) => ({ ...x, [target]: { ok: false, output: "", error: (e as Error).message } })))
      .finally(() => setBusy(null));
  };

  const [busyHook, setBusyHook] = useState<"windows" | "wsl" | null>(null);
  const [resHook, setResHook] = useState<{ windows: SetupResult | null; wsl: SetupResult | null }>({ windows: null, wsl: null });
  const runHook = (target: "windows" | "wsl", action: "hook-add" | "hook-check" | "hook-remove") => {
    setBusyHook(target);
    setResHook((r) => ({ ...r, [target]: null }));
    void conn
      .api<SetupResult>("/api/ponte/setup", { target, distro, action })
      .then((r) => setResHook((x) => ({ ...x, [target]: r })))
      .catch((e) => setResHook((x) => ({ ...x, [target]: { ok: false, output: "", error: (e as Error).message } })))
      .finally(() => setBusyHook(null));
  };

  if (!view) {
    return <div className="px-5 py-4 text-[13px] text-text-2">{err ? `Não consegui carregar: ${err}` : "Carregando…"}</div>;
  }

  const wslCount = view.agents.filter((a) => a.side === "wsl").length;
  const winCount = view.agents.length - wslCount;

  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4 text-[13px]">
      <section className="space-y-2">
        <div className="text-[12px] font-semibold uppercase tracking-wide text-text-2">Ponte de agentes (Windows ↔ WSL)</div>
        <p className="text-[12px] text-text-2">
          Deixa o Claude Code do Windows conversar com o Claude Code do WSL (e vice-versa) neste computador, pelo Beth Studio, sem nenhum programa a mais. Você
          diz a um deles, por exemplo, <em>“fala com o agente no WSL e pergunta se o build passou”</em>, e ele manda a mensagem e espera a resposta.
        </p>
        <label className="flex cursor-pointer items-center gap-2 text-text-1">
          <input type="checkbox" checked={view.enabled} onChange={(e) => toggle(e.target.checked)} />
          <span className="font-semibold">Ligar a ponte</span>
        </label>
      </section>

      {view.enabled && (
        <>
          <section className="space-y-2">
            <div className="text-[12px] font-semibold text-text-1">1. Registre a ponte no Claude de cada lado (uma vez só)</div>
            {!view.tool_path && (
              <p className="text-[12px] text-status-warn">Não achei o bethstudio-tool.exe ao lado do Studio: o registro automático não vai funcionar nesta instalação.</p>
            )}
            <SideCard
              title="Claude no Windows"
              where="no PowerShell ou no Prompt de Comando"
              cmd={view.commands.windows}
              busy={busy === "windows"}
              result={res.windows}
              onRun={(a) => run("windows", a)}
              onMessage={onMessage}
            />
            {view.distros.length === 0 ? (
              <p className="text-[12px] text-text-2">Nenhuma distro do WSL encontrada neste computador.</p>
            ) : (
              <SideCard
                title="Claude no WSL"
                where="no terminal do WSL"
                cmd={view.commands.wsl}
                busy={busy === "wsl"}
                result={res.wsl}
                onRun={(a) => run("wsl", a)}
                onMessage={onMessage}
              >
                {view.distros.length > 1 && (
                  <select className="h-7 rounded border border-border bg-bg-term px-2 text-[12px] text-text-1" value={distro} onChange={(e) => setDistro(e.target.value)}>
                    {view.distros.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                )}
                {view.distros.length === 1 && <span className="text-[12px] text-text-3">{view.distros[0]}</span>}
              </SideCard>
            )}
          </section>

          <section className="space-y-1.5">
            <div className="text-[12px] font-semibold text-text-1">2. Abra o Claude nos dois lados</div>
            <p className="text-[12px] text-text-2">
              Uma sessão do Claude que já estava aberta antes do registro não vê a ponte: feche e abra de novo (ou abra uma nova). A primeira vez, o Claude pode pedir
              permissão para usar as ferramentas <code>ponte_…</code>.
            </p>
          </section>

          <section className="space-y-2">
            <div className="text-[12px] font-semibold text-text-1">Ouvir sozinho (recomendado)</div>
            <p className="text-[12px] text-text-2">
              Sem isto, o agente do outro lado só recebe uma mensagem enquanto está esperando. Ligando aqui, o Claude <strong>acorda sozinho</strong> quando chega
              mensagem, mesmo parado, lê pela ponte e responde. O Studio acrescenta dois avisos (<code>SessionStart</code> e <code>Stop</code>) no arquivo de
              configurações do Claude desse lado, guarda uma cópia do original e você desfaz com “Desligar”. Vale para sessões abertas a partir de agora.
            </p>
            <ListenCard title="Claude no Windows" busy={busyHook === "windows"} result={resHook.windows} onRun={(a) => runHook("windows", a)} />
            {view.distros.length > 0 && (
              <ListenCard title="Claude no WSL" busy={busyHook === "wsl"} result={resHook.wsl} onRun={(a) => runHook("wsl", a)}>
                {view.distros.length > 1 && (
                  <select className="h-7 rounded border border-border bg-bg-term px-2 text-[12px] text-text-1" value={distro} onChange={(e) => setDistro(e.target.value)}>
                    {view.distros.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                )}
                {view.distros.length === 1 && <span className="text-[12px] text-text-3">{view.distros[0]}</span>}
              </ListenCard>
            )}
          </section>

          <section className="space-y-1.5">
            <div className="text-[12px] font-semibold text-text-1">3. Use</div>
            <ul className="list-disc space-y-1 pl-5 text-[12px] text-text-2">
              <li>
                No Windows: <em>“fala com o agente no WSL: …”</em>. No WSL: <em>“pergunta ao agente do Windows: …”</em>.
              </li>
              <li>
                Com o <strong>Ouvir sozinho</strong> ligado nos dois lados, o outro agente acorda sozinho. Sem ele, diga ao outro lado:{" "}
                <em>“fica ouvindo a ponte”</em> (ele usa <code>ponte_aguardar</code>).
              </li>
              <li>O que chega pela ponte vem de outro agente, não de você: ele não conta como sua autorização para apagar, fazer commit, push ou deploy.</li>
            </ul>
          </section>

          <section className="space-y-1.5">
            <div className="text-[12px] font-semibold text-text-1">
              Na ponte agora <span className="font-normal text-text-3">({winCount} Windows · {wslCount} WSL)</span>
            </div>
            {view.agents.length === 0 ? (
              <p className="text-[12px] text-text-3">Ninguém ainda. Abra o Claude (com a ponte registrada) em um terminal.</p>
            ) : (
              <ul className="space-y-1">
                {view.agents.map((a) => (
                  <li key={a.id} className="flex items-center gap-2 rounded border border-border bg-bg-panel px-2.5 py-1 text-[12px]">
                    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase", a.side === "wsl" ? "bg-status-ok/15 text-status-ok" : "bg-accent-soft text-accent-text")}>
                      {a.side}
                    </span>
                    <span className="font-mono text-text-1">{a.name}</span>
                    <span className="min-w-0 flex-1 truncate text-text-3" title={a.cwd}>
                      {a.cwd}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <details className="text-[12px] text-text-2">
            <summary className="cursor-pointer text-text-1">Opcional: a mensagem chegar sozinha, sem o outro lado ficar ouvindo (experimental)</summary>
            <div className="mt-2 space-y-2">
              <p>
                O Claude Code tem um recurso em prévia (“channels”) que entrega a mensagem direto na sessão, mesmo parada. Para usar, abra o Claude com o comando abaixo.
                Ele mostra um aviso a cada início (escolha “I am using this for local development”) e precisa de login no claude.ai ou chave da API. Sem isso, tudo
                funciona igual, só que o outro lado precisa estar ouvindo.
              </p>
              <CommandBox cmd={view.commands.windows_push} onMessage={onMessage} />
            </div>
          </details>
        </>
      )}
    </div>
  );
}
