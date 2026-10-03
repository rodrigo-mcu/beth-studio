import React from "react";
import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./index.css";

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
  void import("./App").then(({ App }) => {
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  });
}
