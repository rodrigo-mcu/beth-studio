import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { TIP_DELAY_MS, parseTip, placeTip, type TipPlace, type TipText } from "@/lib/tooltip";

/**
 * Tooltip de todo o app: botoes com `title` (ou qualquer elemento com
 * `data-tip`). O `title` nativo e' guardado em `data-tip-title` na primeira
 * passada do mouse, para nao aparecer duas vezes. Aparece apos ~350 ms de
 * hover e na hora ao focar pelo teclado; some ao sair, clicar, rolar ou Esc.
 * So' ouve eventos (nao cobre nada): nao atrapalha arraste nem cliques.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: TipText; anchor: Element } | null>(null);
  const [place, setPlace] = useState<TipPlace | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer: number | undefined;
    let current: Element | null = null;
    const textOf = (el: Element) => {
      const t = el.getAttribute("title");
      if (t) {
        el.setAttribute("data-tip-title", t);
        el.removeAttribute("title"); // sem o nativo junto
      }
      return el.getAttribute("data-tip") || el.getAttribute("data-tip-title") || "";
    };
    const target = (n: EventTarget | null) => {
      const el = (n as Element | null)?.closest?.("button[title],button[data-tip-title],[data-tip],[role=button][title],[role=button][data-tip-title]");
      return el ?? null; // desabilitado tambem mostra (explica por que)
    };
    const hide = () => {
      window.clearTimeout(timer);
      current = null;
      setTip(null);
      setPlace(null);
    };
    const show = (el: Element) => {
      const raw = textOf(el);
      if (!raw || !el.isConnected) return;
      setPlace(null);
      setTip({ text: parseTip(raw), anchor: el });
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const el = target(e.target);
      if (el === current) return;
      hide();
      if (!el) return;
      current = el;
      textOf(el);
      timer = window.setTimeout(() => current === el && show(el), TIP_DELAY_MS);
    };
    const out = (e: PointerEvent) => {
      if (!current) return;
      const to = e.relatedTarget as Node | null;
      if (to && current.contains(to)) return;
      hide();
    };
    const focus = (e: FocusEvent) => {
      const el = target(e.target);
      if (!el) return;
      let visible = false;
      try {
        visible = (e.target as Element).matches(":focus-visible");
      } catch {
        visible = false;
      }
      if (!visible) return;
      hide();
      current = el;
      show(el);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && hide();
    document.addEventListener("pointerover", over, true);
    document.addEventListener("pointerout", out, true);
    document.addEventListener("focusin", focus, true);
    document.addEventListener("focusout", hide, true);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("scroll", hide, true);
    document.addEventListener("wheel", hide, { capture: true, passive: true });
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("pointerout", out, true);
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("focusout", hide, true);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("scroll", hide, true);
      document.removeEventListener("wheel", hide, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  // mede o tooltip ja' renderizado e posiciona dentro da janela
  useLayoutEffect(() => {
    if (!tip || !boxRef.current) return;
    const a = tip.anchor.getBoundingClientRect();
    const b = boxRef.current.getBoundingClientRect();
    setPlace(placeTip({ left: a.left, top: a.top, width: a.width, height: a.height }, b.width, b.height, window.innerWidth, window.innerHeight));
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={boxRef}
      role="tooltip"
      className="pointer-events-none fixed z-[9999] max-w-[320px] rounded-md bg-text-1 px-2.5 py-1.5 text-[12px] leading-snug text-bg-body shadow-xl"
      style={{ left: place?.left ?? -9999, top: place?.top ?? -9999, visibility: place ? "visible" : "hidden" }}
    >
      <span
        className="absolute h-2 w-2 rotate-45 bg-text-1"
        style={place?.above ? { left: (place?.arrowX ?? 0) - 4, bottom: -4 } : { left: (place?.arrowX ?? 0) - 4, top: -4 }}
      />
      <div className="font-semibold">{tip.text.title}</div>
      {tip.text.desc && <div className="mt-0.5 opacity-80">{tip.text.desc}</div>}
    </div>
  );
}
