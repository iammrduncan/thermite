import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** The packages whose fonts and styles are in the build (src/index.css imports them). */
const STYLED = [
  "@fontsource-variable/geist",
  "@fontsource-variable/geist-mono",
  "tailwindcss",
  "tw-animate-css",
];

/**
 * The licences of what is in the build and in no package of the script, as licenses-styles.md:
 * the fonts and styles (the fonts' licence asks to go with every copy of them), and shadcn/ui's
 * components and style file, which are kept in src/components/ui/ as its tool writes them.
 * Vite's own list (licenses.md) has those of the script's packages alone.
 */
const styleLicenses = (): Plugin => ({
  name: "thermite:style-licenses",
  apply: "build",
  generateBundle() {
    const parts = STYLED.map((name) => {
      const dir = at(`./node_modules/${name}/`);
      const pkg = JSON.parse(readFileSync(`${dir}package.json`, "utf8")) as {
        version: string;
        license: string;
      };
      const file = ["LICENSE", "LICENSE.md"].map((f) => dir + f).find((f) => existsSync(f));
      if (!file) throw new Error(`${name} has no licence file to ship with the build`);
      return `## ${name} - ${pkg.version} (${pkg.license})\n\n${readFileSync(file, "utf8").trim()}\n`;
    });
    const stock = readFileSync(at("./src/components/ui/LICENSE.md"), "utf8").trim();
    parts.push(
      `## shadcn/ui: the components and the style file in src/components/ui (MIT)\n\n${stock}\n`,
    );
    this.emitFile({
      type: "asset",
      fileName: "licenses-styles.md",
      source: `# Licenses of the fonts, the styles and the stock components\n\nThe app's fonts, styles and stock components contain the following licenses:\n\n${parts.join("\n")}`,
    });
  },
});

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
  plugins: [react(), tailwindcss(), styleLicenses()],
  html: { cspNonce: "__CSP_NONCE__" },
  resolve: {
    alias: {
      "@": at("./src"),
      // Control's contracts: the one thing of Thermite's the app imports.
      "@core": at("../src/core"),
      // The contracts import zod from outside this folder: they get the app's own copy.
      zod: at("./node_modules/zod"),
    },
  },
  server: {
    port: 5173,
    proxy: { "/v1": control, "/favicon.svg": control, "/ui": control },
  },
  // The licences of every package in the built script go out with it, as their terms ask.
  build: { outDir: "dist", emptyOutDir: true, license: { fileName: "licenses.md" } },
});
