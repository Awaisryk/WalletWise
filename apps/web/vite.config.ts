/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// The SPA talks to the WalletWise API (NestJS + Fastify, port 4000) through
// this dev proxy. Proxying `/auth`, `/ai`, and `/import` to the API means the
// browser sends same-origin requests to the Vite origin, so the SuperTokens
// session cookie is included automatically. `changeOrigin` rewrites the Host
// header; `secure: false` allows the plain-HTTP local target.
const API_TARGET = "http://localhost:4000";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/auth": { target: API_TARGET, changeOrigin: true, secure: false },
      "/ai": { target: API_TARGET, changeOrigin: true, secure: false },
      "/import": { target: API_TARGET, changeOrigin: true, secure: false },
    },
  },
  test: {
    globals: true,
    environment: "happy-dom",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
