import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/** The packages whose fonts and styles are in a build that uses the theme (src/theme.css). */
const STYLED = [
  "@fontsource-variable/geist",
  "@fontsource-variable/geist-mono",
  "tailwindcss",
  "tw-animate-css",
];

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The licences of what is in a build and in no package of its script, as licenses-styles.md: the
 * fonts and styles (the fonts' licence asks to go with every copy of them), and shadcn/ui's
 * components and style file, which are kept in src/ui/ as its tool writes them. Vite's own list
 * (licenses.md) has those of the script's packages alone.
 *
 * `packages` is the folder the build's packages are in (its node_modules, with a slash).
 */
export const styleLicenses = (packages: string): Plugin => ({
  name: "thermite:style-licenses",
  apply: "build",
  generateBundle() {
    const parts = STYLED.map((name) => {
      const dir = `${packages}${name}/`;
      const pkg = JSON.parse(readFileSync(`${dir}package.json`, "utf8")) as {
        version: string;
        license: string;
      };
      const file = ["LICENSE", "LICENSE.md"].map((f) => dir + f).find((f) => existsSync(f));
      if (!file) throw new Error(`${name} has no licence file to ship with the build`);
      return `## ${name} - ${pkg.version} (${pkg.license})\n\n${readFileSync(file, "utf8").trim()}\n`;
    });
    const stock = readFileSync(at("../src/ui/LICENSE.md"), "utf8").trim();
    parts.push(
      `## shadcn/ui: the design system's stock components and style file (MIT)\n\n${stock}\n`,
    );
    this.emitFile({
      type: "asset",
      fileName: "licenses-styles.md",
      source: `# Licenses of the fonts, the styles and the stock components\n\nThe fonts, styles and stock components in this build contain the following licenses:\n\n${parts.join("\n")}`,
    });
  },
});
