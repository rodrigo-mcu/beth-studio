import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Copy, KeyRound, X } from "lucide-react";
import type { DbCell, DbResultColumn, DbSort } from "@/lib/dbApi";
import { cellDisplay, cellRaw, isNumericType, rowTSV, rowsTSV, uniqueNames } from "@/lib/dbFormat";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import {
  addRow,
  duplicateRow,
  editedValue,
  isAdded,
  revertRow,
  setCell,
  toggleDelete,
  type PendingChanges,
} from "@/lib/dbChanges";

const ROW_H = 24;
const OVERSCAN = 12;

interface Props {
  columns: DbResultColumn[];
  rows: DbCell[][];
  /** Ordenação no servidor (visão de tabela). Sem isto, ordena só o que já veio. */
  sort?: DbSort[];
  onSort?: (column: string, additive: boolean) => void;
  /** Colunas de chave primária (ícone no cabeçalho). */
  pkColumns?: Set<string>;
  /** Colunas que podem ser gravadas de volta. Duplo clique edita. */
  editable?: Set<string>;
  onSave?: (row: DbCell[], column: string, value: string | null) => Promise<void>;
  /** Número da primeira linha (paginação). */
  firstRowNumber?: number;
  onNotice?: (msg: string) => void;
  /**
   * Modo "Aplicar": edições, linhas novas e apagadas ficam pendentes aqui
   * (lib/dbChanges) em vez de gravar na hora; quem chama aplica ou descarta.
   */
  changes?: PendingChanges;
  onChanges?: (c: PendingChanges) => void;
  /** colunas que não vão para a cópia em "Duplicar linha" (a chave) */
  duplicateSkip?: Set<string>;
  /** linha da célula selecionada (botões Duplicar/Apagar de quem chama) */
  onSelectRow?: (row: DbCell[] | null) => void;
  /** seleciona e mostra esta linha (a linha nova recém-criada) */
  focusRow?: DbCell[] | null;
  /**
   * Seleção de várias linhas pelo número da linha (clique marca/desmarca,
   * Shift+clique marca o intervalo, clique no "#" marca todas). Quem chama
   * recebe as linhas marcadas, na ordem da tela.
   */
  onSelectRows?: (rows: DbCell[][]) => void;
}

interface Menu {
  x: number;
  y: number;
  row: number;
  col: number;
}

/**
 * Grade de resultados: rolagem virtual (só desenha as linhas visíveis),
 * largura das colunas ajustável arrastando a borda do cabeçalho, clique
 * seleciona a célula, botão direito abre o menu de cópia, duplo clique
 * mostra o valor inteiro.
 */
export function DbResultGrid({
  columns,
  rows: baseRows,
  sort,
  onSort,
  pkColumns,
  editable,
  onSave,
  firstRowNumber = 1,
  onNotice,
  changes,
  onChanges,
  duplicateSkip,
  onSelectRow,
  focusRow,
  onSelectRows,
}: Props) {
  const batch = !!(changes && onChanges);
  // linhas novas (ainda não gravadas) vêm depois das da página
  const rows = useMemo(() => (changes?.added.length ? [...baseRows, ...changes.added] : baseRows), [baseRows, changes?.added]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);
  const [sel, setSel] = useState<{ row: number; col: number } | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [viewer, setViewer] = useState<{ col: string; value: DbCell } | null>(null);
  const [editing, setEditing] = useState<{ row: number; col: number; text: string } | null>(null);
  const skipBlur = useRef(false);
  const [localSort, setLocalSort] = useState<DbSort | null>(null);
  const [widths, setWidths] = useState<number[]>([]);
  const [picked, setPicked] = useState<Set<DbCell[]>>(() => new Set());
  const lastPick = useRef<number | null>(null);

  // largura inicial: cabeçalho e as primeiras 200 linhas
  useEffect(() => {
    const w = columns.map((c, i) => {
      let len = c.name.length + Math.min(12, (c.type ?? "").length) + 4;
      for (let r = 0; r < Math.min(rows.length, 200); r++) len = Math.max(len, Math.min(48, cellDisplay(rows[r][i], 60).length));
      return Math.max(70, Math.min(380, Math.round(len * 7.4 + 18)));
    });
    setWidths(w);
    setSel(null);
    setEditing(null);
    setLocalSort(null);
    setPicked(new Set());
    lastPick.current = null;
    // só quando as colunas mudam (carregar mais não reajusta)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const view = useMemo(() => {
    if (onSort || !localSort) return rows;
    const i = columns.findIndex((c) => c.name === localSort.column);
    if (i < 0) return rows;
    const num = isNumericType(columns[i].type);
    const cmp = (a: DbCell, b: DbCell) => {
      if (a === null) return b === null ? 0 : 1;
      if (b === null) return -1;
      if (num || (typeof a === "number" && typeof b === "number")) return Number(a) - Number(b);
      return cellRaw(a).localeCompare(cellRaw(b), "pt-BR", { numeric: true });
    };
    const out = rows.slice().sort((x, y) => cmp(x[i], y[i]));
    return localSort.desc ? out.reverse() : out;
  }, [rows, columns, localSort, onSort]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(view.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
  const numW = Math.max(44, String(firstRowNumber + view.length).length * 8 + 16);
  const totalW = numW + widths.reduce((a, b) => a + b, 0);

  const sortOf = (name: string): DbSort | undefined => (onSort ? sort?.find((s) => s.column === name) : localSort?.column === name ? localSort : undefined);

  const clickHeader = (name: string, additive: boolean) => {
    if (onSort) {
      onSort(name, additive);
      return;
    }
    setLocalSort((cur) => (cur?.column !== name ? { column: name, desc: false } : cur.desc ? null : { column: name, desc: true }));
  };

  const startResize = (i: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = widths[i] ?? 100;
    const move = (ev: MouseEvent) => {
      const w = Math.max(40, Math.min(1200, w0 + ev.clientX - x0));
      setWidths((ws) => ws.map((v, k) => (k === i ? w : v)));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const copy = async (text: string, what: string) => {
    const ok = await copyText(text);
    onNotice?.(ok ? `${what} copiad${what.endsWith("a") ? "a" : "o"}` : "não foi possível copiar");
  };

  const names = useMemo(() => uniqueNames(columns), [columns]);

  const canEdit = (col: number, row?: DbCell[]) => {
    const c = columns[col];
    if ((!onSave && !batch) || !editable?.has(c?.name ?? "") || !c) return false;
    if (batch && row && changes?.deleted.has(row)) return false;
    const t = (c.type ?? "").toUpperCase();
    return !(t.includes("BLOB") || t.includes("BINARY") || t === "BYTEA" || t === "IMAGE");
  };

  const editLock = useRef(false);
  /** valor mostrado: o digitado (modo Aplicar) ou o que veio do banco */
  const shown = (row: DbCell[], col: number): DbCell => {
    if (batch && changes) {
      const ed = editedValue(changes, row, columns[col]?.name ?? "");
      if (ed !== undefined) return ed;
    }
    return row[col] ?? null;
  };
  const beginEdit = (row: number, col: number) => {
    if (!canEdit(col, view[row])) return false;
    const v = view[row] ? shown(view[row], col) : null;
    setSel({ row, col });
    setEditing({ row, col, text: v === null ? "" : cellRaw(v) });
    return true;
  };
  /** grava (modo antigo) ou marca como pendente (modo Aplicar) */
  const putCell = async (src: DbCell[], col: number, value: string | null) => {
    const column = columns[col]?.name;
    if (!column) return;
    if (batch && changes && onChanges) {
      onChanges(setCell(changes, src, column, value, isAdded(changes, src) ? undefined : (src[col] ?? null)));
      return;
    }
    if (onSave) await onSave(src, column, value);
  };

  const commitEdit = async (asNull: boolean) => {
    if (!editing || (!onSave && !batch) || editLock.current) return;
    const { row, col, text } = editing;
    const src = view[row];
    editLock.current = true;
    setEditing(null);
    try {
      if (src) await putCell(src, col, asNull ? null : text);
    } catch (e) {
      onNotice?.(e instanceof Error ? e.message : String(e));
    } finally {
      editLock.current = false;
    }
  };

  const pickedRows = useMemo(() => (picked.size ? view.filter((r) => picked.has(r)) : []), [view, picked]);
  const pickedCount = useRef(0);
  useEffect(() => {
    // não avisa de novo "nenhuma" a cada nova página
    if (!pickedRows.length && !pickedCount.current) return;
    pickedCount.current = pickedRows.length;
    onSelectRows?.(pickedRows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedRows]);

  const pickRow = (r: number, shift: boolean) => {
    const row = view[r];
    if (!row) return;
    setPicked((cur) => {
      const next = new Set(cur);
      const from = lastPick.current;
      if (shift && from !== null) {
        for (let i = Math.min(from, r); i <= Math.max(from, r); i++) if (view[i]) next.add(view[i]);
      } else if (next.has(row)) next.delete(row);
      else next.add(row);
      return next;
    });
    lastPick.current = r;
  };
  const pickAll = () => {
    lastPick.current = null;
    setPicked((cur) => (view.length > 0 && view.every((r) => cur.has(r)) ? new Set() : new Set(view)));
  };

  useEffect(() => {
    onSelectRow?.(sel ? (view[sel.row] ?? null) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, view]);

  // linha nova criada pelo menu daqui (a de quem chama vem em focusRow)
  const [localFocus, setLocalFocus] = useState<DbCell[] | null>(null);
  const focused = useRef<DbCell[] | null>(null); // cada linha nova recebe o foco uma vez só
  useEffect(() => {
    const target = localFocus ?? focusRow;
    if (!target || focused.current === target) return;
    const r = view.indexOf(target);
    if (r < 0) return;
    focused.current = target;
    const c = Math.max(0, columns.findIndex((_, i) => canEdit(i, target)));
    setSel({ row: r, col: c });
    const el = scrollRef.current;
    if (el) el.scrollTop = Math.max(0, (r + 2) * ROW_H - el.clientHeight);
    setLocalFocus(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRow, localFocus, view]);

  const rowState = (row: DbCell[]): "added" | "deleted" | "edited" | null => {
    if (!batch || !changes) return null;
    if (isAdded(changes, row)) return "added";
    if (changes.deleted.has(row)) return "deleted";
    return changes.edits.get(row)?.size ? "edited" : null;
  };

  if (columns.length === 0) {
    return <div className="p-4 text-text-3">Sem colunas.</div>;
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        tabIndex={0}
        onKeyDown={(e) => {
          if (editing) return;
          if (sel && e.key === "F2") {
            e.preventDefault();
            beginEdit(sel.row, sel.col);
          }
          if (sel && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
            e.preventDefault();
            void copy(cellRaw(view[sel.row]?.[sel.col] ?? null), "Célula");
          }
        }}
      >
        <div style={{ width: totalW, minWidth: "100%" }}>
          {/* cabeçalho */}
          <div className="sticky top-0 z-10 flex border-b border-border-strong bg-bg-panel text-[12px] font-semibold text-text-1" style={{ height: ROW_H + 4 }}>
            <div
              className={cn("shrink-0 border-r border-border px-1 text-right leading-[28px] text-text-3", onSelectRows && "cursor-pointer hover:bg-bg-hover hover:text-text-1")}
              style={{ width: numW }}
              title={onSelectRows ? "Marcar todas as linhas / desmarcar" : undefined}
              onClick={onSelectRows ? pickAll : undefined}
            >
              {pickedRows.length ? `${pickedRows.length}✓` : "#"}
            </div>
            {columns.map((c, i) => {
              const s = sortOf(c.name);
              return (
                <div
                  key={i}
                  className="relative flex shrink-0 cursor-pointer items-center gap-1 border-r border-border px-2 hover:bg-bg-hover"
                  style={{ width: widths[i] ?? 100 }}
                  title={`${c.name}${c.type ? ` (${c.type})` : ""}\nClique: ordenar${onSort ? " · Shift+clique: ordenar também por esta" : ""}`}
                  onClick={(e) => clickHeader(c.name, e.shiftKey)}
                >
                  {pkColumns?.has(c.name) && <KeyRound size={11} className="shrink-0 text-status-warn" />}
                  <span className="truncate">{c.name}</span>
                  {c.type && <span className="truncate text-[10px] font-normal text-text-3">{c.type.toLowerCase()}</span>}
                  {s && (s.desc ? <ArrowDown size={12} className="ml-auto shrink-0 text-accent-text" /> : <ArrowUp size={12} className="ml-auto shrink-0 text-accent-text" />)}
                  <div
                    className="absolute right-[-3px] top-0 z-10 h-full w-[6px] cursor-col-resize hover:bg-accent/50"
                    title="Arraste para mudar a largura"
                    onMouseDown={(e) => startResize(i, e)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </div>
              );
            })}
          </div>
          {/* linhas (só as visíveis) */}
          <div style={{ height: view.length * ROW_H, position: "relative" }}>
            {view.slice(first, last).map((row, k) => {
              const r = first + k;
              const state = rowState(row);
              return (
                <div
                  key={r}
                  className={cn(
                    "absolute left-0 flex text-[12px]",
                    r % 2 ? "bg-bg-panel/40" : "",
                    picked.has(row) && "bg-accent-soft",
                    state === "added" && "bg-status-ok/10",
                    state === "deleted" && "bg-status-err/10 text-text-3 line-through",
                  )}
                  style={{ top: r * ROW_H, height: ROW_H, width: totalW }}
                >
                  <div
                    className={cn(
                      "shrink-0 border-r border-border px-1 text-right font-mono leading-[24px] text-text-3",
                      state === "added" && "text-status-ok",
                      state === "deleted" && "text-status-err",
                      state === "edited" && "text-status-warn",
                      onSelectRows && "cursor-pointer hover:bg-bg-hover",
                      picked.has(row) && "font-bold text-accent-text",
                    )}
                    style={{ width: numW }}
                    onMouseDown={onSelectRows ? (e) => e.button === 0 && e.preventDefault() : undefined}
                    onClick={onSelectRows ? (e) => pickRow(r, e.shiftKey) : undefined}
                    title={onSelectRows && state === null ? "Clique: marcar a linha · Shift+clique: marcar até aqui" : state === "added" ? "Linha nova (ainda não gravada)" : state === "deleted" ? "Será apagada ao aplicar" : state === "edited" ? "Alterada (ainda não gravada)" : undefined}
                  >
                    {state === "added" ? "+" : state === "deleted" ? "−" : picked.has(row) ? "✓" : firstRowNumber + r}
                  </div>
                  {columns.map((c, i) => {
                    const typed = batch && changes ? editedValue(changes, row, c.name) : undefined;
                    const v = typed !== undefined ? typed : (row[i] ?? null);
                    const isDefault = state === "added" && typed === undefined;
                    const selected = sel?.row === r && sel.col === i;
                    const open = editing?.row === r && editing.col === i;
                    return (
                      <div
                        key={i}
                        className={cn(
                          "shrink-0 cursor-default truncate border-r border-border/60 px-2 font-mono leading-[24px]",
                          v === null || isDefault ? "italic text-text-3" : "text-text-1",
                          (isNumericType(c.type) || typeof v === "number") && !open && "text-right",
                          typed !== undefined && state !== "added" && "bg-status-warn/20",
                          selected && "bg-accent-soft outline outline-1 -outline-offset-1 outline-accent",
                        )}
                        style={{ width: widths[i] ?? 100 }}
                        title={isDefault ? "Valor padrão do banco (duplo clique para preencher)" : canEdit(i, row) ? "Duplo clique ou F2 para editar" : undefined}
                        onMouseDown={(e) => {
                          if (e.button === 0 || e.button === 2) setSel({ row: r, col: i });
                        }}
                        onDoubleClick={() => {
                          if (!beginEdit(r, i)) setViewer({ col: c.name, value: v });
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setSel({ row: r, col: i });
                          setMenu({ x: e.clientX, y: e.clientY, row: r, col: i });
                        }}
                      >
                        {open ? (
                          <input
                            autoFocus
                            className="h-[22px] w-full bg-bg-card font-mono text-[12px] text-text-1 outline-none"
                            value={editing.text}
                            onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                            onMouseDown={(e) => e.stopPropagation()}
                            onDoubleClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              e.stopPropagation();
                              if (e.key === "Enter") {
                                e.preventDefault();
                                skipBlur.current = true;
                                void commitEdit(false);
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                skipBlur.current = true;
                                setEditing(null);
                              }
                            }}
                            onBlur={() => {
                              if (skipBlur.current) {
                                skipBlur.current = false;
                                return;
                              }
                              void commitEdit(false);
                            }}
                          />
                        ) : isDefault ? (
                          "(padrão)"
                        ) : (
                          cellDisplay(v)
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {menu && (
        <div
          className="fixed z-[90] min-w-[220px] rounded-md border border-border-strong bg-bg-card py-1 text-[12px] text-text-1 shadow-2xl"
          style={{ left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - 230) }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {[
            { label: "Copiar célula", run: () => copy(cellRaw(view[menu.row][menu.col] ?? null), "Célula") },
            { label: "Copiar linha (tabulação)", run: () => copy(rowTSV(view[menu.row]), "Linha") },
            {
              label: "Copiar linha como JSON",
              run: () => copy(JSON.stringify(Object.fromEntries(names.map((n, i) => [n, view[menu.row][i] ?? null])), null, 2), "Linha"),
            },
            { label: `Copiar nome da coluna "${names[menu.col]}"`, run: () => copy(columns[menu.col].name, "Nome") },
            { label: "Copiar coluna inteira", run: () => copy(view.map((r) => cellRaw(r[menu.col] ?? null)).join("\r\n"), "Coluna") },
            { label: "Copiar tudo com cabeçalho", run: () => copy(rowsTSV(columns, view), "Resultado") },
            { label: "Ver valor completo…", run: () => setViewer({ col: columns[menu.col].name, value: view[menu.row][menu.col] ?? null }) },
            ...(canEdit(menu.col, view[menu.row])
              ? [
                  { label: "Editar célula", run: () => { beginEdit(menu.row, menu.col); } },
                  {
                    label: "Definir NULL",
                    run: () => {
                      const src = view[menu.row];
                      if (!src) return;
                      void putCell(src, menu.col, null).catch((e: unknown) => onNotice?.(e instanceof Error ? e.message : String(e)));
                    },
                  },
                ]
              : []),
            ...(batch && changes && view[menu.row]
              ? (() => {
                  const src = view[menu.row];
                  const st = rowState(src);
                  const put = (c: PendingChanges) => onChanges?.(c);
                  return [
                    {
                      label: "Nova linha",
                      run: () => {
                        const a = addRow(changes, columns.length);
                        put(a.changes);
                        setLocalFocus(a.row);
                      },
                    },
                    {
                      label: "Duplicar linha",
                      run: () => {
                        const a = duplicateRow(changes, src, columns, duplicateSkip ?? new Set());
                        put(a.changes);
                        setLocalFocus(a.row);
                      },
                    },
                    { label: st === "deleted" ? "Desfazer apagar" : st === "added" ? "Remover linha nova" : "Apagar linha", run: () => put(toggleDelete(changes, src)) },
                    ...(st === "edited" ? [{ label: "Desfazer alterações da linha", run: () => put(revertRow(changes, src)) }] : []),
                  ];
                })()
              : []),
          ].map((it) => (
            <button
              key={it.label}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-bg-hover"
              onClick={() => {
                setMenu(null);
                void it.run();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}

      {viewer && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/50" onMouseDown={() => setViewer(null)}>
          <div
            className="flex max-h-[80vh] w-[min(760px,92vw)] flex-col rounded-lg border border-border bg-bg-card shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.key === "Escape" && setViewer(null)}
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-[13px] font-semibold">
              {viewer.col}
              <span className="text-[11px] font-normal text-text-3">{viewer.value === null ? "NULL" : `${cellRaw(viewer.value).length.toLocaleString("pt-BR")} caracteres`}</span>
              <button
                className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-[12px] font-normal text-text-2 hover:bg-bg-hover hover:text-text-1"
                onClick={() => void copy(cellRaw(viewer.value), "Valor")}
              >
                <Copy size={13} /> Copiar
              </button>
              <button className="rounded p-1 text-text-2 hover:bg-bg-hover" title="Fechar" onClick={() => setViewer(null)}>
                <X size={15} />
              </button>
            </div>
            <pre className="min-h-0 flex-1 select-text overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-[12px] text-text-1" style={{ userSelect: "text" }}>
              {viewer.value === null ? "NULL" : prettyMaybeJSON(cellRaw(viewer.value))}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function prettyMaybeJSON(s: string): string {
  const t = s.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      return s;
    }
  }
  return s;
}
