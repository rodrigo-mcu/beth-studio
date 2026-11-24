import React from "react";
import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./index.css";

(window as unknown as { __bethMark?: string }).__bethMark = "main";
const bootLog: string[] = [];
function boot(line: string) {
  bootLog.push(line);
  (window as unknown as { __bethLog?: string }).__bethLog = bootLog.join("\n");
}
boot("main");
window.addEventListener("error", (e) => boot("error " + String(e.message)));
window.addEventListener("unhandledrejection", (e) => boot("reject " + String((e as PromiseRejectionEvent).reason)));
window.addEventListener("vite:preloadError", (e) => {
  (window as unknown as { __bethErr?: string }).__bethErr = "preload " + String((e as Event & { payload?: unknown }).payload);
});
const mode = new URLSearchParams(window.location.search).get("mode");
const root = ReactDOM.createRoot(document.getElementById("root")!);

// O celular tem entrada própria (phone.html, src/phone): não passa por aqui.
// A janela SFTP não pode importar App: o `new Connection()` de lá abre o
// WebSocket na hora e tira o token da URL antes do cliente HTTP ler.
if (mode === "sftp") {
  void import("./components/SftpWindowApp").then(({ SftpWindowApp }) => {
    root.render(
      <React.StrictMode>
        <SftpWindowApp />
      </React.StrictMode>,
    );
  });
} else if (mode === "term") {
  void import("./components/TermWindowApp").then(({ TermWindowApp }) => {
    root.render(
      <React.StrictMode>
        <TermWindowApp />
      </React.StrictMode>,
    );
  });
} else if (mode === "db") {
  void import("./components/DbWindowApp").then(({ DbWindowApp }) => {
    root.render(
      <React.StrictMode>
        <DbWindowApp />
      </React.StrictMode>,
    );
  });
} else {
  boot("import app");
  void import("./App").then(({ App }) => {
    boot("app loaded");
    (window as unknown as { __bethMark?: string }).__bethMark = "app";
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  }).catch((err) => {
    const msg = "app " + String(err);
    (window as unknown as { __bethErr?: string }).__bethErr = msg;
    const boot = document.getElementById("boot");
    if (boot) boot.textContent = msg;
  });
}
