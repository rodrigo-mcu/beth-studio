import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

// Build do celular: separado do Studio no PC. Sai em dist/phone (depois de
// `vite build`, que limpa dist) e é o único conteúdo que o domínio do
// celular serve (phone_gate.go). Não usa o Tailwind do Studio.
export default defineConfig({
  base: "./",
  publicDir: "phone-public",
  plugins: [
    react(),
    {
      // phone.html sai como index.html: "/" no dom�nio do celular e /phone/ no teste local.
      name: "phone-index",
      writeBundle(opts) {
        const dir = opts.dir ?? path.resolve(__dirname, "dist/phone");
        fs.renameSync(path.join(dir, "phone.html"), path.join(dir, "index.html"));
      },
    },
  ],
  css: { postcss: { plugins: [] } },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "dist/phone",
    emptyOutDir: true,
    target: "es2020",
    sourcemap: false,
    rollupOptions: {
      input: { phone: path.resolve(__dirname, "phone.html") },
    },
  },
});
