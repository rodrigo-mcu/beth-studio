import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, Palette, Search, Star, X } from "lucide-react";
import type { DbApiClient } from "@/lib/dbApi";
import type { SettingsEvent, ThemeInfo } from "@/lib/types";
import { LIGHT, NAVY_DARK, VSCODE_DARK, applyUI, deriveUI, normalizeUIMode, uiCSSPayload, type UIColors } from "@/lib/uiTheme";
import { cn } from "@/lib/utils";
import { IconButton } from "./IconButton";
import { Swatch } from "./Pickers";

const PAGE = 120;
type Tone = "todos" | "escuros" | "claros";
type Origin = "todas" | "builtin" | "gogh" | "vscode";
const ORIGIN_LABEL: Record<ThemeInfo["source"], string> = { builtin: "BethTerm", gogh: "Gogh", vscode: "VS Code" };

/** Cores da interface a partir do que está salvo. */
function colorsFor(settings: SettingsEvent | null, themes: ThemeInfo[]): UIColors {
  const mode = normalizeUIMode(settings?.ui_theme?.mode);
  if (mode === "dark") return VSCODE_DARK;
  if (mode === "light") return LIGHT;
  if (mode === "navy") return NAVY_DARK;
  const followId = settings?.default?.theme || "";
  const id = mode === "follow" ? followId : (settings?.ui_theme?.theme_id ?? "");
  const t = themes.find((x) => x.id === id);
  return t ? deriveUI(t) : VSCODE_DARK;
}

/**
 * Mesmo painel de temas do terminal: busca, filtros, amostras e clique
 * para aplicar. Clicar fora fecha. Aqui o tema escolhido pinta a interface
 * (esta janela e o Beth Studio).
 */
export function DbThemeButton({ conn }: { conn: DbApiClient }) {
  const button = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<SettingsEvent | null>(null);
  const [themes, setThemes] = useState<ThemeInfo[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [tone, setTone] = useState<Tone>("todos");
  const [origin, setOrigin] = useState<Origin>("todas");
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => {
    let live = true;
    void conn
      .api<SettingsEvent>("/api/settings")
      .then((s) => {
        if (live) setSettings(s);
      })
      .catch((e: unknown) => {
        if (live) setErr(e instanceof Error ? e.message : "não foi possível ler o tema");
      });
    void conn
      .api<{ themes: ThemeInfo[] }>("/api/themes")
      .then((r) => {
        if (live) setThemes(r.themes ?? []);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [conn]);

  const close = () => {
    setOpen(false);
    applyUI(colorsFor(settings, themes));
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const n = e.target as Node;
      if (button.current?.contains(n) || panel.current?.contains(n)) return;
      setOpen(false);
      applyUI(colorsFor(settings, themes));
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [open, settings, themes]);

  const selectedId = normalizeUIMode(settings?.ui_theme?.mode) === "theme" ? (settings?.ui_theme?.theme_id ?? "") : "";
  const favs = useMemo(() => new Set(settings?.theme_favorites ?? []), [settings]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return themes.filter(
      (t) =>
        (tone === "todos" || (tone === "escuros") === t.dark) &&
        (origin === "todas" || t.source === origin) &&
        (!needle || t.name.toLowerCase().includes(needle) || (t.detail ?? "").toLowerCase().includes(needle)),
    );
  }, [themes, q, tone, origin]);
  const favList = filtered.filter((t) => favs.has(t.id));

  const paint = (t: ThemeInfo | null) => applyUI(t ? deriveUI(t) : colorsFor(settings, themes));

  const save = (t: ThemeInfo) => {
    setErr(null);
    void conn
      .api<SettingsEvent>("/api/settings/ui", { mode: "theme", theme_id: t.id })
      .then((s) => {
        setSettings(s);
        const c = deriveUI(t);
        applyUI(c);
        void conn.api("/api/settings/ui-css", uiCSSPayload(c)).catch(() => undefined);
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "não foi possível salvar o tema"));
  };

  const star = (t: ThemeInfo) => {
    const favorite = !favs.has(t.id);
    void conn
      .api<SettingsEvent>("/api/favorites/theme", { id: t.id, favorite })
      .then((s) => setSettings(s))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "não foi possível favoritar"));
  };

  const row = (t: ThemeInfo) => (
    <div
      key={t.id}
      role="button"
      tabIndex={0}
      className={cn("group flex cursor-pointer items-center gap-2 px-2 py-1.5 hover:bg-bg-hover", t.id === selectedId && "bg-accent-soft")}
      onMouseEnter={() => paint(t)}
      onClick={() => save(t)}
      title={`${t.name}${t.detail ? ` — ${t.detail}` : ""}\nClique para aplicar`}
    >
      <Swatch t={t} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 truncate text-text-1">
          {t.id === selectedId && <Check size={12} className="shrink-0 text-accent-text" />}
          <span className="truncate">{t.name}</span>
        </div>
        <div className="truncate text-[11px] text-text-3">{t.detail ?? ORIGIN_LABEL[t.source]}</div>
      </div>
      <button
        className={cn("shrink-0 rounded p-1 hover:bg-bg-card", favs.has(t.id) ? "text-status-warn" : "text-text-3 opacity-60 group-hover:opacity-100")}
        title={favs.has(t.id) ? "Tirar tema dos favoritos" : "Favoritar tema"}
        onClick={(e) => {
          e.stopPropagation();
          star(t);
        }}
      >
        <Star size={15} fill={favs.has(t.id) ? "currentColor" : "none"} />
      </button>
    </div>
  );

  return (
    <div ref={button} className="relative flex items-center self-center" data-no-drag>
      <IconButton label="Tema da interface" active={open} onClick={() => (open ? close() : setOpen(true))}>
        <Palette size={15} />
      </IconButton>
      {open &&
        createPortal(
          <div
            ref={panel}
            className="fixed bottom-2 right-2 top-12 z-[80] flex w-[400px] max-w-[calc(100%-16px)] flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-card shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
              <span className="rounded bg-accent-soft px-3 py-1 text-[13px] font-semibold text-text-1">Tema</span>
              <div className="flex-1" />
              <button className="rounded p-1 text-text-2 hover:bg-bg-hover hover:text-text-1" title="Fechar" onClick={close}>
                <X size={15} />
              </button>
            </div>
            <div className="space-y-2 border-b border-border p-2">
              <div className="flex items-center gap-1.5 rounded border border-border bg-bg-term px-2">
                <Search size={13} className="text-text-3" />
                <input
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value);
                    setLimit(PAGE);
                  }}
                  placeholder="Buscar tema…"
                  className="h-7 min-w-0 flex-1 bg-transparent text-text-1 outline-none placeholder:text-text-3"
                />
                {q && (
                  <button className="text-text-3 hover:text-text-1" title="Limpar busca" onClick={() => setQ("")}>
                    <X size={13} />
                  </button>
                )}
              </div>
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
            <div className="min-h-0 flex-1 overflow-y-auto" onMouseLeave={() => paint(null)}>
              {themes.length === 0 && <div className="p-3 text-text-2">Carregando temas…</div>}
              {favList.length > 0 && (
                <>
                  <SectionTitle>Favoritos</SectionTitle>
                  {favList.map(row)}
                </>
              )}
              {themes.length > 0 && (
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
                  {filtered.length === 0 && <div className="p-3 text-center text-text-3">Nenhum tema.</div>}
                </>
              )}
            </div>
            {err && <div className="border-t border-border px-3 py-2 text-[11px] text-status-err">{err}</div>}
          </div>,
          document.body,
        )}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      className={cn("rounded-full px-2.5 py-0.5 text-[11px]", active ? "bg-accent text-white" : "bg-bg-hover text-text-2 hover:text-text-1")}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="sticky top-0 z-10 bg-bg-card px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-text-2">{children}</div>;
}
