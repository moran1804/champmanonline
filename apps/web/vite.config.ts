import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      // The emulator runs in its own page (embedded in an iframe) to isolate js-dos' global CSS.
      input: {
        main: resolve(__dirname, "index.html"),
        player: resolve(__dirname, "player.html"),
        seat: resolve(__dirname, "seat.html"),
      },
    },
  },
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:8080", ws: true } },
  },
});
