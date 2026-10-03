import { makeHttpClient } from "@/lib/httpClient";
import { winCommand } from "@/lib/windowFrame";
import { DbManager } from "./DbManager";

const conn = makeHttpClient();

/** Processo --db: só o banco, com botão próprio na barra de tarefas. */
export function DbWindowApp() {
  return <DbManager conn={conn} onClose={() => winCommand("close")} />;
}
