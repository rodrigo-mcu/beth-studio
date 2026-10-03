import React from "react";
import ReactDOM from "react-dom/client";
import "./phone.css";
import { PhoneApp } from "./PhoneApp";
import { applyTheme, loadTheme } from "./theme";

// Entrada própria do celular (phone.html). Não importa nada da interface do
// Studio no PC; só as bibliotecas puras de src/lib.

// Área visível real. Com o teclado aberto, o iPhone encolhe e desloca a área
// visível sem mudar o 100dvh; o app acompanha as duas coisas (altura e topo),
// senão a tela "sobe" e o campo fica fora da vista.
function trackViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement.style;
  const set = () => {
    root.setProperty("--app-h", `${Math.round(vv.height)}px`);
    root.setProperty("--vv-top", `${Math.round(Math.max(0, vv.offsetTop))}px`);
    // Teclado aberto: a área visível ficou bem menor que a janela.
    document.documentElement.toggleAttribute("data-kb", window.innerHeight - vv.height > 120);
  };
  vv.addEventListener("resize", set);
  vv.addEventListener("scroll", set);
  set();
}
trackViewport();
applyTheme(loadTheme());

if ("serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => undefined);
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PhoneApp />
  </React.StrictMode>,
);
