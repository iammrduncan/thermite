import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { styleLicenses } from "./build/licenses.ts";
import { lucideIcons } from "./src/vite/lucide-icons.ts";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const rootModules = at("../../node_modules/");
const localModules = at("./node_modules/");
const packagesDir = existsSync(`${localModules}@fontsource-variable/geist`)
  ? localModules
  : rootModules;

/**
 * Dev-only Magnesium design-system gallery (`npm run design:dev`).
 * Serves at `/` with a live Thermite / fxbot preset switcher and `?preset=` query support.
 */
export default defineConfig({
  root: at("./site"),
  base: "/",
  plugins: [lucideIcons(), react(), tailwindcss(), styleLicenses(packagesDir)],
  optimizeDeps: {
    exclude: ["lucide-react"],
  },
  server: {
    port: 5174,
    fs: { allow: [at("."), at("../..")] },
  },
  build: {
    outDir: at("./dist"),
    emptyOutDir: true,
    license: { fileName: "licenses.md" },
  },
});
