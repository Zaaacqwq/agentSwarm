import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const hived = process.env.HIVED_URL ?? "http://127.0.0.1:4318";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { "/api": { target: hived, ws: true } },
  },
  build: { outDir: "dist", sourcemap: true },
});
