import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/** The packages whose fonts and styles are in a build that uses the theme (`src/theme/`). */
const STYLED = [
  "@fontsource-variable/geist",
  "@fontsource-variable/geist-mono",
  "tailwindcss",
  "tw-animate-css",
];

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Emits `licenses-styles.md` for fonts, stylesheets, vendored shadcn/ui primitives, and optional
 * MIT provider logo sources that Vite's JS bundle license emitter does not cover.
 *
 * `packages` is the folder the build's packages are in (its `node_modules/`, with trailing slash).
 */
export const styleLicenses = (packages: string): Plugin => ({
  name: "magnesium:style-licenses",
  apply: "build",
  generateBundle() {
    const parts = STYLED.flatMap((name) => {
      const dir = `${packages}${name}/`;
      if (!existsSync(`${dir}package.json`)) return [];
      const pkg = JSON.parse(readFileSync(`${dir}package.json`, "utf8")) as {
        version: string;
        license: string;
      };
      const file = ["LICENSE", "LICENSE.md"].map((f) => dir + f).find((f) => existsSync(f));
      if (!file) throw new Error(`${name} has no licence file to ship with the build`);
      return [
        `## ${name} - ${pkg.version} (${pkg.license})\n\n${readFileSync(file, "utf8").trim()}\n`,
      ];
    });
    const stock = readFileSync(at("../src/primitives/LICENSE.md"), "utf8").trim();
    parts.push(`## shadcn/ui: stock radix-nova primitives and tailwind.css (MIT)\n\n${stock}\n`);
    parts.push(
      "## Provider logos bundle (`@iammrduncan/magnesium/provider-logos`)\n\n" +
        "Bundled SVGs are sourced from LobeHub Icons (MIT), models.dev (MIT), and llama.cpp (MIT). " +
        "Each logo remains its owner's trademark and is used nominatively to identify the provider.\n",
    );
    this.emitFile({
      type: "asset",
      fileName: "licenses-styles.md",
      source: `# Licenses of the fonts, the styles and the stock components\n\nThe fonts, styles and stock components in this build contain the following licenses:\n\n${parts.join("\n")}`,
    });
  },
});
