import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

const require = createRequire(import.meta.url);

function loadLucideIndex(): Map<string, string> | null {
  try {
    const pkgPath = require.resolve("lucide-react/package.json");
    const entry = readFileSync(join(dirname(pkgPath), "dist/esm/lucide-react.mjs"), "utf8");
    return new Map(
      [...entry.matchAll(/export \{([^}]*)\} from '\.\/icons\/([^']+)'/g)].flatMap(
        ([, names, file]) =>
          names && file
            ? [...names.matchAll(/default as (\w+)/g)].map(
                ([, name]) => [name ?? "", file] as [string, string],
              )
            : [],
      ),
    );
  } catch {
    return null;
  }
}

export interface LucideIconsOptions {
  /** Filter matching file IDs whose `lucide-react` imports should be rewritten during dev serve. */
  include?: RegExp;
}

/**
 * Vite dev-only transform that rewrites barrel imports from `"lucide-react"` into per-icon ESM
 * imports (`lucide-react/dist/esm/icons/<file>`), avoiding the ~5 MB full-barrel dev parse.
 * Pair with `optimizeDeps: { exclude: ["lucide-react"] }`.
 */
export function lucideIcons(options: LucideIconsOptions = {}): Plugin {
  const include = options.include ?? /\.[cm]?[jt]sx?$/;
  let files: Map<string, string> | null | undefined;

  const fileOf = (name: string): string | undefined => {
    if (files === undefined) files = loadLucideIndex();
    return files?.get(name);
  };

  return {
    name: "magnesium:lucide-icons",
    apply: "serve",
    enforce: "pre",
    transform(code, id) {
      const cleanId = id.split("?")[0] ?? id;
      if (cleanId.includes("/node_modules/") || !include.test(cleanId)) return;
      if (!code.includes('"lucide-react"') && !code.includes("'lucide-react'")) return;

      let changed = false;
      const out = code.replace(
        /import\s*\{([^}]*)\}\s*from\s*["']lucide-react["'];?/g,
        (whole, list: string) => {
          const parts = list
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean);
          if (parts.length === 0) return whole;
          const typeParts: string[] = [];
          const iconLines: string[] = [];
          for (const part of parts) {
            if (part.startsWith("type ")) {
              typeParts.push(part);
              continue;
            }
            const [rawName, rawAlias] = part.split(/\s+as\s+/);
            const name = rawName?.trim() ?? "";
            const alias = rawAlias?.trim() || name;
            const file = fileOf(name);
            if (!file) return whole;
            iconLines.push(`import ${alias} from "lucide-react/dist/esm/icons/${file}";`);
          }
          changed = true;
          if (typeParts.length > 0) {
            iconLines.unshift(`import { ${typeParts.join(", ")} } from "lucide-react";`);
          }
          return iconLines.join("\n");
        },
      );
      return changed ? out : undefined;
    },
  };
}
