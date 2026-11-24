import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { isMacTitlebar } from "@/lib/windowFrame";

export interface GlassTipProps {
  title: string;
  desc?: string;
  x: number;
  y: number;
  above?: boolean;
  arrowX?: number;
}

/** Balão único do app no macOS. É um liquid glass nativo, separado das
 *  placas dos botões, e fica sempre por cima. */
export function GlassTip({ title, desc, x, y, above, arrowX }: GlassTipProps) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const w = window as unknown as { webkit?: { messageHandlers?: { bethTip?: { postMessage: (v: string) => void } } } };
    const send = () => {
      w.webkit?.messageHandlers?.bethTip?.postMessage(JSON.stringify({
        title,
        desc: desc || "",
        x: Math.round(x),
        y: Math.round(y),
        ax: Math.round(arrowX || 20),
        above: above ? 1 : 0,
      }));
    };
    send();
    setReady(true);
    return () => {
      w.webkit?.messageHandlers?.bethTip?.postMessage("[]");
    };
  }, [title, desc, x, y, above, arrowX]);
  if (!isMacTitlebar()) return null;
  return createPortal(
    <div
      className="pointer-events-none fixed z-[10000]"
      style={{ left: x, top: y, width: 1, height: 1, overflow: "hidden", opacity: 0 }}
    >
      <div className="font-medium">{title}</div>
      {desc && <div className="mt-0.5 text-white/70">{desc}</div>}
    </div>,
    document.body,
  );
}
