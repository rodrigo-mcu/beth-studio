import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Build prod (./dist) e' copiado para ../webui/dist e embedado no Go via
// //go:embed. `base: "./"` deixa todos os assets relativos (porta aleatoria).
export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5181,
    strictPort: false,
    host: "127.0.0.1",
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020", // Win10+ WebView2
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom"],
          "vendor-xterm": ["@xterm/xterm", "@xterm/addon-unicode11"],
        },
      },
    },
  },
});
