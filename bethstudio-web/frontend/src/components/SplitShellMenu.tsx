import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, Cable, ChevronRight, Copy, Loader2, PanelBottom, PanelLeft, PanelRight, PanelTop, Server } from "lucide-react";
import type { PaneInfo, ShellInfo } from "@/lib/types";
import { shellKind } from "@/lib/agents";
import { SPLIT_ZONES, ZONE_LABEL, sameShellId, type SplitZone } from "@/lib/splitSpawn";
import { SHELL_ICON } from "./NewTerminalDialog";
import type { ToolKind } from "./SshScreen";

export const ZONE_ICON: Record<SplitZone, ReactNode> = {
  right: <PanelRight size={14} />,
  bottom: <PanelBottom size={14} />,
  top: <PanelTop size={14} />,
  left: <PanelLeft size={14} />,
};

interface Props {
  pane: PaneInfo | undefined;
  x: number;
  y: number;
  /** direcao ja' escolhida (vem direto para a lista de shells) */
  zone?: SplitZone;
  shells: ShellInfo[] | null;
  requestShells: () => void;
  onPick: (zone: SplitZone, shellId: string, label: string) => void;
  /** SSH ou serial: abre a tela de hosts/portas e o terminal nasce neste split */
  onOpenTool: (zone: SplitZone, kind: ToolKind) => void;
  onClose: () => void;
}

/** "Novo terminal à direita/abaixo/acima/à esquerda" → escolha do shell. */
export function SplitShellMenu({ pane, x, y, zone: initialZone, shells, requestShells, onPick, onOpenTool, onClose }: Props) {
  const [zone, setZone] = useState<SplitZone | null>(initialZone ?? null);

  useEffect(() => {
    requestShells();
  }, [requestShells]);

  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
    };
  }, [onClose]);

  const same = sameShellId(pane, shells);
  const sameLabel = same ? (shells?.find((s) => s.id === same)?.label ?? same) : "";
  const pick = (z: SplitZone, id: string, label: string) => {
    onPick(z, id, label);
    onClose();
  };

  return (
    <div
      className="fixed z-50 w-[280px] overflow-y-auto rounded-md border border-border-strong bg-bg-card py-1 shadow-xl"
      style={(() => {
        // a lista de shells cabe inteira na janela (sobe se precisar)
        const top = Math.max(8, Math.min(y, window.innerHeight - 420));
        return { left: Math.max(8, Math.min(x, window.innerWidth - 290)), top, maxHeight: window.innerHeight - top - 8 };
      })()}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {!zone && SPLIT_ZONES.map((z) => <Row key={z} icon={ZONE_ICON[z]} label={ZONE_LABEL[z]} arrow onClick={() => setZone(z)} />)}
      {zone && (
        <>
          <button
            className="flex w-full items-center gap-2 border-b border-border px-3 py-1.5 text-left font-semibold text-text-2 hover:bg-bg-hover"
            onClick={() => setZone(null)}
          >
            <ArrowLeft size={14} /> {ZONE_LABEL[zone]}
          </button>
          <Row
            icon={<Copy size={14} />}
            label="Mesmo tipo deste"
            hint={same ? `${sameLabel} · mesma pasta` : "tipo deste terminal desconhecido"}
            disabled={!same}
            onClick={() => same && pick(zone, same, sameLabel)}
          />
          <div className="my-1 border-t border-border" />
          {!shells && (
            <div className="flex items-center gap-2 px-3 py-1.5 text-text-2">
              <Loader2 size={14} className="animate-spin" /> Buscando tipos de terminal…
            </div>
          )}
          {(shells ?? []).map((s) => {
            const Icon = SHELL_ICON[shellKind(s.id)];
            return (
              <Row key={s.id} icon={<Icon size={14} className="text-accent-text" />} label={s.label} onClick={() => pick(zone, s.id, s.label)} />
            );
          })}
          <div className="my-1 border-t border-border" />
          <Row
            icon={<Server size={14} className="text-accent-text" />}
            label="SSH…"
            hint="Host remoto"
            onClick={() => onOpenTool(zone, "ssh")}
          />
          <Row
            icon={<Cable size={14} className="text-accent-text" />}
            label="Serial…"
            hint="Porta COM"
            onClick={() => onOpenTool(zone, "serial")}
          />
        </>
      )}
    </div>
  );
}

function Row(p: { icon?: ReactNode; label: string; hint?: string; arrow?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-text-1 hover:bg-bg-hover disabled:cursor-default disabled:text-text-3 disabled:hover:bg-transparent"
      disabled={p.disabled}
      onClick={p.onClick}
    >
      <span className="w-4 shrink-0">{p.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{p.label}</span>
        {p.hint && <span className="block truncate text-[11px] text-text-3">{p.hint}</span>}
      </span>
      {p.arrow && <ChevronRight size={14} className="text-text-3" />}
    </button>
  );
}
