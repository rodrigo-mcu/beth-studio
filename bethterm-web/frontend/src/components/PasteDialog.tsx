import { useEffect, useRef, useState } from "react";

interface Props {
  onSend: (text: string) => void;
  onCancel: () => void;
}

/** Usado quando o navegador nao deixa ler a area de transferencia. */
export function PasteDialog({ onSend, onCancel }: Props) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={onCancel}>
      <div
        className="w-[min(560px,90vw)] rounded-lg border border-border-strong bg-bg-card p-4 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-1 text-[15px] font-semibold text-text-1">Colar no terminal</div>
        <div className="mb-3 text-text-2">
          O navegador não liberou a leitura da área de transferência. Cole o texto abaixo e clique em Enviar.
        </div>
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="h-40 w-full resize-none rounded border border-border bg-bg-term p-2 font-mono text-[12px] text-text-1 outline-none focus:border-accent"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button className="rounded px-3 py-1.5 text-text-2 hover:bg-bg-hover hover:text-text-1" onClick={onCancel}>
            Cancelar
          </button>
          <button
            className="rounded bg-accent px-3 py-1.5 text-white hover:bg-accent-hover disabled:opacity-50"
            disabled={!text}
            onClick={() => onSend(text)}
          >
            Enviar
          </button>
        </div>
      </div>
    </div>
  );
}
