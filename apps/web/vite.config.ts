import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiPort = process.env.BENCH_PORT ?? "8787";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } },
  },
});
