// Beth Studio no celular: abre rápido e abre mesmo com o PC fora do ar.
// Guarda só o app (HTML, JS, CSS, ícones). Nunca /api nem /ws: a tela dos
// terminais e os textos não ficam no celular.
const CACHE = "bethstudio-shell-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["./", "./manifest.webmanifest", "./icons/icon-192.png"])).catch(() => undefined));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;

  // Página: rede primeiro (versão nova); sem rede ou PC fora do ar, a guardada.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            void caches.open(CACHE).then((c) => c.put("./", copy));
            return res;
          }
          return caches.match("./").then((hit) => hit || res);
        })
        .catch(() => caches.match("./").then((hit) => hit || Response.error())),
    );
    return;
  }

  // Arquivos com hash no nome não mudam: guardados na primeira vez.
  if (url.pathname.includes("/assets/") || url.pathname.includes("/icons/")) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              void caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});
