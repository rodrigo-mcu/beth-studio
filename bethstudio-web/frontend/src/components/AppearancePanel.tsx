import { useMemo, useState, type ReactNode } from "react";
import { Check, Minus, Plus, RotateCcw, Search, Star, X } from "lucide-react";
import type { Connection } from "@/lib/connection";
import type { SettingsEvent, ThemeInfo } from "@/lib/types";
import {
  cssFamily,
  type Catalog,
  type Effective,
  loadCatalog,
  resolveFamily,
  setDefault,
  setFontFavorite,
  setPane,
  setThemeFavorite,
} from "@/lib/appearance";
import { cn } from "@/lib/utils";

export interface Preview {
  themeId?: string;
  family?: string;
}

interface Props {
  conn: Connection;
  paneId: number;
  catalog: Catalog;
  settings: SettingsEvent | null;
  eff: Effective;
  onPreview: (p: Preview | null) => void;
  onClose: () => void;
  onMessage: (msg: string) => void;
}

const PAGE = 120;
type Tab = "tema" | "fonte";
type Tone = "todos" | "escuros" | "claros";
type Origin = "todas" | "builtin" | "gogh" | "vscode";

const ORIGIN_LABEL: Record<ThemeInfo["source"], string> = { builtin: "Beth Studio", gogh: "Gogh", vscode: "VS Code" };

/** Painel "Aparencia" de um terminal: tema, fonte e tamanho. */
export function AppearancePanel({ conn, paneId, catalog, settings, eff, onPreview, onClose, onMessage }: Props) {
  const [tab, setTab] = useState<Tab>("tema");
  const run = (p: Promise<unknown>, ok?: string) =>
    p.then(() => ok && onMessage(ok)).catch((e: Error) => onMessage(`Erro: ${e.message}`));

  return (
    <div
      data-own-wheel
      className="absolute bottom-2 right-2 top-2 z-40 flex w-[400px] max-w-[calc(100%-16px)] flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-card shadow-2xl"
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <TabButton active={tab === "tema"} onClick={() => setTab("tema")}>
          Tema
        </TabButton>
        <TabButton active={tab === "fonte"} onClick={() => setTab("fonte")}>
          Fonte
        </TabButton>
        <div className="flex-1" />
        <button
          className="rounded px-2 py-1 text-[11px] text-text-2 hover:bg-bg-hover hover:text-text-1"
          title="Ler de novo as pastas de temas e as fontes instaladas"
          onClick={() => run(loadCatalog(conn, true), "Listas atualizadas")}
        >
          Atualizar listas
        </button>
        <button className="rounded p-1 text-text-2 hover:bg-bg-hover hover:text-text-1" title="Fechar" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      {catalog.error && <div className="px-3 py-2 text-status-err">Erro ao carregar: {catalog.error}</div>}
      {settings?.gui_favorites_error && (
        <div className="px-3 py-1.5 text-[11px] text-status-warn">
          Favoritos da GUI ilegíveis ({settings.gui_favorites_error}); não vou gravar nesse arquivo.
        </div>
      )}
      {tab === "tema" ? (
        <ThemeTab conn={conn} paneId={paneId} catalog={catalog} settings={settings} eff={eff} onPreview={onPreview} run={run} />
      ) : (
        <FontTab conn={conn} paneId={paneId} catalog={catalog} settings={settings} eff={eff} onPreview={onPreview} run={run} />
      )}
    </div>
  );
}

interface TabProps {
  conn: Connection;
  paneId: number;
  catalog: Catalog;
  settings: SettingsEvent | null;
  eff: Effective;
  onPreview: (p: Preview | null) => void;
  run: (p: Promise<unknown>, ok?: string) => void;
}

function ThemeTab({ conn, paneId, catalog, settings, eff, onPreview, run }: TabProps) {
  const [q, setQ] = useState("");
  const [tone, setTone] = useState<Tone>("todos");
  const [origin, setOrigin] = useState<Origin>("todas");
  const [limit, setLimit] = useState(PAGE);
  const favs = useMemo(() => new Set(settings?.theme_favorites ?? []), [settings]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (catalog.themes ?? []).filter(
      (t) =>
        (tone === "todos" || (tone === "escuros") === t.dark) &&
        (origin === "todas" || t.source === origin) &&
        (!needle || t.name.toLowerCase().includes(needle) || (t.detail ?? "").toLowerCase().includes(needle)),
    );
  }, [catalog.themes, q, tone, origin]);
  const favList = filtered.filter((t) => favs.has(t.id));
  const defTheme = settings?.default?.theme || "";

  const row = (t: ThemeInfo) => (
    <ThemeRow
      key={t.id}
      t={t}
      current={t.id === eff.themeId}
      isDefault={t.id === defTheme}
      fav={favs.has(t.id)}
      onEnter={() => onPreview({ themeId: t.id })}
      onApply={() => run(setPane(conn, paneId, { theme: t.id }), `Tema "${t.name}" aplicado a este terminal`)}
      onStar={() => run(setThemeFavorite(conn, t.id, !favs.has(t.id)))}
    />
  );

  return (
    <>
      <div className="space-y-2 border-b border-border p-2">
        <SearchBox value={q} onChange={(v) => { setQ(v); setLimit(PAGE); }} placeholder="Buscar tema…" />
        <div className="flex flex-wrap gap-1">
          {(["todos", "escuros", "claros"] as Tone[]).map((v) => (
            <Chip key={v} active={tone === v} onClick={() => setTone(v)}>
              {v === "todos" ? "Todos" : v === "escuros" ? "Escuros" : "Claros"}
            </Chip>
          ))}
          <span className="mx-1 w-px bg-border" />
          {(["todas", "builtin", "vscode", "gogh"] as Origin[]).map((v) => (
            <Chip key={v} active={origin === v} onClick={() => setOrigin(v)}>
              {v === "todas" ? "Todas as origens" : ORIGIN_LABEL[v]}
            </Chip>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" onMouseLeave={() => onPreview(null)}>
        {!catalog.themes && <div className="p-3 text-text-2">Carregando temas…</div>}
        {favList.length > 0 && (
          <>
            <SectionTitle>Favoritos</SectionTitle>
            {favList.map(row)}
          </>
        )}
        {catalog.themes && (
          <>
            <SectionTitle>
              Todos os temas <span className="font-normal text-text-3">({filtered.length})</span>
            </SectionTitle>
            {filtered.slice(0, limit).map(row)}
            {filtered.length > limit && (
              <button className="m-2 w-[calc(100%-16px)] rounded bg-bg-hover py-1.5 text-text-1 hover:bg-border" onClick={() => setLimit(limit + PAGE)}>
                Mostrar mais ({filtered.length - limit} restantes)
              </button>
            )}
          </>
        )}
      </div>
      <Footer>
        <FooterButton
          onClick={() => run(setDefault(conn, { theme: eff.themeId }), "Tema padrão atualizado")}
          disabled={!eff.themeId}
          title="Terminais sem tema próprio passam a usar este tema"
        >
          <Check size={13} /> Usar como padrão
        </FooterButton>
        <FooterButton
          onClick={() => run(setPane(conn, paneId, { theme: "" }), "Este terminal voltou ao tema padrão")}
          disabled={!eff.paneTheme}
          title="Remove o tema próprio deste terminal"
        >
          <RotateCcw size={13} /> Voltar ao padrão
        </FooterButton>
      </Footer>
    </>
  );
}

function ThemeRow(p: {
  t: ThemeInfo;
  current: boolean;
  isDefault: boolean;
  fav: boolean;
  onEnter: () => void;
  onApply: () => void;
  onStar: () => void;
}) {
  const c = p.t.colors;
  const dots = [c.red, c.green, c.yellow, c.blue, c.magenta, c.cyan, c.brightBlack, c.white];
  return (
    <div
      role="button"
      tabIndex={0}
      className={cn("group flex cursor-pointer items-center gap-2 px-2 py-1.5 hover:bg-bg-hover", p.current && "bg-accent-soft")}
      onMouseEnter={p.onEnter}
      onClick={p.onApply}
      title={`${p.t.name}${p.t.detail ? ` — ${p.t.detail}` : ""}\nClique para aplicar a este terminal`}
    >
      <div className="flex h-8 w-24 shrink-0 flex-col justify-center rounded border border-black/30 px-1.5" style={{ background: c.background }}>
        <span className="font-mono text-[11px] leading-none" style={{ color: c.foreground }}>
          Aa $ ls
        </span>
        <span className="mt-1 flex gap-0.5">
          {dots.map((d, i) => (
            <span key={i} className="h-1.5 w-1.5 rounded-full" style={{ background: d }} />
          ))}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 truncate text-text-1">
          {p.current && <Check size={12} className="shrink-0 text-accent-text" />}
          <span className="truncate">{p.t.name}</span>
          {p.isDefault && <span className="shrink-0 rounded bg-bg-hover px-1 text-[10px] text-text-2">padrão</span>}
        </div>
        <div className="truncate text-[11px] text-text-3">{p.t.detail ?? ORIGIN_LABEL[p.t.source]}</div>
      </div>
      <StarButton on={p.fav} onClick={p.onStar} what="tema" />
    </div>
  );
}

function FontTab({ conn, paneId, catalog, settings, eff, onPreview, run }: TabProps) {
  const [q, setQ] = useState("");
  const [monoOnly, setMonoOnly] = useState(true);
  const [limit, setLimit] = useState(PAGE);
  const favs = useMemo(() => new Set((settings?.font_favorites ?? []).map((f) => f.toLowerCase())), [settings]);
  const fonts = catalog.fonts ?? [];
  const needle = q.trim().toLowerCase();
  const match = (f: string) => !needle || f.toLowerCase().includes(needle);
  const filtered = fonts.filter((f) => (!monoOnly || f.mono) && match(f.family));
  const favList = (settings?.font_favorites ?? []).filter(match);
  const presets = catalog.presets.filter((p) => p.family && match(p.family));
  const defFamily = settings?.default?.font_family || "";

  const apply = (family: string) => run(setPane(conn, paneId, { font_family: family }), `Fonte "${family}" aplicada a este terminal`);
  const row = (family: string, key: string, extra?: ReactNode) => (
    <div
      key={key}
      role="button"
      tabIndex={0}
      className={cn(
        "group flex cursor-pointer items-center gap-2 px-2 py-1.5 hover:bg-bg-hover",
        family.toLowerCase() === eff.family.toLowerCase() && "bg-accent-soft",
      )}
      onMouseEnter={() => onPreview({ family })}
      onClick={() => apply(family)}
      title={`${family}\nClique para aplicar a este terminal`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 text-text-1">
          {family.toLowerCase() === eff.family.toLowerCase() && <Check size={12} className="shrink-0 text-accent-text" />}
          <span className="truncate">{family}</span>
          {family === defFamily && <span className="shrink-0 rounded bg-bg-hover px-1 text-[10px] text-text-2">padrão</span>}
          {extra}
        </div>
        <div className="truncate text-[14px] text-text-2" style={{ fontFamily: cssFamily(family) }}>
          {"Aa 0O il1| {}[] => ~/$"}
        </div>
      </div>
      <StarButton on={favs.has(family.toLowerCase())} onClick={() => run(setFontFavorite(conn, family, !favs.has(family.toLowerCase())))} what="fonte" />
    </div>
  );

  const size = eff.size;
  const setSize = (v: number) => run(setPane(conn, paneId, { font_size: v }));
  const resolved = resolveFamily(eff.family);
  return (
    <>
      <div className="space-y-2 border-b border-border p-2">
        <div className="text-[12px] text-text-2">
          Em uso: <span className="font-semibold text-text-1" style={{ fontFamily: cssFamily(resolved.used) }}>{resolved.used}</span>
          {resolved.missing && (
            <div className="mt-0.5 text-status-warn">
              “{eff.family}” não encontrada — usando {resolved.used}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-text-2">Tamanho</span>
          <Chip active={size === 0} onClick={() => setSize(0)}>
            Automático
          </Chip>
          <div className="flex items-center overflow-hidden rounded border border-border">
            <button className="p-1 text-text-2 hover:bg-bg-hover hover:text-text-1" title="Diminuir" onClick={() => setSize(Math.max(5, (size || 14) - 1))}>
              <Minus size={13} />
            </button>
            <span className="w-12 text-center font-mono text-text-1">{size ? size : "auto"}</span>
            <button className="p-1 text-text-2 hover:bg-bg-hover hover:text-text-1" title="Aumentar" onClick={() => setSize(Math.min(48, (size || 13) + 1))}>
              <Plus size={13} />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Chip active={!eff.bold} onClick={() => run(setPane(conn, paneId, { font_bold: false }))}>
            Normal
          </Chip>
          <Chip active={eff.bold} onClick={() => run(setPane(conn, paneId, { font_bold: true }))}>
            <b>Negrito</b>
          </Chip>
          {!eff.paneBold && <span className="text-[11px] text-text-3">(herdado{settings?.gui_default_bold ? " da GUI" : ""})</span>}
        </div>
        <SearchBox value={q} onChange={(v) => { setQ(v); setLimit(PAGE); }} placeholder="Buscar fonte…" />
        <div className="flex gap-1">
          <Chip active={monoOnly} onClick={() => setMonoOnly(true)}>
            Só monoespaçadas
          </Chip>
          <Chip active={!monoOnly} onClick={() => setMonoOnly(false)}>
            Todas
          </Chip>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" onMouseLeave={() => onPreview(null)}>
        {!catalog.fonts && <div className="p-3 text-text-2">Carregando fontes…</div>}
        {favList.length > 0 && (
          <>
            <SectionTitle>Favoritas</SectionTitle>
            {favList.map((f) => row(f, `fav-${f}`))}
          </>
        )}
        {presets.length > 0 && (
          <>
            <SectionTitle>Sugestões</SectionTitle>
            {presets.map((p) =>
              row(p.family, `pre-${p.label}`, p.label !== p.family ? <span className="shrink-0 text-[10px] text-text-3">({p.label})</span> : undefined),
            )}
          </>
        )}
        {catalog.fonts && (
          <>
            <SectionTitle>
              Fontes instaladas <span className="font-normal text-text-3">({filtered.length})</span>
            </SectionTitle>
            {filtered.slice(0, limit).map((f) => row(f.family, `all-${f.family}`))}
            {filtered.length > limit && (
              <button className="m-2 w-[calc(100%-16px)] rounded bg-bg-hover py-1.5 text-text-1 hover:bg-border" onClick={() => setLimit(limit + PAGE)}>
                Mostrar mais ({filtered.length - limit} restantes)
              </button>
            )}
          </>
        )}
      </div>
      <Footer>
        <FooterButton
          onClick={() => run(setDefault(conn, { font_family: eff.family, font_size: eff.size, font_bold: eff.bold }), "Fonte padrão atualizada")}
          title="Terminais sem fonte própria passam a usar esta fonte e tamanho"
        >
          <Check size={13} /> Usar como padrão
        </FooterButton>
        <FooterButton
          onClick={() => run(setPane(conn, paneId, { font_family: "", font_size: 0, font_bold: undefined }), "Este terminal voltou à fonte padrão")}
          disabled={!eff.paneFont && !eff.paneSize && !eff.paneBold}
          title="Remove a fonte e o tamanho próprios deste terminal"
        >
          <RotateCcw size={13} /> Voltar ao padrão
        </FooterButton>
      </Footer>
    </>
  );
}

// --- pecas -------------------------------------------------------------

function StarButton({ on, onClick, what }: { on: boolean; onClick: () => void; what: string }) {
  return (
    <button
      className={cn("shrink-0 rounded p-1 hover:bg-bg-card", on ? "text-status-warn" : "text-text-3 opacity-60 group-hover:opacity-100")}
      title={on ? `Tirar ${what} dos favoritos` : `Favoritar ${what}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <Star size={15} fill={on ? "currentColor" : "none"} />
    </button>
  );
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="flex items-center gap-1.5 rounded border border-border bg-bg-term px-2">
      <Search size={13} className="text-text-3" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-7 min-w-0 flex-1 bg-transparent text-text-1 outline-none placeholder:text-text-3"
      />
      {value && (
        <button className="text-text-3 hover:text-text-1" title="Limpar busca" onClick={() => onChange("")}>
          <X size={13} />
        </button>
      )}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      className={cn(
        "rounded-full px-2.5 py-0.5 text-[11px]",
        active ? "bg-accent text-white" : "bg-bg-hover text-text-2 hover:text-text-1",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      className={cn("rounded px-3 py-1 text-[13px]", active ? "bg-accent-soft font-semibold text-text-1" : "text-text-2 hover:bg-bg-hover")}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="sticky top-0 z-10 bg-bg-card px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-text-2">{children}</div>;
}

function Footer({ children }: { children: ReactNode }) {
  return <div className="flex gap-2 border-t border-border p-2">{children}</div>;
}

function FooterButton({ onClick, disabled, title, children }: { onClick: () => void; disabled?: boolean; title: string; children: ReactNode }) {
  return (
    <button
      className="flex flex-1 items-center justify-center gap-1.5 rounded bg-bg-hover py-1.5 text-text-1 hover:bg-border disabled:opacity-40"
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}
