// Tudo que o app nativo mexe dentro do web app do celular (WebView), em um
// lugar só. O web app não foi alterado: o app injeta pequenos scripts e só
// confia em UMA mensagem de volta (parseAck), com formato fixo.

/** Texto como literal JS seguro (sem fechar o script, sem quebrar em U+2028). */
function js(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\u003c")
    .split(String.fromCharCode(0x2028))
    .join("\u2028")
    .split(String.fromCharCode(0x2029))
    .join("\u2029");
}

/** O WebView só navega dentro do domínio configurado, por https. */
export function isAllowedNavigation(url: string, host: string): boolean {
  if (url === "about:blank") return true;
  const m = /^https:\/\/([^/?#]+)/i.exec(url);
  return !!m && (m[1] ?? "").toLowerCase() === host.toLowerCase();
}

/**
 * Entra com a senha guardada, dentro da página (o cookie HttpOnly nasce no
 * WebView) e recarrega. Se a sessão já vale, não faz nada. A senha só existe
 * dentro do script que roda no domínio do servidor da pessoa.
 */
export function loginScript(password: string): string {
  return `(function(){
  fetch("/api/phone/me", { credentials: "same-origin", cache: "no-store" }).then(function(r){
    if (r.status !== 401) return;
    return fetch("/api/phone/login", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: ${js(password)} })
    }).then(function(l){ if (l.ok) location.reload(); });
  }).catch(function(){});
})();
true;`;
}

/** Põe o texto ditado no campo "Mensagem para o terminal" e confirma ao app. */
export function deliverTextScript(id: string, text: string): string {
  return `(function(){
  var ok = false;
  try {
    var ta = document.querySelector('textarea[aria-label="Mensagem para o terminal"]') || document.querySelector("textarea");
    if (ta) {
      var cur = String(ta.value || "").replace(/\\s+$/, "");
      var add = ${js(text)}.trim();
      var next = cur && add ? cur + " " + add : (cur || add);
      var set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
      if (set && set.set) set.set.call(ta, next); else ta.value = next;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      if (ta.focus) ta.focus();
      ok = true;
    }
  } catch (e) {}
  window.ReactNativeWebView.postMessage(JSON.stringify({ beth: "ack", id: ${js(id)}, ok: ok }));
})();
true;`;
}

/** Confirmação enviada por deliverTextScript. Qualquer outra mensagem é ignorada. */
export function parseAck(raw: string): { id: string; ok: boolean } | null {
  try {
    const v = JSON.parse(raw) as { beth?: unknown; id?: unknown; ok?: unknown };
    if (v.beth !== "ack" || typeof v.id !== "string" || typeof v.ok !== "boolean") return null;
    return { id: v.id, ok: v.ok };
  } catch {
    return null;
  }
}

/** Faz o vigia de conexão do web app (lib/connection.ts) checar já: voltou à tela / voltou a rede. */
export function wakeScript(): string {
  return `(function(){
  try {
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
  } catch (e) {}
})();
true;`;
}

export interface Presence {
  appState: string;
  online: boolean;
}

/** Vale acordar a conexão? Ao voltar para o app e quando a rede volta. */
export function shouldWake(prev: Presence, next: Presence): boolean {
  if (next.appState !== "active" || !next.online) return false;
  return prev.appState !== "active" || !prev.online;
}
