import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { styleLicenses } from "./build/licenses.ts";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The design system's site (site/): every part with its states, its rule and its code. Control
 * serves the built files at /design, with a fresh nonce in place of the placeholder in
 * index.html and in its Content Security Policy at each answer (src/control/api/web.ts).
 *
 * The packages are the app's (web/node_modules), through the link that `npm run web:install`
 * makes (scripts/design-system/link.mjs).
 */
export default defineConfig({
  root: at("./site"),
  base: "/design/",
  plugins: [react(), tailwindcss(), styleLicenses(at("./node_modules/"))],
  html: { cspNonce: "__CSP_NONCE__" },
  resolve: {
    alias: {
      // The design system's own door, as an app imports it.
      "@ds": at("./src"),
    },
  },
  server: { port: 5174, fs: { allow: [at(".")] } },
  // The licences of every package in the built script go out with it, as their terms ask.
  build: { outDir: at("./dist"), emptyOutDir: true, license: { fileName: "licenses.md" } },
});
