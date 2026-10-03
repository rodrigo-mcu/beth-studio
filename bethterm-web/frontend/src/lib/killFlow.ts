import type { Connection } from "./connection";

// Encerrar o PROCESSO de um terminal no host (patch 0180). E' o UNICO
// lugar do web que manda {"op":"kill"}; so' e' chamado depois da
// confirmacao do modal "Encerrar este terminal?". Fechar aba, fechar a
// visualizacao, tirar da organizacao ou fechar a janela do app nunca
// encerram terminal (tests/kill.test.ts garante isso).
export function killConfirmed(conn: Connection, pane: number): boolean {
  return conn.kill(pane);
}
