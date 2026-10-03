import { useMemo, useState } from "react";
import { Check, Search, Star, X } from "lucide-react";
import type { FontInfo, ThemeInfo } from "@/lib/types";
import { cssFamily } from "@/lib/appearance";
import { cn } from "@/lib/utils";

const PAGE = 120;

function Filter({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="flex items-center gap-1.5 rounded border border-border bg-bg-term px-2 focus-within:border-accent">
      <Search size={13} className="text-text-3" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-7 min-w-0 flex-1 bg-transparent text-text-1 outline-none placeholder:text-text-3"
      />
      {value && (
        <button className="text-text-3 hover:text-text-1" title="Limpar" onClick={() => onChange("")}>
          <X size={13} />
        </button>
      )}
    </div>
  );
}

export function Swatch({ t, className }: { t: ThemeInfo; className?: string }) {
  const c = t.colors;
  return (
    <div className={cn("flex h-8 w-24 shrink-0 flex-col justify-center rounded border border-black/30 px-1.5", className)} style={{ background: c.background }}>
      <span className="font-mono text-[11px] leading-none" style={{ color: c.foreground }}>
        Aa $ ls
      </span>
      <span className="mt-1 flex gap-0.5">
        {[c.red, c.green, c.yellow, c.blue, c.magenta, c.cyan, c.brightBlack, c.white].map((d, i) => (
          <span key={i} className="h-1.5 w-1.5 rounded-full" style={{ background: d }} />
        ))}
      </span>
    </div>
  );
}

/** Lista de temas com busca; passar o mouse = previa, clicar = escolher. */
export function ThemePicker(p: {
  themes: ThemeInfo[];
  favorites: string[];
  selectedId: string;
  onHover: (t: ThemeInfo | null) => void;
  onPick: (t: ThemeInfo) => void;
}) {
  const [q, setQ] = useState("");
  const [tone, setTone] = useState<"todos" | "escuros" | "claros">("todos");
  const [limit, setLimit] = useState(PAGE);
  const favs = useMemo(() => new Set(p.favorites), [p.favorites]);
  const list = useMemo(() => {
    const n = q.trim().toLowerCase();
    const f = p.themes.filter(
      (t) => (tone === "todos" || (tone === "escuros") === t.dark) && (!n || t.name.toLowerCase().includes(n) || (t.detail ?? "").toLowerCase().includes(n)),
    );
    return [...f.filter((t) => favs.has(t.id)), ...f.filter((t) => !favs.has(t.id))];
  }, [p.themes, q, tone, favs]);
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Filter value={q} onChange={(v) => { setQ(v); setLimit(PAGE); }} placeholder="Buscar tema…" />
        </div>
        {(["todos", "escuros", "claros"] as const).map((v) => (
          <button
            key={v}
            className={cn("rounded-full px-2.5 py-0.5 text-[11px]", tone === v ? "bg-accent text-white" : "bg-bg-hover text-text-2 hover:text-text-1")}
            onClick={() => setTone(v)}
          >
            {v === "todos" ? "Todos" : v === "escuros" ? "Escuros" : "Claros"}
          </button>
        ))}
      </div>
      <div className="max-h-72 min-h-0 overflow-y-auto rounded border border-border" onMouseLeave={() => p.onHover(null)}>
        {list.slice(0, limit).map((t) => (
          <div
            key={t.id}
            role="button"
            tabIndex={0}
            className={cn("flex cursor-pointer items-center gap-2 px-2 py-1 hover:bg-bg-hover", t.id === p.selectedId && "bg-accent-soft")}
            onMouseEnter={() => p.onHover(t)}
            onClick={() => p.onPick(t)}
          >
            <Swatch t={t} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1 truncate text-text-1">
                {t.id === p.selectedId && <Check size={12} className="shrink-0 text-accent-text" />}
                <span className="truncate">{t.name}</span>
                {favs.has(t.id) && <Star size={11} className="shrink-0 text-status-warn" fill="currentColor" />}
              </div>
              <div className="truncate text-[11px] text-text-3">{t.detail}</div>
            </div>
          </div>
        ))}
        {list.length > limit && (
          <button className="m-2 w-[calc(100%-16px)] rounded bg-bg-hover py-1 text-text-1 hover:bg-border" onClick={() => setLimit(limit + PAGE)}>
            Mostrar mais ({list.length - limit})
          </button>
        )}
        {list.length === 0 && <div className="p-3 text-center text-text-3">Nenhum tema.</div>}
      </div>
    </div>
  );
}

/** Lista de fontes (monoespacadas por padrao), favoritas primeiro. */
export function FontPicker(p: { fonts: FontInfo[]; favorites: string[]; selected: string; onPick: (family: string) => void }) {
  const [q, setQ] = useState("");
  const [mono, setMono] = useState(true);
  const favs = new Set(p.favorites.map((f) => f.toLowerCase()));
  const n = q.trim().toLowerCase();
  const list = p.fonts.filter((f) => (!mono || f.mono) && (!n || f.family.toLowerCase().includes(n)));
  const sorted = [...list.filter((f) => favs.has(f.family.toLowerCase())), ...list.filter((f) => !favs.has(f.family.toLowerCase()))];
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Filter value={q} onChange={setQ} placeholder="Buscar fonte…" />
        </div>
        <button className={cn("rounded-full px-2.5 py-0.5 text-[11px]", mono ? "bg-accent text-white" : "bg-bg-hover text-text-2")} onClick={() => setMono(true)}>
          Monoespaçadas
        </button>
        <button className={cn("rounded-full px-2.5 py-0.5 text-[11px]", !mono ? "bg-accent text-white" : "bg-bg-hover text-text-2")} onClick={() => setMono(false)}>
          Todas
        </button>
      </div>
      <div className="max-h-60 overflow-y-auto rounded border border-border">
        {sorted.slice(0, 300).map((f) => (
          <div
            key={f.family}
            role="button"
            tabIndex={0}
            className={cn("flex cursor-pointer items-center gap-2 px-2 py-1 hover:bg-bg-hover", f.family.toLowerCase() === p.selected.toLowerCase() && "bg-accent-soft")}
            onClick={() => p.onPick(f.family)}
          >
            <span className="w-44 shrink-0 truncate text-text-1">{f.family}</span>
            <span className="truncate text-[14px] text-text-2" style={{ fontFamily: cssFamily(f.family) }}>
              {"Aa 0O il1 {}[] => ~/$"}
            </span>
            {favs.has(f.family.toLowerCase()) && <Star size={11} className="ml-auto shrink-0 text-status-warn" fill="currentColor" />}
          </div>
        ))}
      </div>
    </div>
  );
}
