import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUp, Download, File, Folder, FolderOpen, FolderPlus, Pencil, RefreshCw, Trash2, Upload } from "lucide-react";
import { sftpApi, SshApiError, type SftpEntry, type SftpListing, type SshApiClient, type SshHost, type SshTyped } from "@/lib/sshApi";
import { breadcrumbs, formatSize, formatTime, joinRemote, validRemoteName } from "@/lib/sshUtil";
import { cn } from "@/lib/utils";
import { SshAskSecret, SshBtn, SshConfirm, SshKeyFlow, sshInput, type SshKeyIssue } from "./SshCommon";

type Pending =
  | { kind: "remove"; entry: SftpEntry }
  | { kind: "overwrite"; files: File[]; names: string[] }
  | { kind: "mkdir" }
  | { kind: "rename"; entry: SftpEntry };

interface UploadRow {
  name: string;
  state: "enviando" | "ok" | "erro";
  detail?: string;
}

/** Navegador de arquivos (SFTP) de um host salvo. Roda no bethterm-web. */
export function SshFilesPanel({ conn, host, readOnly, onBack }: { conn: SshApiClient; host: SshHost; readOnly: boolean; onBack: () => void }) {
  const [listing, setListing] = useState<SftpListing | null>(null);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err"; saved?: string } | null>(null);
  const [typed, setTyped] = useState<SshTyped>({});
  const [ask, setAsk] = useState<null | "password" | "passphrase">(null);
  const [keyIssue, setKeyIssue] = useState<SshKeyIssue | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const typedRef = useRef(typed);
  typedRef.current = typed;

  /** Erro comum: chave do servidor / credencial que falta. */
  const handleErr = useCallback(
    (e: unknown, retry: () => void) => {
      if (e instanceof SshApiError && e.result?.host_key) {
        setKeyIssue({ info: e.result.host_key, target: { id: host.id }, typed: typedRef.current, after: retry });
        return;
      }
      const m = (e as Error).message ?? String(e);
      if (/senha (necessária|recusada)/i.test(m) && host.auth === "password") {
        if (/recusada/i.test(m)) setMsg({ text: "Senha recusada pelo servidor. Tente de novo.", tone: "err" });
        return setAsk("password");
      }
      if (/frase-senha/i.test(m) && host.auth === "key") return setAsk("passphrase");
      setMsg({ text: m, tone: "err" });
    },
    [host.id, host.auth],
  );

  const load = useCallback(
    (p: string) => {
      setBusy(true);
      sftpApi
        .list(conn, host.id, p, typedRef.current)
        .then((l) => {
          setListing(l);
          setPath(l.path);
        })
        .catch((e) => handleErr(e, () => load(p)))
        .finally(() => setBusy(false));
    },
    [conn, host.id, handleErr],
  );

  useEffect(() => {
    load("");
  }, [load]);

  const refresh = () => load(path);

  const download = (e: SftpEntry) => {
    setBusy(true);
    sftpApi
      .download(conn, host.id, joinRemote(path, e.name), typed)
      .then((r) => setMsg({ text: `Baixado em ${r.saved}`, tone: "ok", saved: r.saved }))
      .catch((err) => handleErr(err, () => download(e)))
      .finally(() => setBusy(false));
  };

  const doUpload = async (files: File[], overwrite: boolean) => {
    for (const f of files) {
      setUploads((u) => [...u.filter((x) => x.name !== f.name), { name: f.name, state: "enviando" }]);
      try {
        await sftpApi.upload(conn, host.id, joinRemote(path, f.name), f, overwrite, typedRef.current);
        setUploads((u) => u.map((x) => (x.name === f.name ? { ...x, state: "ok" } : x)));
      } catch (err) {
        setUploads((u) => u.map((x) => (x.name === f.name ? { ...x, state: "erro", detail: (err as Error).message } : x)));
      }
    }
    refresh();
  };

  const startUpload = (files: File[]) => {
    if (!files.length || readOnly) return;
    const existing = new Set((listing?.entries ?? []).map((e) => e.name));
    const clash = files.filter((f) => existing.has(f.name)).map((f) => f.name);
    if (clash.length) setPending({ kind: "overwrite", files, names: clash });
    else void doUpload(files, false);
  };

  const runOp = (op: Promise<unknown>, okText: string) => {
    setBusy(true);
    op.then(() => {
      setMsg({ text: okText, tone: "ok" });
      refresh();
    })
      .catch((e) => handleErr(e, refresh))
      .finally(() => setBusy(false));
  };

  const entries = listing?.entries ?? [];
  return (
    <div
      className="relative flex h-full flex-col"
      onDragOver={(e) => {
        if (readOnly) return;
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDrag(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        startUpload([...e.dataTransfer.files]);
      }}
    >
      <div className="mb-2 flex items-center gap-2">
        <SshBtn tone="ghost" onClick={onBack} title="Voltar para o host">
          <ArrowLeft size={14} />
        </SshBtn>
        <div className="text-[14px] font-semibold text-text-1">Arquivos · {host.name}</div>
        <div className="flex-1" />
        <SshBtn onClick={() => listing?.parent && load(listing.parent)} disabled={!listing?.parent || busy} title="Pasta acima">
          <ArrowUp size={14} />
        </SshBtn>
        <SshBtn onClick={refresh} disabled={busy} title="Atualizar">
          <RefreshCw size={14} className={cn(busy && "animate-spin")} />
        </SshBtn>
        <SshBtn
          onClick={() => {
            setNameInput("");
            setPending({ kind: "mkdir" });
          }}
          disabled={readOnly || !listing}
        >
          <FolderPlus size={14} /> Nova pasta
        </SshBtn>
        <SshBtn tone="primary" onClick={() => fileRef.current?.click()} disabled={readOnly || !listing}>
          <Upload size={14} /> Enviar arquivos
        </SshBtn>
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            startUpload([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-0.5 rounded bg-bg-panel px-2 py-1 font-mono text-[12px] text-text-2">
        {breadcrumbs(path).map((b, i) => (
          <span key={b.path} className="flex items-center">
            {i > 1 && <span className="text-text-3">/</span>}
            <button className="rounded px-1 hover:bg-bg-hover hover:text-text-1" onClick={() => load(b.path)}>
              {b.label}
            </button>
          </span>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded border border-border">
        {!listing && !busy && <div className="p-4 text-[12px] text-text-3">Sem conexão.</div>}
        {listing && entries.length === 0 && <div className="p-4 text-[12px] text-text-3">Pasta vazia. Arraste arquivos para cá para enviar.</div>}
        <table className="w-full text-[12px]">
          <tbody>
            {entries.map((e) => (
              <tr
                key={e.name}
                className="group border-b border-border/60 hover:bg-bg-hover"
                onDoubleClick={() => (e.is_dir ? load(joinRemote(path, e.name)) : download(e))}
              >
                <td className="w-6 pl-2">{e.is_dir ? <Folder size={14} className="text-accent-text" /> : <File size={14} className="text-text-3" />}</td>
                <td className="max-w-0 truncate py-1 text-text-1">
                  {e.is_dir ? (
                    <button className="truncate hover:underline" onClick={() => load(joinRemote(path, e.name))}>
                      {e.name}
                    </button>
                  ) : (
                    e.name
                  )}
                  {e.is_link && <span className="ml-1 text-text-3">(link)</span>}
                </td>
                <td className="w-24 text-right text-text-2">{e.is_dir ? "" : formatSize(e.size)}</td>
                <td className="w-32 px-2 text-right text-text-3">{formatTime(e.mtime)}</td>
                <td className="w-[108px] pr-1 text-right">
                  <span className="inline-flex gap-0.5">
                    {e.is_dir ? (
                      <SshBtn tone="ghost" title="Abrir" onClick={() => load(joinRemote(path, e.name))}>
                        <FolderOpen size={13} />
                      </SshBtn>
                    ) : (
                      <SshBtn tone="ghost" title="Baixar para a pasta Downloads" onClick={() => download(e)}>
                        <Download size={13} />
                      </SshBtn>
                    )}
                    <SshBtn
                      tone="ghost"
                      title="Renomear"
                      disabled={readOnly}
                      onClick={() => {
                        setNameInput(e.name);
                        setPending({ kind: "rename", entry: e });
                      }}
                    >
                      <Pencil size={13} />
                    </SshBtn>
                    <SshBtn tone="ghost" title="Apagar" disabled={readOnly} onClick={() => setPending({ kind: "remove", entry: e })}>
                      <Trash2 size={13} className="text-status-err" />
                    </SshBtn>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {uploads.length > 0 && (
        <div className="mt-2 max-h-24 overflow-auto rounded border border-border p-1.5 text-[11px]">
          <div className="mb-1 flex items-center">
            <span className="text-text-2">Envios</span>
            <div className="flex-1" />
            <button className="text-text-3 hover:text-text-1" onClick={() => setUploads((u) => u.filter((x) => x.state === "enviando"))}>
              limpar
            </button>
          </div>
          {uploads.map((u) => (
            <div key={u.name} className="flex gap-2">
              <span className="truncate text-text-1">{u.name}</span>
              <span className={cn(u.state === "ok" && "text-status-ok", u.state === "erro" && "text-status-err", u.state === "enviando" && "text-status-busy")}>
                {u.state}
                {u.detail ? `: ${u.detail}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
      {msg && (
        <div
          className={cn(
            "mt-2 flex items-center gap-2 rounded px-2 py-1.5 text-[12px]",
            msg.tone === "ok" ? "bg-status-ok/10 text-status-ok" : "bg-status-err/10 text-status-err",
          )}
        >
          <span className="min-w-0 flex-1 break-all">{msg.text}</span>
          {msg.saved && (
            <SshBtn tone="ghost" onClick={() => void sftpApi.reveal(conn, msg.saved!).catch((e: Error) => setMsg({ text: e.message, tone: "err" }))}>
              Mostrar na pasta
            </SshBtn>
          )}
        </div>
      )}

      {drag && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded border-2 border-dashed border-accent bg-accent/10 text-[14px] text-text-1">
          Solte para enviar para {path || "a pasta atual"}
        </div>
      )}

      {pending?.kind === "remove" && (
        <SshConfirm
          title={pending.entry.is_dir ? "Apagar a pasta e tudo dentro dela?" : "Apagar este arquivo?"}
          confirmLabel="Apagar"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const e = pending.entry;
            setPending(null);
            runOp(sftpApi.remove(conn, host.id, joinRemote(path, e.name), e.is_dir, typed), `${e.name} apagado.`);
          }}
        >
          <code className="font-mono text-text-1">{joinRemote(path, pending.entry.name)}</code>
          <div className="mt-2">Isto apaga no servidor e não pode ser desfeito.</div>
        </SshConfirm>
      )}
      {pending?.kind === "overwrite" && (
        <SshConfirm
          title="Substituir arquivos no servidor?"
          confirmLabel="Substituir"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const files = pending.files;
            setPending(null);
            void doUpload(files, true);
          }}
        >
          Já existe{pending.names.length > 1 ? "m" : ""} em {path}: <b className="text-text-1">{pending.names.join(", ")}</b>. O conteúdo atual será
          perdido.
        </SshConfirm>
      )}
      {(pending?.kind === "mkdir" || pending?.kind === "rename") && (
        <div className="fixed inset-0 z-[80] flex items-start justify-center bg-black/50 pt-[16vh]" onMouseDown={() => setPending(null)}>
          <form
            className="w-[min(420px,92vw)] rounded-lg border border-border-strong bg-bg-card p-4 shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.key === "Escape" && setPending(null)}
            onSubmit={(ev) => {
              ev.preventDefault();
              const err = validRemoteName(nameInput);
              if (err) return setMsg({ text: err, tone: "err" });
              const p = pending;
              setPending(null);
              if (p.kind === "mkdir") runOp(sftpApi.mkdir(conn, host.id, joinRemote(path, nameInput.trim()), typed), "Pasta criada.");
              else if (nameInput.trim() !== p.entry.name)
                runOp(sftpApi.rename(conn, host.id, joinRemote(path, p.entry.name), joinRemote(path, nameInput.trim()), typed), "Renomeado.");
            }}
          >
            <div className="mb-2 text-[15px] font-semibold text-text-1">{pending.kind === "mkdir" ? "Nova pasta" : `Renomear ${pending.entry.name}`}</div>
            <input autoFocus className={cn(sshInput, "w-full")} value={nameInput} onChange={(e) => setNameInput(e.target.value)} />
            <div className="mt-4 flex justify-end gap-2">
              <SshBtn onClick={() => setPending(null)}>Cancelar</SshBtn>
              <SshBtn tone="primary" type="submit">
                {pending.kind === "mkdir" ? "Criar" : "Renomear"}
              </SshBtn>
            </div>
          </form>
        </div>
      )}

      {ask && (
        <SshAskSecret
          title={`Conectar a ${host.name}`}
          label={ask === "password" ? `Senha de ${host.user}@${host.host}` : "Frase-senha da chave"}
          onCancel={() => setAsk(null)}
          onSubmit={(v) => {
            const next = ask === "password" ? { ...typed, password: v } : { ...typed, passphrase: v };
            typedRef.current = next;
            setTyped(next);
            setAsk(null);
            load(path);
          }}
        />
      )}
      {keyIssue && <SshKeyFlow conn={conn} issue={keyIssue} onDone={() => setKeyIssue(null)} onMessage={(text, tone) => setMsg({ text, tone })} />}
    </div>
  );
}
