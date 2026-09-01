import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react/") || id.includes("node_modules/react-dom/")) return "react";
          if (id.includes("@react-sigma") || id.includes("graphology")) return "graph";
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8766",
        changeOrigin: true,
      },
      "/metrics": {
        target: "http://127.0.0.1:8766",
        changeOrigin: true,
      },
      "/monitoring": {
        target: "http://127.0.0.1:8766",
        changeOrigin: true,
      },
    },
  },
});
