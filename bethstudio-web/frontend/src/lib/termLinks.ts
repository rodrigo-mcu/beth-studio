// Links clicáveis na SAÍDA do terminal (xterm.js): prioridade #1 é um
// hyperlink OSC 8 de verdade (o agente já manda; ver lines_to_escapes no
// termwiz da ponte, que preserva o SetHyperlink) — nesse caso o alvo real
// (não o texto visível) manda. Sem OSC 8, cai no fallback: URL solta
// (com ou sem esquema) ou caminho de arquivo local solto no texto. Tudo
// aqui opera sobre o texto CRU de uma linha (antes do posicionamento fixo
// de cursor do screen.ts), pois xterm não expõe "esta célula é um link
// OSC 8" pela API pública — por isso reimplementamos o parsing mínimo do
// OSC 8 aqui, so' para achar os intervalos de coluna.
import { IMAGE_FILE_EXT, TEXT_FILE_EXT, localFileKind, resolveLinkPath, type PaneLinkCtx } from "./localFile.ts";
import { isHttpUrl } from "./links.ts";

export interface RowSpan {
  /** Coluna inicial (0-based, inclusive) na linha renderizada. */
  start: number;
  /** Coluna final (0-based, exclusive). */
  end: number;
  uri: string;
}

const OSC8_START = /\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/y;
const OSC8_END = /\x1b\]8;;(?:\x07|\x1b\\)/y;
// Qualquer outra sequência de escape (CSI de cor/estilo, OSC de título etc.):
// não é texto visível, não conta coluna.
const OTHER_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y;
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/y;
// nF (ESC ( B = charset, etc.) e formas curtas (ESC + 1 char)
const OTHER_ESC = /\x1b(?:[ -/]+[0-~]|[0-~])/y;

/** Tira toda sequência de escape de uma linha, sobrando só o texto visível (colunas 1:1 com os índices). */
export function stripEscapes(row: string): string {
  let out = "";
  let i = 0;
  while (i < row.length) {
    if (row[i] === "\x1b") {
      OSC8_START.lastIndex = i;
      const m1 = OSC8_START.exec(row);
      if (m1 && m1.index === i) {
        i += m1[0].length;
        continue;
      }
      OSC8_END.lastIndex = i;
      const m2 = OSC8_END.exec(row);
      if (m2 && m2.index === i) {
        i += m2[0].length;
        continue;
      }
      OTHER_OSC.lastIndex = i;
      const m3 = OTHER_OSC.exec(row);
      if (m3 && m3.index === i) {
        i += m3[0].length;
        continue;
      }
      CSI.lastIndex = i;
      const m4 = CSI.exec(row);
      if (m4 && m4.index === i) {
        i += m4[0].length;
        continue;
      }
      OTHER_ESC.lastIndex = i;
      const m5 = OTHER_ESC.exec(row);
      if (m5 && m5.index === i) {
        i += m5[0].length;
        continue;
      }
      i += 1; // ESC solto e desconhecido: pula só ele, não conta coluna
      continue;
    }
    out += row[i];
    i += 1;
  }
  return out;
}

/**
 * Acha os hyperlinks OSC 8 de uma linha crua, com o intervalo de coluna
 * (na linha já sem escapes) e o alvo REAL (não o texto exibido).
 */
export function parseOsc8Spans(row: string): RowSpan[] {
  const spans: RowSpan[] = [];
  let col = 0;
  let i = 0;
  let open: { start: number; uri: string } | null = null;
  while (i < row.length) {
    if (row[i] === "\x1b") {
      OSC8_START.lastIndex = i;
      const m1 = OSC8_START.exec(row);
      if (m1 && m1.index === i) {
        if (open) spans.push({ start: open.start, end: col, uri: open.uri });
        open = m1[1] ? { start: col, uri: m1[1] } : null;
        i += m1[0].length;
        continue;
      }
      OSC8_END.lastIndex = i;
      const m2 = OSC8_END.exec(row);
      if (m2 && m2.index === i) {
        if (open) spans.push({ start: open.start, end: col, uri: open.uri });
        open = null;
        i += m2[0].length;
        continue;
      }
      OTHER_OSC.lastIndex = i;
      const m3 = OTHER_OSC.exec(row);
      if (m3 && m3.index === i) {
        i += m3[0].length;
        continue;
      }
      CSI.lastIndex = i;
      const m4 = CSI.exec(row);
      if (m4 && m4.index === i) {
        i += m4[0].length;
        continue;
      }
      OTHER_ESC.lastIndex = i;
      const m5 = OTHER_ESC.exec(row);
      if (m5 && m5.index === i) {
        i += m5[0].length;
        continue;
      }
      i += 1;
      continue;
    }
    col += 1;
    i += 1;
  }
  if (open) spans.push({ start: open.start, end: col, uri: open.uri });
  return spans;
}


const FILE_EXT_SET = new Set<string>(
  [
    ...TEXT_FILE_EXT,
    ...IMAGE_FILE_EXT,
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".xlsm", ".ppt", ".pptx", ".odt", ".ods", ".odp", ".rtf",
    ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".tgz",
    ".csv", ".json", ".xml", ".html", ".htm", ".css", ".yaml", ".yml", ".toml", ".ini", ".cfg",
    ".exe", ".bat", ".cmd", ".ps1", ".lnk", ".js", ".vbs", ".msi", ".scr",
    ".pif", ".cpl", ".hta", ".wsf", ".wsh", ".jse", ".vbe", ".msc", ".reg", ".inf", ".url", ".jar", ".dll",
  ].map((e) => e.slice(1).toLowerCase()),
);
// Programa ou script: o clique mostra na pasta, não executa. ".com" entra
// aqui (executável antigo) mas NÃO na lista de nomes soltos, senão
// "exemplo.com" viraria arquivo.
const DANGEROUS_EXT = new Set<string>([
  "exe", "bat", "cmd", "com", "scr", "pif", "msi", "msp", "msix", "appx", "appinstaller",
  "ps1", "psm1", "psd1", "psc1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "ws", "wsc",
  "hta", "cpl", "msc", "lnk", "scf", "inf", "reg", "url", "website", "gadget", "appref-ms",
  "dll", "sys", "jar",
]);
// Caminho solto: nada de espaço, aspas, crase, parênteses/colchetes/chaves
// ou <> no meio; TERMINA na extensão (depois dela so' fim, espaço ou
// pontuação — "x.md)." ou "x.md," valem; "x.md.bak" e "x.mdx" não).
const EXT_ALT = [...FILE_EXT_SET].sort((a, b) => b.length - a.length).join("|");
const FILE_TOKEN_RE = new RegExp(
  `[^\\s"'\`<>()\\[\\]{}]+\\.(?:${EXT_ALT})(?=$|[\\s)\\]}>"'\`,;:!?]|\\.(?![\\w]))`,
  "gi",
);
// Caminho com separador (unidade, UNC, ~, file://, POSIX): qualquer extensão
// curta, não só a lista de cima — "D:\\docs\\dados.custom" também.
const PATH_FILE_RE = new RegExp(
  `(?:[A-Za-z]:[\\\\/]|\\\\\\\\|~[\\\\/]|file://|\\.{1,2}[\\\\/]|/(?!/))[^\\s"'\`<>|*?\\[\\](){}]+?\\.[A-Za-z0-9]{1,12}(?=$|[\\s)\\]}>"'\`,;:!?]|\\.(?![\\w]))`,
  "gi",
);
// Entre aspas (ou crase) o caminho pode ter espaço.
const QUOTED_FILE_RE = /["'`]((?:[A-Za-z]:[\\/]|\\\\|~[\\/]|file:\/\/|\.{1,2}[\\/]|\/(?!\/))[^"'`]*?\.[A-Za-z0-9]{1,12})["'`]/gi;
const SCHEME_URL_RE = /\bhttps?:\/\/[^\s"'`<>()]+/gi;
const BARE_DOMAIN_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?:\/[^\s"'`<>()]*)?\b/gi;

function trimTrailingPunct(s: string): string {
  return s.replace(/[.,;:!?)\]}'"`]+$/u, "");
}

/** Um candidato de caminho de arquivo local, achado em texto solto (sem OSC 8). */
function insideHttpUrl(text: string, index: number): boolean {
  return /https?:\/\/\S*$/i.test(text.slice(0, index));
}

/** Um candidato de caminho de arquivo local, achado em texto solto (sem OSC 8). */
export function extractFileCandidates(visibleText: string): RowSpan[] {
  const out: RowSpan[] = [];
  const taken: Array<{ start: number; end: number }> = [];
  const claim = (start: number, uri: string) => {
    const trimmed = trimTrailingPunct(uri);
    if (!trimmed || !fileExtOf(trimmed)) return;
    const end = start + trimmed.length;
    if (insideHttpUrl(visibleText, start)) return;
    // "s://example.com" casa com unidade "s:/", mas é esquema. E "lab/arq.md"
    // não pode começar no segundo segmento.
    if (/^[A-Za-z]:\/\//.test(trimmed)) return;
    if (trimmed.startsWith("/") && start > 0 && /[\w.]/.test(visibleText[start - 1])) return;
    if (taken.some((r) => start < r.end && end > r.start)) return;
    taken.push({ start, end });
    out.push({ start, end, uri: trimmed });
  };
  // Aspas primeiro: o caminho inteiro, com espaço, sem a aspa.
  for (const m of visibleText.matchAll(QUOTED_FILE_RE)) {
    const uri = m[1] ?? "";
    const at = m.index! + m[0].indexOf(uri);
    claim(at, uri);
  }
  for (const m of visibleText.matchAll(PATH_FILE_RE)) claim(m.index!, m[0]);
  for (const m of visibleText.matchAll(FILE_TOKEN_RE)) claim(m.index!, m[0]);
  out.sort((a, b) => a.start - b.start);
  return out;
}

function fileExtOf(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path;
  const i = base.lastIndexOf(".");
  if (i <= 0) return "";
  return base.slice(i + 1).toLowerCase();
}

export function isDangerousFilePath(path: string): boolean {
  return DANGEROUS_EXT.has(fileExtOf(path));
}

/** Um candidato de URL http(s), achado em texto solto (com ou sem esquema explícito). */
export function extractUrlCandidates(visibleText: string): RowSpan[] {
  const out: RowSpan[] = [];
  const claimed: Array<[number, number]> = [];
  for (const m of visibleText.matchAll(SCHEME_URL_RE)) {
    const trimmed = trimTrailingPunct(m[0]);
    if (!trimmed) continue;
    out.push({ start: m.index!, end: m.index! + trimmed.length, uri: trimmed });
    claimed.push([m.index!, m.index! + trimmed.length]);
  }
  for (const m of visibleText.matchAll(BARE_DOMAIN_RE)) {
    const trimmed = trimTrailingPunct(m[0]);
    if (!trimmed) continue;
    const start = m.index!;
    const end = start + trimmed.length;
    if (claimed.some(([a, b]) => start < b && end > a)) continue; // já achado como https://...
    // parte de um caminho ("/repo/notes.md", "C:\x\y.txt") não é domínio
    const before = start > 0 ? visibleText[start - 1] : "";
    if (before === "/" || before === "\\" || before === ".") continue;
    const host = trimmed.split("/")[0];
    const lastLabel = host.split(".").pop()?.toLowerCase() ?? "";
    if (FILE_EXT_SET.has(lastLabel)) continue; // "relatorio.md" não é domínio
    out.push({ start, end, uri: `https://${trimmed}` });
  }
  return out;
}

function overlaps(a: { start: number; end: number }, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((r) => a.start < r.end && a.end > r.start);
}

/**
 * Todos os spans clicáveis de uma linha crua: OSC 8 primeiro (alvo real),
 * depois arquivo local solto, depois URL solta — cada categoria não pisa
 * numa faixa de coluna já usada pela anterior.
 */
export function rowLinkCandidates(row: string): { start: number; end: number; uri: string; kind: "osc8" | "file" | "url" }[] {
  const osc8 = parseOsc8Spans(row);
  const visible = stripEscapes(row);
  return [...osc8.map((s) => ({ ...s, kind: "osc8" as const })), ...fallbackSpans(visible, osc8)];
}

/** Só o fallback (texto solto), sem pisar nas faixas já cobertas por OSC 8. */
export function fallbackSpans(visible: string, osc8: Array<{ start: number; end: number }>): { start: number; end: number; uri: string; kind: "file" | "url" }[] {
  const files = extractFileCandidates(visible).filter((f) => !overlaps(f, osc8));
  const urls = extractUrlCandidates(visible).filter((u) => !overlaps(u, osc8) && !overlaps(u, files));
  return [...files.map((s) => ({ ...s, kind: "file" as const })), ...urls.map((s) => ({ ...s, kind: "url" as const }))];
}

/** Para onde vai um clique num link do terminal (alvo OSC 8 ou texto solto). */
export type LinkRoute =
  | { kind: "http"; url: string }
  | { kind: "file"; path: string }
  | { kind: "open"; path: string }
  | { kind: "reveal"; path: string };

/**
 * Roteia pelo ALVO: http(s) -> navegador; texto/imagem -> painel de preview;
 * qualquer outro arquivo -> programa padrão do Windows; programa ou script
 * -> mostrar na pasta (não executa). Pasta, sem extensão ou esquema estranho
 * -> não clicável (null).
 */
export function routeTermLink(target: string, ctx: PaneLinkCtx): LinkRoute | null {
  const t = target.trim();
  if (!t) return null;
  if (/^https?:/i.test(t)) return isHttpUrl(t) ? { kind: "http", url: t } : null;
  const path = resolveLinkPath(t, ctx);
  if (!path || /[\\/]$/.test(path)) return null;
  if (!fileExtOf(path)) return null;
  if (localFileKind(path)) return { kind: "file", path };
  if (isDangerousFilePath(path)) return { kind: "reveal", path };
  return { kind: "open", path };
}

export interface ClickMods {
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

/**
 * Com rastreamento de mouse o clique puro vai ao programa; Ctrl (ou Cmd)
 * abre o link. Sem rastreamento o clique abre, e Shift sozinho fica para
 * a seleção.
 */
export function shouldActivateLink(mouseTracking: boolean, mods: ClickMods): boolean {
  if (mouseTracking) return mods.ctrl || mods.meta;
  if (mods.shift && !mods.ctrl && !mods.meta) return false;
  return true;
}

/** Ctrl+clique com rastreamento não deve ser reportado ao programa. */
export function suppressAppMouseDown(mouseTracking: boolean, mods: ClickMods): boolean {
  return mouseTracking && (mods.ctrl || mods.meta);
}

/** Dica ao passar o mouse. Com rastreamento, o gesto é Ctrl+clique. */
export function linkHoverHint(mouseTracking: boolean, kind: LinkRoute["kind"]): string {
  const how = mouseTracking ? "Ctrl+clique" : "Clique";
  if (kind === "http") return `${how} para abrir no navegador`;
  if (kind === "reveal") return `${how} para mostrar na pasta`;
  return `${how} para abrir`;
}

// --- colunas reais do xterm ----------------------------------------------
// O índice no texto (unidades UTF-16) nem sempre é a coluna: caractere largo
// (2 colunas), emoji (2 unidades) etc. O mapa vem das células do próprio
// buffer do xterm, então o sublinhado cai exatamente sobre o texto.

export interface CellLike {
  chars: string;
  width: number;
}

export interface CellText {
  text: string;
  /** coluna (0-based) de cada unidade UTF-16 de `text` */
  colOf: number[];
  /** largura (colunas) da célula de cada unidade */
  widthOf: number[];
}

export function cellText(cells: CellLike[]): CellText {
  let text = "";
  const colOf: number[] = [];
  const widthOf: number[] = [];
  cells.forEach((c, x) => {
    if (c.width === 0) return; // continuação de caractere largo
    const ch = c.chars || " ";
    for (let k = 0; k < ch.length; k++) {
      colOf.push(x);
      widthOf.push(c.width);
    }
    text += ch;
  });
  return { text, colOf, widthOf };
}

/** Faixa [start,end) em unidades de `text` -> colunas 1-based inclusivas do xterm. */
export function spanColumns(ct: CellText, start: number, end: number): { x1: number; x2: number } | null {
  if (start < 0 || end <= start || end > ct.colOf.length) return null;
  return { x1: ct.colOf[start] + 1, x2: ct.colOf[end - 1] + ct.widthOf[end - 1] };
}

/**
 * Spans do fallback de UMA linha, já em colunas do xterm: o texto vem das
 * células; os trechos com OSC 8 vêm da linha crua (só usados se o texto da
 * linha crua bate com o das células — senão as faixas não seriam confiáveis).
 * Se o xterm cortou a linha (autowrap desligado), o alvo continua sendo o
 * caminho inteiro do texto cru e o sublinhado fica só na parte visível.
 */
export function lineFallbackLinks(
  cells: CellLike[],
  rawRow: string | undefined,
): { x1: number; x2: number; uri: string; kind: "file" | "url" }[] {
  const ct = cellText(cells);
  const basis = searchBasis(ct, rawRow);
  const out: { x1: number; x2: number; uri: string; kind: "file" | "url" }[] = [];
  for (const s of fallbackSpans(basis.text, basis.osc8)) {
    const end = Math.min(s.end, basis.clamp);
    if (end <= s.start) continue;
    const cols = spanColumns(ct, s.start, end);
    if (cols) out.push({ ...cols, uri: s.uri, kind: s.kind });
  }
  return out;
}

function searchBasis(ct: CellText, rawRow: string | undefined): { text: string; osc8: RowSpan[]; clamp: number } {
  const cellTrim = ct.text.replace(/\s+$/, "");
  let osc8: RowSpan[] = [];
  if (rawRow === undefined) return { text: ct.text, osc8, clamp: ct.text.length };
  const vis = stripEscapes(rawRow);
  const rawTrim = vis.replace(/\s+$/, "");
  const spans = parseOsc8Spans(rawRow);
  if (cellTrim.length > 0 && rawTrim.startsWith(cellTrim) && rawTrim.length > cellTrim.length) {
    return { text: rawTrim, osc8: spans, clamp: cellTrim.length };
  }
  if (spans.length && vis.trimEnd() === ct.text.trimEnd()) osc8 = spans;
  else if (spans.length) {
    for (const s of spans) {
      const label = vis.slice(s.start, s.end);
      const at = label ? ct.text.indexOf(label) : -1;
      if (at >= 0) osc8.push({ start: at, end: at + label.length, uri: s.uri });
    }
  }
  return { text: ct.text, osc8, clamp: ct.text.length };
}

export interface LinkRow {
  cells: CellLike[];
  /** continuação da linha anterior (xterm isWrapped) */
  wrapped: boolean;
  raw?: string;
}

export interface PlacedLink {
  y1: number;
  x1: number;
  y2: number;
  x2: number;
  uri: string;
  kind: "file" | "url";
}

/** Links do fallback cuja faixa cruza a linha `y` (1-based), juntando isWrapped. */
export function fallbackLinksTouching(rows: LinkRow[], y: number): PlacedLink[] {
  if (y < 1 || y > rows.length) return [];
  let start = y - 1;
  while (start > 0 && rows[start].wrapped) start--;
  let end = start;
  while (end + 1 < rows.length && rows[end + 1].wrapped) end++;
  return linksOnLogical(rows, start, end).filter((l) => l.y1 <= y && y <= l.y2);
}

function linksOnLogical(rows: LinkRow[], start: number, end: number): PlacedLink[] {
  if (start === end) {
    return lineFallbackLinks(rows[start].cells, rows[start].raw).map((l) => ({
      y1: start + 1,
      x1: l.x1,
      y2: start + 1,
      x2: l.x2,
      uri: l.uri,
      kind: l.kind,
    }));
  }
  let text = "";
  const at: { row: number; col: number; width: number }[] = [];
  const osc8: RowSpan[] = [];
  for (let r = start; r <= end; r++) {
    const ct = cellText(rows[r].cells);
    const base = text.length;
    for (let i = 0; i < ct.text.length; i++) at.push({ row: r, col: ct.colOf[i], width: ct.widthOf[i] });
    text += ct.text;
    const raw = rows[r].raw;
    if (raw !== undefined && stripEscapes(raw).trimEnd() === ct.text.trimEnd()) {
      for (const s of parseOsc8Spans(raw)) osc8.push({ start: base + s.start, end: base + s.end, uri: s.uri });
    }
  }
  const out: PlacedLink[] = [];
  for (const s of fallbackSpans(text, osc8)) {
    if (s.start < 0 || s.end > at.length || s.end <= s.start) continue;
    const a = at[s.start];
    const b = at[s.end - 1];
    out.push({
      y1: a.row + 1,
      x1: a.col + 1,
      y2: b.row + 1,
      x2: b.col + b.width,
      uri: s.uri,
      kind: s.kind,
    });
  }
  return out;
}
