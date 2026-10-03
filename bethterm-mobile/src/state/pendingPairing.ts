import type { PairingInfo } from "@/protocol/pairing";

// O QR lido passa para o formulario em memoria, nunca por parametro de rota
// (o token nao pode aparecer em URL/log de navegacao).
let pending: PairingInfo | null = null;

export function setPendingPairing(p: PairingInfo) {
  pending = p;
}

export function takePendingPairing(): PairingInfo | null {
  const p = pending;
  pending = null;
  return p;
}
