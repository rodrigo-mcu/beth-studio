import { useEffect, useState } from "react";
import type { Connection } from "@/lib/connection";
import { cfgFor, loadWslInit, saveWslInit, testWslInit, validateWslInit, type WslInitCfg, type WslInitState } from "@/lib/wslInit";

/**
 * Configurações > Terminais > WSL: o comando que o Studio digita num terminal
 * visível quando, na restauração, falta a pasta de um terminal (o WSL ainda
 * não montou os discos). Uma linha por distro instalada; grava ao sair do campo.
 */
export function WslInitSettings({ conn, onMessage }: { conn: Connection; onMessage: (m: string) => void }) {
  const [state, setState] = useState<WslInitState | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    let off = false;
    loadWslInit(conn)
      .then((s) => !off && setState(s))
      .catch((e: Error) => !off && setLoadErr(e.message));
    return () => {
      off = true;
    };
  }, [conn]);

  return (
    <section className="space-y-2 px-4 pb-2 pt-5">
      <h3 className="text-[13px] font-semibold text-text-1">WSL: inicialização ao restaurar</h3>
      <p className="text-[12px] text-text-2">
        Depois de reiniciar o PC, alguns WSL só montam os discos depois de um comando seu (por exemplo <code>init-wsl2</code>). Se faltar a pasta de um terminal,
        o Studio pergunta se pode rodar esse comando num terminal visível (é lá que você responde ao UAC ou à senha) e só então abre os terminais dessa distro.
        Sem comando configurado, o terminal sem pasta fica aguardando em vez de abrir na pasta errada.
      </p>
      {loadErr && <div className="text-[12px] text-status-err">Não foi possível ler a configuração: {loadErr}</div>}
      {state && state.distros.length === 0 && <div className="text-[12px] text-text-3">Nenhuma distro WSL instalada foi encontrada.</div>}
      {state?.distros.map((d) => (
        <DistroRow
          key={d}
          distro={d}
          initial={cfgFor(state, d)}
          onSave={(cfg) =>
            saveWslInit(conn, d, cfg).then((s) => {
              setState(s);
              onMessage(`WSL ${d}: configuração salva`);
            })
          }
          onTest={(cfg) =>
            // grava antes de testar: o campo editado ainda pode não ter perdido o foco
            saveWslInit(conn, d, cfg)
              .then((s) => {
                setState(s);
                return testWslInit(conn, d);
              })
              .then(() => onMessage(`WSL ${d}: terminal de inicialização aberto`))
              .catch((e: Error) => onMessage(`Erro: ${e.message}`))
          }
        />
      ))}
    </section>
  );
}

function DistroRow({
  distro,
  initial,
  onSave,
  onTest,
}: {
  distro: string;
  initial: WslInitCfg;
  onSave: (c: WslInitCfg) => Promise<unknown>;
  onTest: (c: WslInitCfg) => void;
}) {
  const [cfg, setCfg] = useState<WslInitCfg>(initial);
  const [err, setErr] = useState<string | null>(null);

  const clean = (c: WslInitCfg): WslInitCfg => ({ ...c, command: c.command.trim(), default_dir: (c.default_dir ?? "").trim() || undefined });
  /** Grava (se válido); o erro aparece na linha, sem fechar nada. */
  const commit = (next: WslInitCfg) => {
    setCfg(next);
    const bad = validateWslInit(next);
    setErr(bad);
    if (bad) return;
    onSave(clean(next)).catch((e: Error) => setErr(e.message));
  };
  const field = "w-full rounded border border-border bg-bg-term px-2 py-1 text-[13px] text-text-1 outline-none focus:border-accent";

  return (
    <div className="space-y-2 rounded border border-border bg-bg-panel p-3">
      <label className="flex items-center gap-2 text-[13px] font-semibold text-text-1">
        <input type="checkbox" checked={cfg.enabled} onChange={(e) => commit({ ...cfg, enabled: e.target.checked })} />
        {distro}: perguntar se roda o comando de inicialização quando faltar uma pasta
      </label>
      <div className="grid gap-2 md:grid-cols-[1fr_110px]">
        <label className="space-y-0.5 text-[11px] text-text-3">
          Comando (como você digitaria no terminal)
          <input
            className={field}
            value={cfg.command}
            placeholder="init-wsl2"
            spellCheck={false}
            onChange={(e) => setCfg({ ...cfg, command: e.target.value })}
            onBlur={() => commit(cfg)}
          />
        </label>
        <label className="space-y-0.5 text-[11px] text-text-3">
          Tempo máximo (s)
          <input
            className={field}
            type="number"
            min={10}
            max={1800}
            value={Number.isFinite(cfg.timeout_sec) ? cfg.timeout_sec : ""}
            onChange={(e) => setCfg({ ...cfg, timeout_sec: e.target.value === "" ? Number.NaN : Number(e.target.value) })}
            onBlur={() => commit(cfg)}
          />
        </label>
      </div>
      <label className="block space-y-0.5 text-[11px] text-text-3">
        Pasta padrão para “Abrir na pasta padrão” (vazio = a home do WSL)
        <input
          className={field}
          value={cfg.default_dir ?? ""}
          placeholder="/mnt/kingston/mcu"
          spellCheck={false}
          onChange={(e) => setCfg({ ...cfg, default_dir: e.target.value })}
          onBlur={() => commit(cfg)}
        />
      </label>
      <div className="flex items-center gap-2">
        <button
          className="rounded bg-bg-hover px-3 py-1 text-[12px] text-text-1 hover:bg-border disabled:opacity-50"
          disabled={!cfg.command.trim() || !!validateWslInit(cfg)}
          title="Abre um terminal desta distro e digita o comando, sem restaurar nada"
          onClick={() => onTest(clean(cfg))}
        >
          Testar agora
        </button>
        {err && <span className="text-[12px] text-status-err">{err}</span>}
      </div>
    </div>
  );
}
