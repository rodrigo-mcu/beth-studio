import type { MouseEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";

interface Props {
  label: string;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  active?: boolean;
  children: ReactNode;
  className?: string;
}

/** Botao so' com icone; o texto aparece no tooltip (title). */
export function IconButton({ label, onClick, disabled, active, children, className }: Props) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      className={cn(
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-2 transition-colors",
        "hover:bg-bg-hover hover:text-text-1 disabled:cursor-default disabled:text-text-3 disabled:hover:bg-transparent",
        active && "bg-accent-soft text-accent-text",
        className,
      )}
    >
      {children}
    </button>
  );
}
