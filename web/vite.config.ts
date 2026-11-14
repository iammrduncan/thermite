import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { styleLicenses } from "../packages/design-system/build/licenses.ts";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Control as the development server reaches it: the dashboard demo by default
 * (scripts/dev/dashboard-demo/main.ts), or any control named by THERMITE_WEB_CONTROL.
 */
const control = process.env.THERMITE_WEB_CONTROL ?? "http://127.0.0.1:8810";

/**
 * The app is served by control at /next. Control puts a fresh nonce in place of the placeholder
 * in index.html, and in its Content Security Policy, at each answer (src/control/api/web.ts).
 */
export default defineConfig({
  base: "/next/",
  plugins: [react(), tailwindcss(), styleLicenses(at("./node_modules/"))],
  html: { cspNonce: "__CSP_NONCE__" },
  resolve: {
    alias: {
      "@": at("./src"),
      // The design system, which the app takes its look from: its door, and its theme.
      "@ds": at("../packages/design-system/src"),
      // Control's contracts: the one thing of Thermite's the app imports.
      "@core": at("../src/core"),
      // The contracts import zod from outside this folder: they get the app's own copy.
      zod: at("./node_modules/zod"),
    },
  },
  server: {
    port: 5173,
    // The design system's files are beside the app, outside its folder.
    fs: { allow: [at("..")] },
    proxy: { "/v1": control, "/favicon.svg": control, "/ui": control },
  },
  // The licences of every package in the built script go out with it, as their terms ask.
  build: { outDir: "dist", emptyOutDir: true, license: { fileName: "licenses.md" } },
});
