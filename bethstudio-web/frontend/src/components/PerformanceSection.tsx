import { useCallback, useEffect, useState } from "react";
import type { Connection } from "@/lib/connection";
import { isRemote } from "@/lib/remote";
import { readRendererPref, writeRendererPref, type RendererPref } from "@/lib/termRenderer";
import { cn } from "@/lib/utils";

interface DefenderPath {
  label: string;
  path: string;
}

interface DefenderView {
  supported: boolean;
  antivirus: string[];
  defender: boolean;
  paths: DefenderPath[];
}

const RENDERERS: { id: RendererPref; title: string; sub: string }[] = [
  { id: "auto", title: "Automático (recomendado)", sub: "usa a placa de vídeo (WebGL) quando há uma de verdade; sem ela, ou se falhar, usa o modo compatível" },
  { id: "webgl", title: "Sempre WebGL", sub: "mais rápido na placa de vídeo; use se o automático escolher o modo compatível sem precisar" },
  { id: "dom", title: "Modo compatível", sub: "o desenho mais lento, mas funciona em qualquer PC; use se o WebGL causar falhas na tela" },
];

function Radio({ on, onClick, title, sub }: { on: boolean; onClick: () => void; title: string; sub: string }) {
  return (
    <button
      type="button"
      className={cn("flex w-full items-start gap-2 rounded-md border p-2.5 text-left", on ? "border-accent bg-accent-soft" : "border-border bg-bg-panel hover:bg-bg-hover")}
      onClick={onClick}
    >
      <span className={cn("mt-1 h-3 w-3 shrink-0 rounded-full border-2", on ? "border-accent bg-accent" : "border-border-strong")} />
      <span>
        <span className="block text-[13px] text-text-1">{title}</span>
        <span className="block text-[11px] text-text-3">{sub}</span>
      </span>
    </button>
  );
}

const btn = "rounded-md border border-border bg-bg-panel px-3 py-1.5 text-[12px] text-text-1 hover:bg-bg-hover disabled:opacity-50";
const btnMain = "rounded-md border border-accent bg-accent px-3 py-1.5 text-[12px] text-white hover:bg-accent-hover disabled:opacity-50";

/** Configurações > Terminais > Desempenho: desenho do terminal e exclusões do Windows Defender. */
export function PerformanceSection({ conn, onMessage }: { conn: Connection; onMessage: (m: string) => void }) {
  const [pref, setPref] = useState<RendererPref>(() => readRendererPref());
  const remote = isRemote();

  const choose = (p: RendererPref) => {
    writeRendererPref(p);
    setPref(p);
    onMessage("Salvo. Vale para os terminais abertos daqui em diante; recarregue a interface para aplicar a todos.");
  };

  return (
    <div className="space-y-5 px-4 pt-5">
      <section>
        <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-text-2">Desempenho: desenho do terminal</div>
        <p className="mb-2 text-[12px] text-text-2">
          Se o Beth Studio está lento neste computador, o desenho do terminal é o primeiro lugar para olhar. Esta escolha vale só para esta tela.
        </p>
        <div className="grid gap-2 md:grid-cols-3">
          {RENDERERS.map((r) => (
            <Radio key={r.id} on={pref === r.id} onClick={() => choose(r.id)} title={r.title} sub={r.sub} />
          ))}
        </div>
      </section>
      {!remote && <DefenderBlock conn={conn} onMessage={onMessage} />}
    </div>
  );
}

function DefenderBlock({ conn, onMessage }: { conn: Connection; onMessage: (m: string) => void }) {
  const [view, setView] = useState<DefenderView | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState<"apply" | "remove" | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    conn
      .api<DefenderView>("/api/perf/defender")
      .then((v) => setView(v))
      .catch(() => setFailed(true));
  }, [conn]);
  useEffect(load, [load]);

  if (failed || !view || !view.supported) return null;

  const run = async (kind: "apply" | "remove") => {
    setBusy(true);
    setResult(null);
    try {
      const r = await conn.api<{ message: string }>(`/api/perf/defender/${kind}`, { confirm: true });
      setResult({ ok: true, text: r.message });
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : "Não foi possível concluir." });
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  const openSecurity = () =>
    void conn
      .api("/api/perf/defender/open-security", {})
      .catch((e: Error) => onMessage(`Erro: ${e.message}`));

  const copy = (p: string) => {
    void navigator.clipboard
      ?.writeText(p)
      .then(() => onMessage("Caminho copiado"))
      .catch(() => onMessage("Não consegui copiar"));
  };

  const av = view.antivirus.length ? view.antivirus.join(", ") : "não identificado";

  return (
    <section>
      <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-text-2">Desempenho: antivírus</div>
      <p className="mb-2 text-[12px] text-text-2">
        O antivírus examina cada arquivo que o Beth Studio e o WebView2 gravam, e isso pesa em notebook lento. Você pode tirar só as pastas abaixo do exame em
        tempo real. <strong>Isso reduz a proteção dessas pastas</strong>: faça apenas se você confia nesta instalação. Antivírus detectado: {av}.
      </p>
      <ul className="mb-3 space-y-1.5">
        {view.paths.map((p) => (
          <li key={p.path} className="flex items-center gap-2 rounded-md border border-border bg-bg-panel px-2.5 py-1.5">
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] text-text-3">{p.label}</span>
              <span className="block break-all font-mono text-[12px] text-text-1">{p.path}</span>
            </span>
            <button type="button" className={btn} onClick={() => copy(p.path)}>
              Copiar
            </button>
          </li>
        ))}
      </ul>

      {confirming ? (
        <div className="space-y-2 rounded-md border border-warn p-3 text-[12px] text-text-1">
          <p>
            {confirming === "apply"
              ? "O Windows vai pedir permissão de administrador (a janela azul do UAC). O Beth Studio não roda como administrador: só um comando do PowerShell, com as duas pastas acima, é executado com essa permissão."
              : "O Windows vai pedir permissão de administrador. As duas pastas acima voltam a ser examinadas pelo Defender."}
          </p>
          <div className="flex gap-2">
            <button type="button" className={btnMain} disabled={busy} onClick={() => void run(confirming)}>
              {busy ? "Aguardando o Windows…" : "Continuar e pedir permissão"}
            </button>
            <button type="button" className={btn} disabled={busy} onClick={() => setConfirming(null)}>
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {view.defender ? (
            <>
              <button type="button" className={btnMain} onClick={() => setConfirming("apply")}>
                Adicionar exclusões (pede permissão)
              </button>
              <button type="button" className={btn} onClick={() => setConfirming("remove")}>
                Remover exclusões
              </button>
            </>
          ) : (
            <p className="text-[12px] text-text-2">O botão automático só funciona com o Windows Defender. No seu antivírus, adicione as pastas acima como exclusão.</p>
          )}
          <button type="button" className={btn} onClick={openSecurity}>
            Abrir a Segurança do Windows
          </button>
        </div>
      )}

      {result && (
        <p className={cn("mt-2 text-[12px]", result.ok ? "text-ok" : "text-err")} role="status">
          {result.text}
        </p>
      )}

      <details className="mt-3 text-[12px] text-text-2">
        <summary className="cursor-pointer text-text-1">Fazer à mão, passo a passo</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>Abra a Segurança do Windows (botão acima) e vá em Proteção contra vírus e ameaças.</li>
          <li>Em “Configurações de proteção contra vírus e ameaças”, clique em Gerenciar configurações.</li>
          <li>Role até Exclusões e clique em Adicionar ou remover exclusões.</li>
          <li>Clique em Adicionar uma exclusão, escolha Pasta e selecione cada pasta da lista acima (use Copiar e cole no seletor).</li>
          <li>Para desfazer, volte aqui e remova a exclusão da mesma tela.</li>
        </ol>
      </details>
    </section>
  );
}
