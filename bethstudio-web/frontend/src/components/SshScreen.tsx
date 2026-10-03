import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppWindow, Cable, Clock, Copy, FolderOpen, Import, KeyRound, Pencil, Plug, Plus, Search, Server, ShieldAlert, Terminal, Trash2, X } from "lucide-react";
import { sftpApi, sshApi, type SerialProfile, type SshApiClient, type SshConfigCandidate, type SshHost, type SshRecent } from "@/lib/sshApi";
import { groupBy, hostTarget, matchesHost, recentItems } from "@/lib/sshUtil";
import { cn } from "@/lib/utils";
import { SshBtn, SshColorDot, SshConfirm, SshKeyFlow, type SshKeyIssue } from "./SshCommon";
import { SshFilesPanel } from "./SshFilesPanel";
import { SshHostEditor } from "./SshHostEditor";
import { SshSerialPanel } from "./SshSerialPanel";

export type ToolKind = "ssh" | "serial";

interface Props {
  conn: SshApiClient;
  readOnly: boolean;
  /** Cria o terminal no host (op spawn_tool) e abre uma aba nova do web com
   *  este nome. Rejeita com a mensagem de erro. */
  onConnect: (kind: ToolKind, id: string, tabName: string) => Promise<void>;
  onClose: () => void;
  initialTab?: ToolKind;
}

type Right = { kind: "detail" } | { kind: "edit"; host: SshHost | null } | { kind: "files" } | { kind: "import" };

/** Tela "SSH e Serial": hosts salvos, arquivos (SFTP) e perfis de porta serial. */
export function SshScreen({ conn, readOnly, onConnect, onClose, initialTab = "ssh" }: Props) {
  const [tab, setTab] = useState<ToolKind>(initialTab);
  const [hosts, setHosts] = useState<SshHost[]>([]);
  const [recent, setRecent] = useState<SshRecent[]>([]);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [right, setRight] = useState<Right>({ kind: "detail" });
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | { kind: "delete" | "forget"; host: SshHost }>(null);
  const [keyIssue, setKeyIssue] = useState<SshKeyIssue | null>(null);

  const note = useCallback((text: string, tone: "ok" | "err") => setMsg({ text, tone }), []);
  const reload = useCallback(
    () =>
      sshApi
        .list(conn)
        .then((r) => {
          setHosts(r.hosts);
          setRecent(r.recent);
        })
        .catch((e: Error) => note(e.message, "err")),
    [conn, note],
  );
  useEffect(() => {
    void reload();
  }, [reload]);

  const shown = useMemo(() => hosts.filter((h) => matchesHost(h, query)), [hosts, query]);
  const groups = useMemo(() => groupBy(shown), [shown]);
  const recents = useMemo(() => recentItems(recent, hosts), [recent, hosts]);
  const groupNames = useMemo(() => [...new Set(hosts.map((h) => h.group ?? "").filter(Boolean))].sort(), [hosts]);
  const current = hosts.find((h) => h.id === sel) ?? null;

  const connect = (kind: ToolKind, id: string, name: string) => {
    if (readOnly) return;
    setBusy(`connect:${id}`);
    onConnect(kind, id, name)
      .then(() => onClose())
      .catch((e: Error) => note(`Não foi possível abrir o terminal: ${e.message}`, "err"))
      .finally(() => setBusy(null));
  };

  const test = (h: SshHost) => {
    setBusy(`test:${h.id}`);
    setMsg(null);
    sshApi
      .test(conn, { id: h.id })
      .then((r) => {
        if (r.ok) note(`${h.name}: conexão OK.`, "ok");
        else if (r.host_key && (r.code === "unknown_host_key" || r.code === "host_key_mismatch")) setKeyIssue({ info: r.host_key, target: { id: h.id } });
        else if (/senha necessária/i.test(r.error ?? ""))
          note(`${h.name}: servidor alcançado. Sem senha salva — o terminal vai pedir a senha ao conectar.`, "ok");
        else note(`${h.name}: ${r.error ?? "falhou"}`, "err");
      })
      .catch((e: Error) => note(e.message, "err"))
      .finally(() => setBusy(null));
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onMouseDown={onClose}>
      <div
        className="flex h-[min(820px,94vh)] w-[min(1180px,96vw)] flex-col rounded-lg border border-border-strong bg-bg-card shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && !confirm && !keyIssue && onClose()}
        role="dialog"
        aria-modal="true"
      >
        {/* cabecalho */}
        <div className="flex items-center gap-1 border-b border-border px-3 py-2">
          <TabBtn active={tab === "ssh"} onClick={() => setTab("ssh")}>
            <Server size={14} /> SSH
          </TabBtn>
          <TabBtn active={tab === "serial"} onClick={() => setTab("serial")}>
            <Cable size={14} /> Serial
          </TabBtn>
          <div className="flex-1" />
          {readOnly && <span className="mr-2 text-[11px] text-status-warn">somente leitura</span>}
          <SshBtn tone="ghost" onClick={onClose} title="Fechar">
            <X size={16} />
          </SshBtn>
        </div>

        <div className="min-h-0 flex-1 p-3">
          {tab === "serial" ? (
            <SshSerialPanel conn={conn} readOnly={readOnly} onMessage={note} onConnect={(p: SerialProfile) => connect("serial", p.id, `Serial · ${p.port}`)} />
          ) : (
            <div className="flex h-full min-h-0 gap-3">
              {/* lista de hosts */}
              <div className="flex w-72 shrink-0 flex-col">
                <div className="mb-2 flex items-center gap-1 rounded border border-border-strong bg-bg-panel px-2">
                  <Search size={13} className="text-text-3" />
                  <input
                    className="w-full bg-transparent py-1 text-[13px] text-text-1 outline-none"
                    placeholder="Buscar host, IP, grupo…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <div className="mb-2 flex gap-1">
                  <SshBtn tone="primary" className="flex-1 justify-center" disabled={readOnly} onClick={() => setRight({ kind: "edit", host: null })}>
                    <Plus size={14} /> Novo host
                  </SshBtn>
                  <SshBtn disabled={readOnly} onClick={() => setRight({ kind: "import" })} title="Importar do ~/.ssh/config">
                    <Import size={14} /> Importar
                  </SshBtn>
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {recents.length > 0 && !query && (
                    <div className="mb-2">
                      <div className="mb-1 flex items-center gap-1 text-[11px] uppercase tracking-wide text-text-3">
                        <Clock size={11} /> Recentes
                      </div>
                      {recents.map((h) => (
                        <HostRow
                          key={`r${h.id}`}
                          h={h}
                          active={sel === h.id}
                          onClick={() => {
                            setSel(h.id);
                            setRight({ kind: "detail" });
                          }}
                          onDouble={() => connect("ssh", h.id, h.name)}
                        />
                      ))}
                    </div>
                  )}
                  {groups.map((g) => (
                    <div key={g.group} className="mb-2">
                      <div className="mb-1 text-[11px] uppercase tracking-wide text-text-3">{g.group}</div>
                      {g.items.map((h) => (
                        <HostRow
                          key={h.id}
                          h={h}
                          active={sel === h.id}
                          onClick={() => {
                            setSel(h.id);
                            setRight({ kind: "detail" });
                          }}
                          onDouble={() => connect("ssh", h.id, h.name)}
                        />
                      ))}
                    </div>
                  ))}
                  {hosts.length === 0 && (
                    <div className="p-2 text-[12px] text-text-3">Nenhum host salvo. Use “Novo host” ou importe do ~/.ssh/config.</div>
                  )}
                  {hosts.length > 0 && shown.length === 0 && <div className="p-2 text-[12px] text-text-3">Nada encontrado para “{query}”.</div>}
                </div>
              </div>

              {/* painel da direita */}
              <div className="min-w-0 flex-1 rounded border border-border bg-bg-panel/40 p-3">
                {right.kind === "edit" ? (
                  <SshHostEditor
                    conn={conn}
                    initial={right.host}
                    groups={groupNames}
                    readOnly={readOnly}
                    onCancel={() => setRight({ kind: "detail" })}
                    onSaved={(h) => {
                      setSel(h.id);
                      setRight({ kind: "detail" });
                      note(`${h.name} salvo.`, "ok");
                      void reload();
                    }}
                  />
                ) : right.kind === "import" ? (
                  <SshImport
                    conn={conn}
                    onDone={(n) => {
                      setRight({ kind: "detail" });
                      if (n) note(`${n} host(s) importado(s).`, "ok");
                      void reload();
                    }}
                  />
                ) : right.kind === "files" && current ? (
                  <SshFilesPanel key={current.id} conn={conn} host={current} readOnly={readOnly} onBack={() => setRight({ kind: "detail" })} />
                ) : current ? (
                  <HostDetail
                    h={current}
                    readOnly={readOnly}
                    busy={busy}
                    onConnect={() => connect("ssh", current.id, current.name)}
                    onFiles={() => setRight({ kind: "files" })}
                    onOpenWindow={() =>
                      sftpApi
                        .openWindow(conn, current.id)
                        .then(() => note("Janela SFTP aberta.", "ok"))
                        .catch((e: Error) => note(e.message, "err"))
                    }
                    onTest={() => test(current)}
                    onEdit={() => setRight({ kind: "edit", host: current })}
                    onDuplicate={() =>
                      sshApi
                        .duplicate(conn, current.id)
                        .then((r) => {
                          setSel(r.host.id);
                          void reload();
                        })
                        .catch((e: Error) => note(e.message, "err"))
                    }
                    onForget={() => setConfirm({ kind: "forget", host: current })}
                    onDelete={() => setConfirm({ kind: "delete", host: current })}
                  />
                ) : (
                  <div className="p-4 text-[13px] text-text-3">Escolha um host à esquerda (duplo clique conecta).</div>
                )}
              </div>
            </div>
          )}
        </div>

        {msg && (
          <div
            className={cn(
              "mx-3 mb-3 flex items-start gap-2 rounded px-2 py-1.5 text-[12px]",
              msg.tone === "ok" ? "bg-status-ok/10 text-status-ok" : "bg-status-err/10 text-status-err",
            )}
          >
            <span className="min-w-0 flex-1 break-words">{msg.text}</span>
            <button className="text-text-3 hover:text-text-1" onClick={() => setMsg(null)} title="Fechar aviso">
              <X size={12} />
            </button>
          </div>
        )}
      </div>

      {confirm?.kind === "delete" && (
        <SshConfirm
          title={`Apagar o host ${confirm.host.name}?`}
          confirmLabel="Apagar"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const id = confirm.host.id;
            setConfirm(null);
            sshApi
              .remove(conn, id)
              .then(() => {
                setSel(null);
                void reload();
              })
              .catch((e: Error) => note(e.message, "err"));
          }}
        >
          O host e a senha/frase-senha salvas são apagados. Terminais já abertos continuam; a chave do servidor confirmada fica guardada.
        </SshConfirm>
      )}
      {confirm?.kind === "forget" && (
        <SshConfirm
          title="Esquecer a chave salva do servidor?"
          confirmLabel="Esquecer chave"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const h = confirm.host;
            setConfirm(null);
            sshApi
              .forgetKey(conn, h.id)
              .then((r) =>
                note(r.removed ? `Chave de ${hostTarget(h)} esquecida. A próxima conexão pede confirmação.` : "Não havia chave salva para este endereço.", "ok"),
              )
              .catch((e: Error) => note(e.message, "err"));
          }}
        >
          Use só quando o servidor foi reinstalado ou trocado e você confirmou isso com quem o administra. A próxima conexão vai mostrar a chave
          nova para você conferir.
        </SshConfirm>
      )}
      {keyIssue && <SshKeyFlow conn={conn} issue={keyIssue} onDone={() => setKeyIssue(null)} onMessage={note} />}
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-3 py-1 text-[13px]",
        active ? "bg-accent-soft font-semibold text-text-1" : "text-text-2 hover:bg-bg-hover",
      )}
    >
      {children}
    </button>
  );
}

function HostRow({ h, active, onClick, onDouble }: { h: SshHost; active: boolean; onClick: () => void; onDouble: () => void }) {
  return (
    <button
      onClick={onClick}
      onDoubleClick={onDouble}
      title="Clique para ver; duplo clique para conectar"
      className={cn("flex w-full items-center gap-2 rounded px-2 py-1 text-left", active ? "bg-accent-soft" : "hover:bg-bg-hover")}
    >
      <SshColorDot color={h.color} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-text-1">{h.name}</span>
        <span className="block truncate font-mono text-[11px] text-text-3">{hostTarget(h)}</span>
      </span>
      {h.tag && <span className="shrink-0 rounded bg-bg-hover px-1.5 text-[10px] text-text-2">{h.tag}</span>}
    </button>
  );
}

const AUTH_TEXT = { password: "senha", key: "arquivo de chave", agent: "agente SSH do Windows" };

function HostDetail(p: {
  h: SshHost;
  readOnly: boolean;
  busy: string | null;
  onConnect: () => void;
  onFiles: () => void;
  onOpenWindow: () => void;
  onTest: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onForget: () => void;
  onDelete: () => void;
}) {
  const { h } = p;
  const cred =
    h.auth === "password"
      ? h.has_password
        ? "senha salva (cifrada)"
        : "senha pedida ao conectar"
      : h.auth === "key"
        ? `${h.key_path}${h.has_passphrase ? " · frase-senha salva" : ""}`
        : "chaves do agente";
  return (
    <div className="flex h-full flex-col">
      <div className="mb-1 flex items-center gap-2">
        <SshColorDot color={h.color} />
        <div className="text-[16px] font-semibold text-text-1">{h.name}</div>
        {h.tag && <span className="rounded bg-bg-hover px-1.5 text-[11px] text-text-2">{h.tag}</span>}
      </div>
      <div className="mb-3 font-mono text-[12px] text-text-2">{hostTarget(h)}</div>
      <div className="mb-4 grid grid-cols-[110px_1fr] gap-y-1 text-[12px]">
        <span className="text-text-3">Autenticação</span>
        <span className="flex items-center gap-1 text-text-1">
          <KeyRound size={12} className="text-text-3" /> {AUTH_TEXT[h.auth]} — {cred}
        </span>
        <span className="text-text-3">Grupo</span>
        <span className="text-text-1">{h.group || "—"}</span>
        {h.initial_dir && (
          <>
            <span className="text-text-3">Pasta inicial</span>
            <span className="font-mono text-text-1">{h.initial_dir}</span>
          </>
        )}
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        <SshBtn tone="primary" disabled={p.readOnly || p.busy === `connect:${h.id}`} onClick={p.onConnect} title="Abre um terminal no Beth Studio (aba nova)">
          <Terminal size={14} /> {p.busy === `connect:${h.id}` ? "Abrindo…" : "Conectar"}
        </SshBtn>
        <SshBtn onClick={p.onFiles}>
          <FolderOpen size={14} /> Arquivos (SFTP)
        </SshBtn>
        <SshBtn onClick={p.onOpenWindow} title="Abre o SFTP numa janela Windows separada (estilo Bitvise)">
          <AppWindow size={14} /> Janela SFTP
        </SshBtn>
        <SshBtn onClick={p.onTest} disabled={p.busy === `test:${h.id}`}>
          <Plug size={14} /> {p.busy === `test:${h.id}` ? "Testando…" : "Testar conexão"}
        </SshBtn>
        <SshBtn onClick={p.onEdit} disabled={p.readOnly}>
          <Pencil size={14} /> Editar
        </SshBtn>
        <SshBtn onClick={p.onDuplicate} disabled={p.readOnly}>
          <Copy size={14} /> Duplicar
        </SshBtn>
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        <SshBtn tone="ghost" onClick={p.onForget} disabled={p.readOnly} title="Quando o servidor foi reinstalado">
          <ShieldAlert size={14} /> Esquecer chave salva…
        </SshBtn>
        <SshBtn tone="danger" onClick={p.onDelete} disabled={p.readOnly}>
          <Trash2 size={14} /> Apagar host
        </SshBtn>
      </div>
      <div className="text-[12px] text-text-3">
        O terminal roda no Beth Studio: aparece também na janela nativa e continua aberto se a interface web for fechada. Na primeira conexão ele
        mostra a impressão digital do servidor para você confirmar.
      </div>
      {h.notes && <div className="mt-3 whitespace-pre-wrap rounded bg-bg-panel p-2 text-[12px] text-text-2">{h.notes}</div>}
    </div>
  );
}

function SshImport({ conn, onDone }: { conn: SshApiClient; onDone: (imported: number) => void }) {
  const [data, setData] = useState<{ path: string; candidates: SshConfigCandidate[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  useEffect(() => {
    sshApi
      .configCandidates(conn)
      .then((r) => {
        setData(r);
        setPick(new Set(r.candidates.filter((c) => !c.exists).map((c) => c.alias)));
      })
      .catch((e: Error) => setErr(e.message));
  }, [conn]);
  const toggle = (a: string) =>
    setPick((s) => {
      const n = new Set(s);
      if (n.has(a)) n.delete(a);
      else n.add(a);
      return n;
    });
  return (
    <div className="flex h-full flex-col">
      <div className="mb-1 flex items-center">
        <div className="text-[15px] font-semibold text-text-1">Importar do ~/.ssh/config</div>
        <div className="flex-1" />
        <SshBtn tone="ghost" onClick={() => onDone(0)}>
          <X size={14} /> Cancelar
        </SshBtn>
      </div>
      {data && <div className="mb-2 font-mono text-[11px] text-text-3">{data.path}</div>}
      {err && <div className="rounded bg-status-err/10 px-2 py-1.5 text-[12px] text-status-err">{err}</div>}
      <div className="min-h-0 flex-1 overflow-auto">
        {data?.candidates.length === 0 && <div className="text-[12px] text-text-3">Nenhum “Host” encontrado no arquivo (ou o arquivo não existe).</div>}
        {data?.candidates.map((c) => (
          <label key={c.alias} className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 hover:bg-bg-hover">
            <input type="checkbox" className="mt-1" checked={pick.has(c.alias)} onChange={() => toggle(c.alias)} />
            <span className="min-w-0 flex-1">
              <span className="text-[13px] text-text-1">{c.alias}</span>
              <span className="ml-2 font-mono text-[11px] text-text-3">{hostTarget(c.host)}</span>
              {c.host.auth === "key" && <span className="ml-2 text-[11px] text-text-3">chave {c.host.key_path}</span>}
              {c.exists && <span className="ml-2 text-[11px] text-status-warn">já existe um host igual</span>}
              {c.warnings?.map((w) => (
                <span key={w} className="block text-[11px] text-status-warn">
                  {w}
                </span>
              ))}
            </span>
          </label>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <SshBtn
          tone="primary"
          disabled={!pick.size}
          onClick={() =>
            sshApi
              .configImport(conn, [...pick])
              .then((r) => {
                if (r.errors?.length) setErr(r.errors.join("; "));
                else onDone(r.imported);
              })
              .catch((e: Error) => setErr(e.message))
          }
        >
          Importar {pick.size || ""}
        </SshBtn>
      </div>
    </div>
  );
}
