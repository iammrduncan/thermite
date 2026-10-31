/** One word for a POSIX shell: in single quotes, a single quote inside closed, escaped and reopened. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
