import { useCallback, useMemo, useRef } from "react";
import { highlightCode, type CodeTok } from "@/lib/codeHighlight";

// Editor do painel de arquivo: o texto digitado fica num textarea
// transparente, e o realce fica num <pre> atrás, na mesma fonte e rolagem.

// Cores do Dark+ do VS Code, as que a extensão do Copper aplica aos escopos
// de copper.tmLanguage.json. keyword.control e constant.language são roxos;
// keyword.declaration e storage.modifier são azuis; tipo primitivo é verde-água.
const COLOR: Record<CodeTok, string> = {
  kw: "text-[#C586C0]",
  decl: "text-[#569CD6]",
  mod: "text-[#569CD6]",
  str: "text-[#CE9178]",
  com: "text-[#6A9955]",
  doc: "text-[#6A9955]",
  num: "text-[#B5CEA8]",
  fn: "text-[#DCDCAA]",
  macro: "text-[#DCDCAA]",
  type: "text-[#4EC9B0]",
  prim: "text-[#4EC9B0]",
  plain: "text-[#D4D4D4]",
};

export function CodeEditor({
  value,
  onChange,
  lang,
  wrap,
  fontPx,
  label,
  textareaRef,
}: {
  value: string;
  onChange: (v: string) => void;
  lang: string;
  wrap: boolean;
  fontPx: number;
  label: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const segs = useMemo(() => highlightCode(value, lang), [value, lang]);
  const lines = Math.max(1, value.split("\n").length);
  const sync = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    if (preRef.current) {
      preRef.current.scrollTop = ta.scrollTop;
      preRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
  }, [textareaRef]);
  const text = { fontSize: fontPx, lineHeight: "1.55", tabSize: 2 } as const;

  return (
    <div className="absolute inset-0 flex bt-preview-code bg-[#1e1e1e]">
      <div ref={gutterRef} className="w-fit shrink-0 overflow-hidden border-r border-white/10 py-3 pl-2 pr-2 text-right font-mono text-[#858585] select-none" style={text}>
        {Array.from({ length: lines }, (_, n) => (
          <div key={n}>{n + 1}</div>
        ))}
      </div>
      <div className="relative min-w-0 flex-1">
        <pre
          ref={preRef}
          aria-hidden
          className={`pointer-events-none absolute inset-0 overflow-auto p-3 font-mono ${wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`}
          style={text}
        >
          {segs.map((s, i) => (
            <span key={i} className={COLOR[s.tok]}>
              {s.text}
            </span>
          ))}
          {value.endsWith("\n") || value === "" ? " " : ""}
        </pre>
        <textarea
          ref={textareaRef}
          value={value}
          spellCheck={false}
          wrap={wrap ? "soft" : "off"}
          aria-label={label}
          onChange={(e) => onChange(e.target.value)}
          onScroll={sync}
          onKeyDown={(e) => {
            if (e.key !== "Tab") return;
            e.preventDefault();
            const ta = e.currentTarget;
            const a = ta.selectionStart;
            const b = ta.selectionEnd;
            const next = value.slice(0, a) + "  " + value.slice(b);
            onChange(next);
            requestAnimationFrame(() => {
              ta.selectionStart = ta.selectionEnd = a + 2;
            });
          }}
          className={`absolute inset-0 h-full w-full resize-none bg-transparent p-3 font-mono text-transparent caret-white outline-none ${wrap ? "" : "whitespace-pre"}`}
          style={text}
        />
      </div>
    </div>
  );
}

export function CodeView({ value, lang, wrap, fontPx }: { value: string; lang: string; wrap: boolean; fontPx: number }) {
  const segs = useMemo(() => highlightCode(value, lang), [value, lang]);
  const lines = Math.max(1, value.split("\n").length);
  const text = { fontSize: fontPx, lineHeight: "1.55", tabSize: 2 } as const;
  return (
    <div className="flex min-h-full bt-preview-code bg-[#1e1e1e]">
      <div className="w-fit shrink-0 border-r border-white/10 py-0 pr-2 text-right font-mono text-[#858585] select-none" style={text}>
        {Array.from({ length: lines }, (_, n) => (
          <div key={n}>{n + 1}</div>
        ))}
      </div>
      <pre className={`min-w-0 flex-1 p-0 pl-3 font-mono ${wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`} style={text}>
        {segs.map((s, i) => (
          <span key={i} className={COLOR[s.tok]}>
            {s.text}
          </span>
        ))}
      </pre>
    </div>
  );
}
