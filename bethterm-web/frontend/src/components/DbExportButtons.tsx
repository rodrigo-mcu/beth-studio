import { Copy, FileCode2, FileJson, FileSpreadsheet } from "lucide-react";
import type { DbCell, DbDriver, DbResultColumn } from "@/lib/dbApi";
import { exportFileName, rowsTSV, toCSV, toJSON } from "@/lib/dbFormat";
import { toInsertSQL } from "@/lib/dbSqlFormat";
import { copyText } from "@/lib/clipboard";

/** Baixa um texto como arquivo (a WebView2 mostra o aviso de download). */
export function downloadText(name: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

const btn = "flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-text-2 hover:bg-bg-hover hover:text-text-1 disabled:opacity-40";

/** Exportar CSV/JSON e copiar tudo — só o que já foi carregado na grade. */
export function DbExportButtons({
  base,
  columns,
  rows,
  onNotice,
  table,
  driver = "postgres",
}: {
  base: string;
  columns: DbResultColumn[] | null;
  rows: DbCell[][];
  onNotice?: (m: string) => void;
  /** nome da tabela nos INSERTs; sem isso usa o nome do arquivo */
  table?: string;
  driver?: DbDriver;
}) {
  const cols = columns ?? [];
  const empty = cols.length === 0;
  const note = `${rows.length.toLocaleString("pt-BR")} linhas carregadas`;
  return (
    <div className="flex items-center gap-0.5">
      <button
        className={btn}
        disabled={empty}
        title={`Exportar CSV separado por vírgula (${note})`}
        onClick={() => downloadText(exportFileName(base, "csv"), toCSV(cols, rows, ","), "text/csv;charset=utf-8")}
      >
        <FileSpreadsheet size={13} /> CSV
      </button>
      <button
        className={btn}
        disabled={empty}
        title={`Exportar CSV separado por ponto e vírgula, abre direto no Excel em português (${note})`}
        onClick={() => downloadText(exportFileName(base, "csv"), toCSV(cols, rows, ";"), "text/csv;charset=utf-8")}
      >
        <FileSpreadsheet size={13} /> CSV (;)
      </button>
      <button
        className={btn}
        disabled={empty}
        title={`Exportar JSON (${note})`}
        onClick={() => downloadText(exportFileName(base, "json"), toJSON(cols, rows), "application/json")}
      >
        <FileJson size={13} /> JSON
      </button>
      <button
        className={btn}
        disabled={empty || rows.length === 0}
        title={`Exportar INSERT do que está carregado (${note})`}
        onClick={() => downloadText(exportFileName(base, "sql"), toInsertSQL(table || base, cols, rows, driver), "text/sql;charset=utf-8")}
      >
        <FileCode2 size={13} /> SQL
      </button>
      <button
        className={btn}
        disabled={empty}
        title="Copiar tudo com cabeçalho (cola numa planilha)"
        onClick={async () => onNotice?.((await copyText(rowsTSV(cols, rows))) ? "Resultado copiado" : "não foi possível copiar")}
      >
        <Copy size={13} /> Copiar
      </button>
    </div>
  );
}
