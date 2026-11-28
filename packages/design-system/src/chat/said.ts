/**
 * Preserves single line breaks outside fenced code blocks by appending two spaces to non-empty
 * lines (Markdown hard break).
 */
export function breaks(text: string): string {
  let fence = "";
  return text
    .split("\n")
    .map((line) => {
      const bare = line.replace(/^(?:\s*>)*\s*(?:(?:[-+*]|\d{1,9}[.)])\s+)*/, "");
      const at = /^(`{3,}|~{3,})/.exec(bare);
      const token = at?.[1];
      if (fence) {
        if (
          token &&
          token[0] === fence[0] &&
          token.length >= fence.length &&
          !bare.slice(token.length).trim()
        ) {
          fence = "";
        }
        return line;
      }
      if (token) {
        fence = token;
        return line;
      }
      return line.trim() ? `${line}  ` : line;
    })
    .join("\n");
}

/** Matches fenced code blocks and inline code spans so text transforms skip code. */
export const code = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/;
