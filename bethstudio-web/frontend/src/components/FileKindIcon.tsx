import { File } from "lucide-react";
import mikaDark from "@/assets/mika-icon-dark.png";
import mikaLight from "@/assets/mika-icon-light.png";
import muiIcon from "@/assets/mui-icon.svg";
import bundleIcon from "@/assets/bundle-icon.svg";
import ksonIcon from "@/assets/kson-icon.svg";
import kmodelIcon from "@/assets/kmodel-icon.svg";

import { symbolForFile, symbolForFolder } from "@/lib/fileSymbols";
import { cn } from "@/lib/utils";

// Ícone de arquivo/pasta nas listas do Studio. .mika e .crs usam a pomba do
// Copper. .mui e app.bundle usam a marca do Mocida (dois quadrados), a mesma
// do editor vscode-mui do copper-lang.

export function isMikaFile(name: string): boolean {
  return /\.(mika|crs)$/i.test(name);
}

export function FileKindIcon({
  name,
  isDir,
  open,
  size = 14,
  className,
}: {
  name: string;
  isDir?: boolean;
  open?: boolean;
  size?: number;
  className?: string;
}) {
  if (isDir) {
    return <Symbol src={symbolForFolder(name, !!open)} size={size} className={className} />;
  }
  if (/\.kson$/i.test(name)) return <Symbol src={ksonIcon} size={size} className={className} title="KSON" />;
  if (/\.kmodel$/i.test(name)) return <Symbol src={kmodelIcon} size={size} className={className} title="KModel" />;

  if (/\.mui$/i.test(name)) return <Symbol src={muiIcon} size={size} className={className} title="Mocida" />;
  if (/^app\.bundle$/i.test(name)) return <Symbol src={bundleIcon} size={size} className={className} title="Mocida" />;
  if (isMikaFile(name)) {
    return (
      <span className={cn("inline-flex shrink-0", className)} style={{ width: size, height: size }} title="Mikasa">
        <img src={mikaDark} alt="" className="hidden h-full w-full object-contain dark:block" draggable={false} />
        <img src={mikaLight} alt="" className="block h-full w-full object-contain dark:hidden" draggable={false} />
      </span>
    );
  }
  const src = symbolForFile(name);
  if (src) return <Symbol src={src} size={size} className={className} />;
  return <File size={size} className={cn("shrink-0 text-text-3", className)} />;
}

function Symbol({ src, size, className, title }: { src: string; size: number; className?: string; title?: string }) {
  return <img src={src} alt="" title={title} draggable={false} width={size} height={size} className={cn("shrink-0 object-contain [shape-rendering:geometricPrecision]", className)} />;
}
