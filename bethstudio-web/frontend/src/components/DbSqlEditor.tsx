import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { DbDriver } from "@/lib/dbApi";
import { completeSql, type SqlCatalog, type SqlCompleteItem } from "@/lib/dbSqlComplete";
import { findSpans, replaceAllText } from "@/lib/dbSqlFormat";
import { highlightSql, type SqlTokClass } from "@/lib/dbSqlHighlight";

/**
 * Editor de SQL leve: <textarea> transparente por cima de um <pre> com o
 * realce. Sem dependências. Ctrl+Enter executa; Tab insere 2 espaços;
 * o texto selecionado (se houver) é o que roda.
 */
export interface DbSqlEditorHandle {
  /** Texto selecionado, ou tudo quando nada está selecionado. */
  runnableText: () => { text: string; selection: boolean };
  focus: () => void;
  insert: (text: string) => void;
  openFind: () => void;
  /** Troca a seleção, ou o texto inteiro quando não há seleção. */
  replaceRunnable: (text: string) => void;
}

function compStyle(value: string, start: number, ta: HTMLTextAreaElement | null) {
  const before = value.slice(0, start);
  const line = before.split("\n").length - 1;
  const col = before.length - (before.lastIndexOf("\n") + 1);
  let top = 8 + line * 20 - (ta?.scrollTop ?? 0) + 20;
  let left = 8 + Math.round(col * 7.8) - (ta?.scrollLeft ?? 0);
  const h = ta?.clientHeight ?? 200;
  const w = ta?.clientWidth ?? 320;
  if (left > w - 288) left = Math.max(8, w - 288);
  if (left < 4) left = 4;
  if (top > h * 0.55) return { bottom: Math.max(4, h - top + 18), left };
  if (top < 4) top = 4;
  return { top, left };
}

const KIND: Record<SqlCompleteItem["kind"], string> = {
  keyword: "palavra",
  fn: "função",
  table: "tabela",
  view: "view",
  column: "coluna",
  schema: "schema",
};

const CLS: Record<SqlTokClass, string> = {
  kw: "text-accent-text font-semibold",
  fn: "text-[#dcdcaa]",
  str: "text-[#ce9178]",
  ident: "text-[#9cdcfe]",
  num: "text-[#b5cea8]",
  com: "text-text-3 italic",
  param: "text-[#c586c0]",
  op: "text-text-2",
  text: "text-text-1",
};

export const DbSqlEditor = forwardRef<
  DbSqlEditorHandle,
  {
    value: string;
    onChange: (v: string) => void;
    driver: DbDriver;
    onRun: () => void;
    disabled?: boolean;
    catalog?: SqlCatalog;
    onMissing?: (missing: { schema: string; table: string }[]) => void;
  }
>(function DbSqlEditor({ value, onChange, driver, onRun, disabled, catalog, onMissing }, ref) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [needle, setNeedle] = useState("");
  const [repl, setRepl] = useState("");
  const [findAt, setFindAt] = useState(0);
  const [comp, setComp] = useState<SqlCompleteItem[] | null>(null);
  const [compStart, setCompStart] = useState(0);
  const [hi, setHi] = useState(0);
  const [focused, setFocused] = useState(false);
  const cursorRef = useRef(0);
  const escAt = useRef<number | null>(null);
  const forceRef = useRef(false);
  const [tick, setTick] = useState(0);
  const missRef = useRef(onMissing);
  missRef.current = onMissing;

  const segs = useMemo(() => highlightSql(value, driver), [value, driver]);
  const lines = useMemo(() => Math.max(1, value.split("\n").length), [value]);

  const syncScroll = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    if (preRef.current) {
      preRef.current.scrollTop = ta.scrollTop;
      preRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
  }, []);

  const insertAtCursor = useCallback(
    (text: string) => {
      const ta = taRef.current;
      if (!ta) {
        onChange(value + text);
        return;
      }
      const a = ta.selectionStart;
      const b = ta.selectionEnd;
      const next = value.slice(0, a) + text + value.slice(b);
      onChange(next);
      requestAnimationFrame(() => {
        ta.focus();
        ta.selectionStart = ta.selectionEnd = a + text.length;
      });
    },
    [onChange, value],
  );

  useImperativeHandle(
    ref,
    () => ({
      runnableText: () => {
        const ta = taRef.current;
        if (ta && ta.selectionEnd > ta.selectionStart) {
          const sel = value.slice(ta.selectionStart, ta.selectionEnd);
          if (sel.trim()) return { text: sel, selection: true };
        }
        return { text: value, selection: false };
      },
      focus: () => taRef.current?.focus(),
      insert: insertAtCursor,
      openFind: () => setFindOpen(true),
      replaceRunnable: (text: string) => {
        const ta = taRef.current;
        if (ta && ta.selectionEnd > ta.selectionStart) {
          const sel = value.slice(ta.selectionStart, ta.selectionEnd);
          if (sel.trim()) {
            const next = value.slice(0, ta.selectionStart) + text + value.slice(ta.selectionEnd);
            onChange(next);
            const pos = ta.selectionStart + text.length;
            requestAnimationFrame(() => {
              const el = taRef.current;
              if (!el) return;
              el.focus();
              el.selectionStart = el.selectionEnd = pos;
            });
            return;
          }
        }
        onChange(text);
      },
    }),
    [value, insertAtCursor, onChange],
  );

  const accept = useCallback(
    (item: SqlCompleteItem) => {
      const ta = taRef.current;
      const end = ta ? ta.selectionStart : cursorRef.current;
      const next = value.slice(0, compStart) + item.insert + value.slice(end);
      onChange(next);
      const pos = compStart + item.insert.length;
      cursorRef.current = pos;
      escAt.current = pos;
      setComp(null);
      requestAnimationFrame(() => {
        const el = taRef.current;
        if (!el) return;
        el.focus();
        el.selectionStart = el.selectionEnd = pos;
      });
    },
    [compStart, onChange, value],
  );

  useEffect(() => {
    if (!focused) return;
    const cursor = cursorRef.current;
    const r = completeSql(value, cursor, driver, catalog, { force: forceRef.current });
    forceRef.current = false;
    if (r?.missing.length) missRef.current?.(r.missing);
    const prefix = cursor - (r?.start ?? cursor);
    const show = !!r && r.items.length > 0 && escAt.current !== cursor && (r.wide || prefix > 0);
    if (!show || !r) {
      setComp(null);
      return;
    }
    setComp(r.items);
    setCompStart(r.start);
    setHi(0);
  }, [value, catalog, driver, focused, tick]);

  const spans = useMemo(() => findSpans(value, needle, false), [value, needle]);
  useEffect(() => {
    if (findOpen) findRef.current?.focus();
  }, [findOpen]);

  const goFind = (dir: 1 | -1) => {
    if (spans.length === 0) return;
    const ta = taRef.current;
    const cur = ta ? (dir > 0 ? ta.selectionEnd : ta.selectionStart) : 0;
    let idx = spans.findIndex((s) => (dir > 0 ? s.start >= cur : s.start >= cur));
    if (dir < 0) {
      idx = -1;
      for (let i = spans.length - 1; i >= 0; i--) if (spans[i].start < cur) { idx = i; break; }
      if (idx < 0) idx = spans.length - 1;
    } else if (idx < 0) idx = 0;
    const hit = spans[idx];
    setFindAt(idx);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.selectionStart = hit.start;
      el.selectionEnd = hit.end;
    });
  };

  const replaceOne = () => {
    const ta = taRef.current;
    if (!ta || !needle) return;
    const hit = spans.find((s) => s.start === ta.selectionStart && s.end === ta.selectionEnd) ?? spans.find((s) => s.start >= ta.selectionStart) ?? spans[0];
    if (!hit) return;
    const next = value.slice(0, hit.start) + repl + value.slice(hit.end);
    onChange(next);
    const pos = hit.start + repl.length;
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = pos;
    });
  };

  const shared = "m-0 whitespace-pre p-2 font-mono text-[13px] leading-[20px] [tab-size:2]";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded border border-border bg-bg-term">
      {findOpen && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border bg-bg-panel px-2 py-1 text-[11px]">
          <input
            ref={findRef}
            value={needle}
            onChange={(e) => setNeedle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                goFind(e.shiftKey ? -1 : 1);
              }
              if (e.key === "Escape") setFindOpen(false);
            }}
            placeholder="Localizar"
            className="h-6 w-36 rounded border border-border bg-bg-term px-1.5 text-text-1 outline-none focus:border-accent"
          />
          <input
            value={repl}
            onChange={(e) => setRepl(e.target.value)}
            placeholder="Substituir"
            className="h-6 w-36 rounded border border-border bg-bg-term px-1.5 text-text-1 outline-none focus:border-accent"
          />
          <button className="rounded px-1.5 py-0.5 text-text-2 hover:bg-bg-hover hover:text-text-1" onClick={() => goFind(1)} title="Próxima">
            Próxima
          </button>
          <button className="rounded px-1.5 py-0.5 text-text-2 hover:bg-bg-hover hover:text-text-1" onClick={replaceOne} disabled={!needle}>
            Trocar
          </button>
          <button
            className="rounded px-1.5 py-0.5 text-text-2 hover:bg-bg-hover hover:text-text-1"
            disabled={!needle}
            onClick={() => {
              const r = replaceAllText(value, needle, repl, false);
              onChange(r.text);
            }}
          >
            Trocar tudo
          </button>
          <span className="text-text-3">{needle ? `${spans.length ? findAt + 1 : 0}/${spans.length}` : ""}</span>
          <button className="ml-auto rounded px-1 text-text-3 hover:text-text-1" title="Fechar" onClick={() => setFindOpen(false)}>
            ✕
          </button>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
      <div
        ref={gutterRef}
        aria-hidden
        className="w-10 shrink-0 select-none overflow-hidden border-r border-border bg-bg-panel py-2 pr-1.5 text-right font-mono text-[11px] leading-[20px] text-text-3"
      >
        {Array.from({ length: lines }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
        <div className="h-10" />
      </div>
      <div className="relative min-w-0 flex-1">
        <pre ref={preRef} aria-hidden className={`${shared} pointer-events-none absolute inset-0 overflow-hidden`}>
          {!value && <span className="text-text-3">Escreva o SQL aqui. Ctrl+Space completa. Ctrl+Enter executa. Ctrl+F localiza.</span>}
          {segs.map((s, i) => (
            <span key={i} className={CLS[s.cls]}>
              {s.text}
            </span>
          ))}
          {/* a trailing newline needs one more line to stay aligned with the textarea */}
          {"\n "}
        </pre>
        <textarea
          ref={taRef}
          value={value}
          disabled={disabled}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          wrap="off"
          aria-label="Editor de SQL"
          className={`${shared} absolute inset-0 h-full w-full resize-none overflow-auto bg-transparent text-transparent caret-[rgb(var(--bt-text-1))] outline-none selection:bg-accent/40`}
          style={{ WebkitTextFillColor: "transparent", userSelect: "text" }}
          onScroll={syncScroll}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setComp(null);
          }}
          onSelect={(e) => {
            cursorRef.current = e.currentTarget.selectionStart;
          }}
          onChange={(e) => {
            cursorRef.current = e.target.selectionStart;
            escAt.current = null;
            onChange(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === " " && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              forceRef.current = true;
              escAt.current = null;
              cursorRef.current = e.currentTarget.selectionStart;
              setTick((n) => n + 1);
              return;
            }
            if (comp && comp.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHi((i) => (i + 1) % comp.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setHi((i) => (i - 1 + comp.length) % comp.length);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                escAt.current = e.currentTarget.selectionStart;
                setComp(null);
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.ctrlKey && !e.metaKey)) {
                e.preventDefault();
                accept(comp[Math.min(hi, comp.length - 1)]);
                return;
              }
            }
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              setComp(null);
              onRun();
              return;
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
              e.preventDefault();
              setFindOpen(true);
              return;
            }
            if (e.key === "Escape" && findOpen) {
              e.preventDefault();
              setFindOpen(false);
              return;
            }
            if (e.key === "Tab" && !e.ctrlKey && !e.altKey) {
              e.preventDefault();
              insertAtCursor("  ");
            }
          }}
        />
        {comp && comp.length > 0 && focused && (
          <ul
            className="absolute z-30 max-h-52 w-72 overflow-auto rounded border border-border-strong bg-bg-card py-1 text-[12px] shadow-lg"
            style={compStyle(value, compStart, taRef.current)}
            onMouseDown={(e) => e.preventDefault()}
          >
            {comp.map((item, i) => (
              <li key={item.kind + item.insert + (item.detail ?? "") + i}>
                <button
                  className={`flex w-full items-baseline gap-2 px-2 py-0.5 text-left ${i === hi ? "bg-accent-soft text-text-1" : "text-text-1 hover:bg-bg-hover"}`}
                  onMouseEnter={() => setHi(i)}
                  onClick={() => accept(item)}
                >
                  <span className="w-14 shrink-0 text-[10px] uppercase text-text-3">{KIND[item.kind]}</span>
                  <span className="min-w-0 flex-1 truncate font-mono">{item.label}</span>
                  {item.detail && <span className="max-w-28 truncate text-[10px] text-text-3">{item.detail}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      </div>
    </div>
  );
});
