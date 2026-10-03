import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Folder,
  FolderOpen,
  HardDrive,
  RefreshCw,
  Server,
  Trash2,
  X,
} from "lucide-react";
import {
  localFsApi,
  sftpApi,
  SshApiError,
  type SftpEntry,
  type SftpJob,
  type SshHost,
  type SshTyped,
} from "@/lib/sshApi";
import { makeHttpClient } from "@/lib/httpClient";
import { formatSize } from "@/lib/sshUtil";
import { cn } from "@/lib/utils";
import { SshAskSecret, SshBtn, SshKeyFlow, type SshKeyIssue } from "./SshCommon";
import { TopResizeEdges, WindowControls } from "./WindowControls";
import { isFrameless, startDrag, useWindowState, winCommand } from "@/lib/windowFrame";

type Tab = "browse" | "upload" | "download" | "log";

const conn = makeHttpClient();

function joinLocal(dir: string, name: string) {
  if (!dir) return name;
  const sep = dir.includes("/") && !dir.includes("\\") ? "/" : "\\";
  return dir.replace(/[\\/]+$/, "") + sep + name;
}

function joinRemote(dir: string, name: string) {
  if (!dir || dir === ".") return name;
  return dir.replace(/\/+$/, "") + "/" + name;
}

function sameJobs(a: SftpJob[], b: SftpJob[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.state !== y.state ||
      x.transferred !== y.transferred ||
      x.total !== y.total ||
      x.speed_bps !== y.speed_bps ||
      x.message !== y.message
    ) {
      return false;
    }
  }
  return true;
}

function PaneList({
  title,
  icon,
  path,
  parent,
  entries,
  busy,
  selected,
  onSelect,
  onOpen,
  onUp,
  onRefresh,
  roots,
  onRoot,
}: {
  title: string;
  icon: React.ReactNode;
  path: string;
  parent: string;
  entries: SftpEntry[];
  busy: boolean;
  selected: string | null;
  onSelect: (name: string) => void;
  onOpen: (e: SftpEntry) => void;
  onUp: () => void;
  onRefresh: () => void;
  roots?: string[];
  onRoot?: (r: string) => void;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-border last:border-r-0">
      <div className="flex items-center gap-2 border-b border-border bg-bg-raised px-2 py-1.5 text-[12px] text-text-1">
        {icon}
        <span className="font-medium">{title}</span>
        <span className="min-w-0 flex-1 truncate text-text-3" title={path}>
          {path || "—"}
        </span>
        <button className="rounded p-1 text-text-3 hover:bg-bg-hover hover:text-text-1" title="Subir" onClick={onUp} disabled={!parent && !roots?.length}>
          <ArrowUp size={14} />
        </button>
        <button className="rounded p-1 text-text-3 hover:bg-bg-hover hover:text-text-1" title="Atualizar" onClick={onRefresh} disabled={busy}>
          <RefreshCw size={14} className={busy ? "animate-spin" : ""} />
        </button>
      </div>
      {roots && roots.length > 0 && (
        <div className="flex flex-wrap gap-1 border-b border-border px-2 py-1">
          {roots.map((r) => (
            <button key={r} className="rounded bg-bg-card px-1.5 py-0.5 text-[11px] text-text-2 hover:bg-bg-hover" onClick={() => onRoot?.(r)}>
              {r}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto text-[12px]">
        {entries.map((e) => (
          <button
            key={e.name}
            className={cn(
              "flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-bg-hover",
              selected === e.name && "bg-accent-soft text-accent-text",
            )}
            onClick={() => onSelect(e.name)}
            onDoubleClick={() => onOpen(e)}
          >
            {e.is_dir ? <FolderOpen size={14} className="shrink-0 text-accent" /> : <Folder size={14} className="shrink-0 opacity-40" />}
            <span className="min-w-0 flex-1 truncate">{e.name}</span>
            <span className="shrink-0 tabular-nums text-text-3">{e.is_dir ? "" : formatSize(e.size)}</span>
          </button>
        ))}
        {!entries.length && !busy && <div className="px-3 py-6 text-center text-text-3">Pasta vazia</div>}
      </div>
    </div>
  );
}

function JobTable({ jobs, onCancel }: { jobs: SftpJob[]; onCancel: (id: string) => void }) {
  if (!jobs.length) return <div className="px-3 py-6 text-center text-[12px] text-text-3">Fila vazia</div>;
  return (
    <table className="w-full text-left text-[12px]">
      <thead className="sticky top-0 bg-bg-raised text-text-3">
        <tr>
          <th className="px-2 py-1 font-medium">Estado</th>
          <th className="px-2 py-1 font-medium">Local</th>
          <th className="px-2 py-1 font-medium">Remoto</th>
          <th className="px-2 py-1 font-medium">Progresso</th>
          <th className="px-2 py-1 font-medium">Msg</th>
          <th className="px-2 py-1" />
        </tr>
      </thead>
      <tbody>
        {jobs.map((j) => {
          const pct = j.total > 0 ? Math.min(100, Math.round((100 * j.transferred) / j.total)) : j.state === "done" ? 100 : 0;
          const speed = j.speed_bps > 0 ? `${formatSize(j.speed_bps)}/s` : "";
          return (
            <tr key={j.id} className="border-t border-border">
              <td className="px-2 py-1">{j.state}</td>
              <td className="max-w-[180px] truncate px-2 py-1" title={j.local}>
                {j.local}
              </td>
              <td className="max-w-[180px] truncate px-2 py-1" title={j.remote}>
                {j.remote}
              </td>
              <td className="px-2 py-1 tabular-nums">
                {pct}% {speed && `· ${speed}`}
              </td>
              <td className="max-w-[140px] truncate px-2 py-1 text-text-3">{j.message}</td>
              <td className="px-2 py-1">
                {(j.state === "queued" || j.state === "running") && (
                  <button className="text-status-err hover:underline" onClick={() => onCancel(j.id)}>
                    Cancelar
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function SftpWindowApp() {
  const hostId = useMemo(() => new URLSearchParams(window.location.search).get("host") ?? "", []);
  const win = useWindowState();
  const [host, setHost] = useState<SshHost | null>(null);
  const hostRef = useRef<SshHost | null>(null);
  const typedRef = useRef<SshTyped>({});
  const [tab, setTab] = useState<Tab>("browse");
  const [localPath, setLocalPath] = useState("");
  const [localParent, setLocalParent] = useState("");
  const [localEntries, setLocalEntries] = useState<SftpEntry[]>([]);
  const [localRoots, setLocalRoots] = useState<string[]>([]);
  const [remotePath, setRemotePath] = useState("");
  const [remoteParent, setRemoteParent] = useState("");
  const [remoteEntries, setRemoteEntries] = useState<SftpEntry[]>([]);
  const [selLocal, setSelLocal] = useState<string | null>(null);
  const [selRemote, setSelRemote] = useState<string | null>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [jobs, setJobs] = useState<SftpJob[]>([]);
  const [typed, setTyped] = useState<SshTyped>({});
  const [ask, setAsk] = useState<null | "password" | "passphrase">(null);
  const [keyIssue, setKeyIssue] = useState<SshKeyIssue | null>(null);
  const [overwrite, setOverwrite] = useState(false);

  const pushLog = useCallback((line: string) => {
    const stamp = new Date().toLocaleTimeString();
    setLog((L) => [`[${stamp}] ${line}`, ...L].slice(0, 200));
  }, []);

  const handleErr = useCallback(
    (e: unknown, retry?: () => void) => {
      const hostNow = hostRef.current;
      const typedNow = typedRef.current;
      if (e instanceof SshApiError && e.result?.host_key && hostNow) {
        setKeyIssue({ info: e.result.host_key, target: { id: hostNow.id }, typed: typedNow, after: retry ?? (() => undefined) });
        return;
      }
      const m = (e as Error).message ?? String(e);
      if (/senha (necessária|recusada)/i.test(m) && hostNow?.auth === "password") {
        setAsk("password");
        return;
      }
      if (/frase-senha/i.test(m) && hostNow?.auth === "key") {
        setAsk("passphrase");
        return;
      }
      setMsg(m);
      pushLog(`erro: ${m}`);
    },
    [pushLog],
  );

  const loadLocal = useCallback(
    (p: string) => {
      setLocalBusy(true);
      localFsApi
        .list(conn, p)
        .then((r) => {
          setLocalPath(r.path);
          setLocalParent(r.parent);
          setLocalEntries(r.entries);
          if (r.roots) setLocalRoots(r.roots);
          setSelLocal(null);
        })
        .catch((e) => handleErr(e))
        .finally(() => setLocalBusy(false));
    },
    [handleErr],
  );

  const loadRemote = useCallback(
    (p: string) => {
      if (!hostId) return;
      setRemoteBusy(true);
      sftpApi
        .list(conn, hostId, p, typedRef.current)
        .then((r) => {
          setRemotePath(r.path);
          setRemoteParent(r.parent);
          setRemoteEntries(r.entries);
          setSelRemote(null);
        })
        .catch((e) => handleErr(e, () => loadRemote(p)))
        .finally(() => setRemoteBusy(false));
    },
    [hostId, handleErr],
  );

  useEffect(() => {
    if (!hostId) return;
    let dead = false;
    // Uma vez por host. Não depende de `host`: setHost mudava o callback e
    // esta lista recomeçava sem parar (botões piscando).
    void conn.api<{ hosts: SshHost[] }>("/api/ssh/hosts").then((r) => {
      if (dead) return;
      const h = r.hosts.find((x) => x.id === hostId) ?? null;
      hostRef.current = h;
      setHost(h);
      document.title = h ? `SFTP · ${h.user}@${h.host}:${h.port}` : `SFTP · ${hostId}`;
      loadRemote("");
    });
    loadLocal("");
    return () => {
      dead = true;
    };
  }, [hostId, loadLocal, loadRemote]);

  useEffect(() => {
    if (!hostId) return;
    let dead = false;
    const pull = () => {
      sftpApi
        .jobs(conn, hostId)
        .then((r) => {
          if (dead) return;
          const next = r.jobs ?? [];
          setJobs((prev) => (sameJobs(prev, next) ? prev : next));
        })
        .catch(() => undefined);
    };
    pull();
    const t = window.setInterval(pull, 1000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [hostId]);

  const enqueue = (direction: "upload" | "download") => {
    if (!hostId) return;
    if (direction === "upload") {
      if (!selLocal) return setMsg("Selecione um arquivo local");
      const e = localEntries.find((x) => x.name === selLocal);
      if (!e || e.is_dir) return setMsg("Só arquivos (não pastas) na fila por enquanto");
      const local = joinLocal(localPath, selLocal);
      const remote = joinRemote(remotePath, selLocal);
      sftpApi
        .enqueue(conn, { id: hostId, direction, local, remote, overwrite }, typed)
        .then(() => {
          pushLog(`enfileirado upload ${local} → ${remote}`);
          setTab("upload");
        })
        .catch((e) => handleErr(e));
    } else {
      if (!selRemote) return setMsg("Selecione um arquivo remoto");
      const e = remoteEntries.find((x) => x.name === selRemote);
      if (!e || e.is_dir) return setMsg("Só arquivos (não pastas) na fila por enquanto");
      const remote = joinRemote(remotePath, selRemote);
      const local = joinLocal(localPath, selRemote);
      sftpApi
        .enqueue(conn, { id: hostId, direction, local, remote, overwrite }, typed)
        .then(() => {
          pushLog(`enfileirado download ${remote} → ${local}`);
          setTab("download");
        })
        .catch((e) => handleErr(e));
    }
  };

  if (!hostId) {
    return <div className="flex h-full items-center justify-center text-text-2">Falta ?host=&lt;id&gt; na URL</div>;
  }

  const uploads = jobs.filter((j) => j.direction === "upload");
  const downloads = jobs.filter((j) => j.direction === "download");

  return (
    <div className="flex h-full flex-col bg-bg text-[13px] text-text-1">
      <TopResizeEdges state={win} />
      <header
        className={cn(
          "flex shrink-0 items-stretch border-b border-border bg-bg-raised pr-2 pt-1 select-none",
          isFrameless() && !win.active && "opacity-75",
        )}
      >
        <div
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2"
          onMouseDown={startDrag}
          onDoubleClick={() => isFrameless() && winCommand("toggle")}
          title={isFrameless() ? "Arraste para mover a janela; duplo clique maximiza" : undefined}
        >
          <Server size={16} className="shrink-0 text-accent" />
          <div className="min-w-0">
            <div className="truncate font-semibold">{host ? `${host.user}@${host.host}:${host.port}` : hostId}</div>
            {host?.name && <div className="truncate text-[11px] text-text-3">{host.name}</div>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 px-2" data-no-drag>
          <label className="flex items-center gap-1 text-[11px] text-text-2">
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
            Sobrescrever
          </label>
          <SshBtn onClick={() => enqueue("upload")}>
            <ArrowUp size={14} /> Upload
          </SshBtn>
          <SshBtn onClick={() => enqueue("download")}>
            <ArrowDown size={14} /> Download
          </SshBtn>
        </div>
        <WindowControls state={win} />
      </header>

      <div className="flex gap-1 border-b border-border px-2 pt-1">
        {(
          [
            ["browse", "Browse"],
            ["upload", `Upload (${uploads.length})`],
            ["download", `Download (${downloads.length})`],
            ["log", "Log"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            className={cn(
              "rounded-t px-3 py-1.5 text-[12px]",
              tab === k ? "bg-bg-card text-text-1" : "text-text-3 hover:text-text-1",
            )}
            onClick={() => setTab(k)}
          >
            {label}
          </button>
        ))}
      </div>

      {msg && (
        <div className="flex items-center gap-2 border-b border-border bg-status-err/10 px-3 py-1 text-[12px] text-status-err">
          <span className="min-w-0 flex-1">{msg}</span>
          <button onClick={() => setMsg("")}>
            <X size={12} />
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {tab === "browse" && (
          <div className="flex h-full">
            <PaneList
              title="Local"
              icon={<HardDrive size={14} />}
              path={localPath}
              parent={localParent}
              entries={localEntries}
              busy={localBusy}
              selected={selLocal}
              onSelect={setSelLocal}
              onOpen={(e) => e.is_dir && loadLocal(joinLocal(localPath, e.name))}
              onUp={() => localParent && loadLocal(localParent)}
              onRefresh={() => loadLocal(localPath)}
              roots={localRoots}
              onRoot={loadLocal}
            />
            <PaneList
              title="Remoto"
              icon={<Server size={14} />}
              path={remotePath}
              parent={remoteParent}
              entries={remoteEntries}
              busy={remoteBusy}
              selected={selRemote}
              onSelect={setSelRemote}
              onOpen={(e) => e.is_dir && loadRemote(joinRemote(remotePath, e.name))}
              onUp={() => remoteParent && loadRemote(remoteParent)}
              onRefresh={() => loadRemote(remotePath)}
            />
          </div>
        )}
        {tab === "upload" && (
          <div className="h-full overflow-auto">
            <div className="flex justify-end gap-2 border-b border-border px-2 py-1">
              <button
                className="flex items-center gap-1 text-[11px] text-text-3 hover:text-text-1"
                onClick={() => sftpApi.clearJobs(conn, hostId, true).then(() => setJobs((j) => j.filter((x) => x.state === "running" || x.state === "queued")))}
              >
                <Trash2 size={12} /> Limpar concluídos
              </button>
            </div>
            <JobTable jobs={uploads} onCancel={(id) => void sftpApi.cancelJob(conn, id)} />
          </div>
        )}
        {tab === "download" && (
          <div className="h-full overflow-auto">
            <JobTable jobs={downloads} onCancel={(id) => void sftpApi.cancelJob(conn, id)} />
          </div>
        )}
        {tab === "log" && (
          <div className="h-full overflow-auto p-2 font-mono text-[11px] text-text-2">
            {log.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
            {!log.length && <div className="text-text-3">Sem eventos ainda</div>}
          </div>
        )}
      </div>

      {ask && host && (
        <SshAskSecret
          title={ask === "password" ? "Senha SSH" : "Frase-senha da chave"}
          label={ask === "password" ? `Senha de ${host.user}@${host.host}` : "Frase-senha"}
          onCancel={() => setAsk(null)}
          onSubmit={(v) => {
            const next = ask === "password" ? { ...typedRef.current, password: v } : { ...typedRef.current, passphrase: v };
            typedRef.current = next;
            setTyped(next);
            setAsk(null);
            loadRemote(remotePath);
          }}
        />
      )}
      {keyIssue && (
        <SshKeyFlow
          conn={conn}
          issue={keyIssue}
          onDone={() => setKeyIssue(null)}
          onMessage={(m, tone) => {
            setMsg(m);
            pushLog(`${tone}: ${m}`);
          }}
        />
      )}
    </div>
  );
}
