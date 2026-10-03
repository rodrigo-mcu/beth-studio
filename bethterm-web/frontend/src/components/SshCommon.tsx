import { useEffect, useRef, useState, type ReactNode } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { sshApi, type SshApiClient, type SshHost, type SshHostKeyInfo, type SshTyped } from "@/lib/sshApi";
import { cn } from "@/lib/utils";

// Pecas comuns das telas SSH / Serial (mesmas variaveis de tema do resto).

export function SshBtn({
  children,
  onClick,
  tone = "normal",
  disabled,
  title,
  className,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: "normal" | "primary" | "danger" | "ghost";
  disabled?: boolean;
  title?: string;
  className?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-[12px] disabled:cursor-not-allowed disabled:opacity-50",
        tone === "primary" && "bg-accent font-semibold text-white hover:bg-accent-hover",
        tone === "danger" && "border border-status-err/50 text-status-err hover:bg-status-err/10",
        tone === "normal" && "bg-bg-hover text-text-1 hover:bg-border-strong",
        tone === "ghost" && "text-text-2 hover:bg-bg-hover hover:text-text-1",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function SshField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[12px] text-text-2">
      <span>{label}</span>
      {children}
      {hint && <span className="text-[11px] text-text-3">{hint}</span>}
    </label>
  );
}

export const sshInput =
  "rounded border border-border-strong bg-bg-panel px-2 py-1 text-[13px] text-text-1 outline-none focus:border-accent placeholder:text-text-3";

/** Confirmacao de acao destrutiva: Cancelar tem o foco. */
export function SshConfirm({
  title,
  children,
  confirmLabel,
  danger = true,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-black/50 pt-[16vh]" onMouseDown={onCancel}>
      <div
        role="alertdialog"
        aria-modal="true"
        className={cn("w-[min(460px,92vw)] rounded-lg border bg-bg-card p-4 shadow-2xl", danger ? "border-status-err/50" : "border-border-strong")}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
      >
        <div className="mb-2 text-[15px] font-semibold text-text-1">{title}</div>
        <div className="mb-4 text-[12px] text-text-2">{children}</div>
        <div className="flex justify-end gap-2">
          <button ref={cancelRef} className="rounded bg-bg-hover px-4 py-1.5 text-text-1 hover:bg-border" onClick={onCancel}>
            Cancelar
          </button>
          <button
            className={cn("rounded px-4 py-1.5 font-semibold text-white", danger ? "bg-[#DC2626] hover:bg-[#B91C1C]" : "bg-accent hover:bg-accent-hover")}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Chave do servidor: primeira vez (confiar?) ou diferente da salva (recusa). */
export function SshKeyDialog({
  info,
  onTrust,
  onForget,
  onClose,
}: {
  info: SshHostKeyInfo;
  onTrust: () => void;
  /** so' no caso "mudou": abre a confirmacao de esquecer a chave salva */
  onForget: () => void;
  onClose: () => void;
}) {
  if (info.mismatch) {
    return (
      <SshConfirm title="A chave do servidor mudou" confirmLabel="Esquecer chave salva…" onConfirm={onForget} onCancel={onClose}>
        <div className="mb-2 flex items-start gap-2 rounded border border-status-err/50 bg-status-err/10 p-2 text-text-1">
          <ShieldAlert size={16} className="mt-0.5 shrink-0 text-status-err" />
          <span>
            A conexão com <b>{info.addr}</b> foi recusada: a chave apresentada é diferente da que foi salva na primeira conexão.
          </span>
        </div>
        <div className="mb-1">Apresentada agora:</div>
        <code className="mb-2 block break-all rounded bg-bg-panel p-1.5 font-mono text-[11px] text-text-1">
          {info.key_type} {info.fingerprint}
        </code>
        <div className="mb-1">Salva:</div>
        <code className="mb-2 block break-all rounded bg-bg-panel p-1.5 font-mono text-[11px] text-text-1">{(info.known_fingerprints ?? []).join("\n")}</code>
        Isso acontece quando o servidor é reinstalado ou trocado — mas também é o que um ataque “homem no meio” mostraria. Confirme com quem
        administra o servidor antes de esquecer a chave salva.
      </SshConfirm>
    );
  }
  return (
    <SshConfirm title="Primeira conexão com este servidor" confirmLabel="Confiar e continuar" danger={false} onConfirm={onTrust} onCancel={onClose}>
      <div className="mb-2 flex items-start gap-2 text-text-1">
        <ShieldCheck size={16} className="mt-0.5 shrink-0 text-accent-text" />
        <span>
          A identidade de <b>{info.addr}</b> ainda não pode ser confirmada. Se tiver dúvida, confira esta impressão digital com quem administra o
          servidor:
        </span>
      </div>
      <code className="block break-all rounded bg-bg-panel p-1.5 font-mono text-[11px] text-text-1">
        {info.key_type} {info.fingerprint}
      </code>
    </SshConfirm>
  );
}

/** Pede a senha/frase-senha de um host sem credencial salva (so' memoria). */
export function SshAskSecret({
  title,
  label,
  onSubmit,
  onCancel,
}: {
  title: string;
  label: string;
  onSubmit: (v: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-black/50 pt-[16vh]" onMouseDown={onCancel}>
      <form
        className="w-[min(420px,92vw)] rounded-lg border border-border-strong bg-bg-card p-4 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
        onSubmit={(e) => {
          e.preventDefault();
          if (ref.current?.value) onSubmit(ref.current.value);
        }}
      >
        <div className="mb-2 text-[15px] font-semibold text-text-1">{title}</div>
        <SshField label={label} hint="Fica só na memória desta tela; para salvar, edite o host.">
          <input ref={ref} type="password" autoComplete="off" className={sshInput} />
        </SshField>
        <div className="mt-4 flex justify-end gap-2">
          <SshBtn onClick={onCancel}>Cancelar</SshBtn>
          <SshBtn tone="primary" type="submit">
            Continuar
          </SshBtn>
        </div>
      </form>
    </div>
  );
}

export function SshColorDot({ color }: { color?: string }) {
  return <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-border-strong" style={{ background: color || "transparent" }} />;
}

/** Pedido pendente de decisao sobre a chave do servidor. */
export interface SshKeyIssue {
  info: SshHostKeyInfo;
  /** host salvo (id) ou formulario nao salvo (host) */
  target: { id?: string; host?: Partial<SshHost> };
  typed?: SshTyped;
  /** depois de confiar (ou esquecer): refazer a operacao */
  after?: () => void;
}

/** Dialogo + acoes da chave do servidor (confiar / esquecer a salva). */
export function SshKeyFlow({
  conn,
  issue,
  onDone,
  onMessage,
}: {
  conn: SshApiClient;
  issue: SshKeyIssue;
  onDone: () => void;
  onMessage: (msg: string, tone: "ok" | "err") => void;
}) {
  const [confirmForget, setConfirmForget] = useState(false);
  if (confirmForget) {
    return (
      <SshConfirm
        title="Esquecer a chave salva?"
        confirmLabel="Esquecer chave"
        onCancel={onDone}
        onConfirm={() => {
          if (!issue.target.id) {
            onMessage("Salve o host antes de esquecer a chave.", "err");
            onDone();
            return;
          }
          sshApi
            .forgetKey(conn, issue.target.id)
            .then(() => {
              onMessage("Chave esquecida. Na próxima conexão a nova chave será mostrada para você confirmar.", "ok");
              onDone();
            })
            .catch((e: Error) => {
              onMessage(e.message, "err");
              onDone();
            });
        }}
      >
        A próxima conexão vai mostrar a chave nova e pedir confirmação. Só faça isso se tiver certeza de que o servidor foi reinstalado ou
        trocado.
      </SshConfirm>
    );
  }
  return (
    <SshKeyDialog
      info={issue.info}
      onClose={onDone}
      onForget={() => setConfirmForget(true)}
      onTrust={() => {
        sshApi
          .trust(conn, issue.target, issue.info.fingerprint, issue.typed)
          .then((r) => {
            if (r.trusted || r.ok) {
              onMessage(r.ok ? "Chave confirmada e conexão OK." : `Chave confirmada. ${r.error ?? ""}`, r.ok ? "ok" : "err");
              issue.after?.();
            } else onMessage(r.error ?? "A chave não foi confirmada.", "err");
            onDone();
          })
          .catch((e: Error) => {
            onMessage(e.message, "err");
            onDone();
          });
      }}
    />
  );
}
