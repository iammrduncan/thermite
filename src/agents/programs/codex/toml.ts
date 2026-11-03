/** A TOML basic string (the configuration Codex reads). */
export function tomlString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === "\\" || ch === '"') out += `\\${ch}`;
    else if (c < 0x20 || c === 0x7f) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}
