import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, Cable, ChevronRight, Copy, Loader2, PanelBottom, PanelLeft, PanelRight, PanelTop, Server } from "lucide-react";
import type { PaneInfo, ShellInfo } from "@/lib/types";
import { shellKind } from "@/lib/agents";
import { SPLIT_ZONES, ZONE_LABEL, sameShellId, type SplitZone } from "@/lib/splitSpawn";
import { cn } from "@/lib/utils";
import { SHELL_ICON } from "./NewTerminalDialog";
import type { ToolKind } from "./SshScreen";
import { GlassMenu, MenuRule, menuSymbol } from "./GlassMenu";

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

  const same = sameShellId(pane, shells);
  const sameLabel = same ? (shells?.find((s) => s.id === same)?.label ?? same) : "";
  const pick = (z: SplitZone, id: string, label: string) => {
    onPick(z, id, label);
    onClose();
  };

  return (
    <GlassMenu x={x} y={y} onClose={onClose} width={280} className="max-h-[70vh] overflow-y-auto">
      {!zone && SPLIT_ZONES.map((z) => <Row key={z} icon={ZONE_ICON[z]} label={ZONE_LABEL[z]} arrow onClick={() => setZone(z)} />)}
      {zone && (
        <>
          <button
            type="button"
            data-symbol={menuSymbol("arrow-left")}
            className="flex w-full items-center gap-2 border-b border-border px-3 py-1.5 text-left font-semibold text-text-2 hover:bg-bg-hover"
            onClick={() => setZone(null)}
          >
            <span className="w-4 shrink-0" data-symbol={menuSymbol("arrow-left")}>
              <ArrowLeft size={14} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{ZONE_LABEL[zone]}</span>
            </span>
          </button>
          <Row
            icon={<Copy size={14} />}
            label="Mesmo tipo deste"
            hint={same ? `${sameLabel} · mesma pasta` : "tipo deste terminal desconhecido"}
            disabled={!same}
            onClick={() => same && pick(zone, same, sameLabel)}
          />
          <MenuRule />
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
          <MenuRule />
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
    </GlassMenu>
  );
}

function Row(p: { icon?: ReactNode; symbol?: string; label: string; hint?: string; arrow?: boolean; disabled?: boolean; onClick: () => void }) {
  const symbol = menuSymbol(p.symbol);
  return (
    <button
      type="button"
      data-symbol={symbol}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-text-1 hover:bg-bg-hover disabled:cursor-default disabled:text-text-3 disabled:hover:bg-transparent",
      )}
      disabled={p.disabled}
      onClick={p.onClick}
    >
      <span className="w-4 shrink-0" data-symbol={symbol}>{p.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{p.label}</span>
        {p.hint && <span className="block truncate text-[11px] text-text-3">{p.hint}</span>}
      </span>
      {p.arrow && <ChevronRight size={14} data-symbol="chevron.right" className="text-text-3" />}
    </button>
  );
}
