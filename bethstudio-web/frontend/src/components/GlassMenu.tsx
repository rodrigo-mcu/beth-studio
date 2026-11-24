import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { isMacTitlebar } from "@/lib/windowFrame";
import { MENU_ROW_SELECTOR, clickDrawnMenuRow, menuRowsFromNodes, menuSymbol, pageMenuHidden, pageMenuStyle, readMenuNode, type MenuNode } from "@/lib/glassMenu";
import { cn } from "@/lib/utils";

/** Menu flutuante do Studio. No macOS a placa é o liquid glass nativo e o
 *  texto fica na página, por cima. Clique fora e Esc fecham. O clique que
 *  abriu o menu não conta: senão o menu nasce e morre no mesmo gesto. */
export function GlassMenu({
  x,
  y,
  onClose,
  children,
  className,
  width,
}: {
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useLayoutEffect(() => { closeRef.current = onClose; }, [onClose]);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const mac = isMacTitlebar();
  const nativeMenu = pageMenuHidden(mac, typeof window !== "undefined" && !!window.webkit?.messageHandlers?.bethMenu);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8));
    setBox((cur) => {
      if (cur && cur.x === left && cur.y === top && cur.w === Math.round(r.width) && cur.h === Math.round(r.height)) return cur;
      return { x: left, y: top, w: Math.round(r.width), h: Math.round(r.height) };
    });
  });

  useEffect(() => {
    closeOtherMenus();
    const onOther = () => closeRef.current();
    window.addEventListener("beth-menu-open", onOther);
    return () => window.removeEventListener("beth-menu-open", onOther);
  }, []);

  useEffect(() => {
    let armed = false;
    const arm = window.setTimeout(() => {
      armed = true;
    }, 0);
    const close = (e: Event) => {
      if (!armed || ref.current?.contains(e.target as Node)) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(arm);
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("bt-native-menu", nativeMenu);
    return () => document.documentElement.classList.remove("bt-native-menu");
  }, [nativeMenu]);

  useEffect(() => {
    if (!mac || !box) return;
    const w = window as unknown as { webkit?: { messageHandlers?: { bethMenu?: { postMessage: (v: string) => void } } } };
    const root = ref.current?.getBoundingClientRect();
    const elements = Array.from(ref.current?.querySelectorAll(MENU_ROW_SELECTOR) ?? []);
    const nodes: MenuNode[] = root
      ? elements.map((el) => {
          const r = el.getBoundingClientRect();
          const node = readMenuNode(el);
          return { ...node, y: Math.round(r.top - root.top), h: Math.round(r.height) };
        })
      : [];
    const rows = menuRowsFromNodes(nodes).rows.map((row, i) => ({ ...row, disabled: elements[i]?.matches(":disabled") }));
    w.webkit?.messageHandlers?.bethMenu?.postMessage(JSON.stringify({ ...box, rows, ax: Math.round(x - box.x + 8) }));
  }, [mac, box, x]);

  useEffect(() => {
    if (!nativeMenu) return;
    return () => window.webkit?.messageHandlers?.bethMenu?.postMessage("[]");
  }, [nativeMenu]);

  useEffect(() => {
    if (!mac) return;
    const w = window as unknown as {
      __bethMenuClick?: (n: number) => void;
      __bethMenuClosed?: () => void;
    };
    w.__bethMenuClick = (drawnIndex) => {
      const root = ref.current;
      if (!root) return;
      const at = clickDrawnMenuRow(root, drawnIndex);
      if (at === undefined) return;
      const el = root.querySelectorAll("button")[at] as HTMLButtonElement | undefined;
      el?.click();
    };
    w.__bethMenuClosed = () => closeRef.current();
    return () => {
      w.__bethMenuClick = undefined;
      w.__bethMenuClosed = undefined;
    };
  }, [mac]);

  return createPortal(
    <div
      ref={ref}
      data-glass-menu
      className={cn("bt-menu fixed z-[80] overflow-hidden rounded-xl py-1 text-text-1", className)}
      style={{
        left: box?.x ?? x,
        top: box?.y ?? y,
        width,
        ...pageMenuStyle(mac, typeof window !== "undefined" && !!window.webkit?.messageHandlers?.bethMenu),
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  );
}

export function closeOtherMenus() {
  window.dispatchEvent(new CustomEvent("beth-menu-open"));
}

export function MenuItem({
  icon,
  label,
  disabled,
  danger,
  title,
  symbol,
  onClick,
}: {
  icon?: ReactNode;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  /** SF Symbol desenhado dentro do vidro no macOS */
  symbol?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      data-symbol={menuSymbol(symbol)}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-bg-hover disabled:cursor-default disabled:text-text-3 disabled:hover:bg-transparent",
        danger ? "text-status-err hover:bg-status-err/10" : "text-text-1",
      )}
      onClick={onClick}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

export function MenuRule() {
  return <div className="bt-menu-rule my-1 border-t border-border" />;
}

/** SF Symbol que a placa nativa desenha. O mesmo mapa do MenuItem. */
export { menuSymbol };
