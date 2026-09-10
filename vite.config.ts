import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: true,
    port: 5173,
    // Cloudflare Quick Tunnel (trycloudflare.com) — Vite host check
    allowedHosts: [".trycloudflare.com"]
  }
});
