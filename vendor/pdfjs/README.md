# PDF.js, vendored

Control reads the text of PDF files in the knowledge base with Mozilla's PDF.js (goal 175). This folder holds the two files of its legacy build that text extraction needs, and its licence. Nothing else of the package is kept: no npm dependency, and no native code.

- **Version:** pdfjs-dist 6.4.299, released 2026-10-03.
- **Licence:** Apache-2.0 (`LICENSE`, from the package).
- **Where it came from:** `npm pack pdfjs-dist@6.4.299`, whose tarball matched the registry's `dist.integrity` (`sha512-AVl138zALtfaAPvADulE0PZThbYzCBS79nL4pOSL/6Sm/4AH5A21BD9VHt97OlCuzJuCpmeZtAtkinisF4Vb1g==`).

| File | From the package | SHA-256 |
| --- | --- | --- |
| `pdf.mjs` | `legacy/build/pdf.mjs` | `bc51f4874a66e3853189cb5d50aba4b3096afa83ed433b885d293a3d94583cdc` |
| `pdf.worker.mjs` | `legacy/build/pdf.worker.mjs` | `bb422f60804477de4a0b09091d8347a916a387755ed1cbad24ccaec1d09c78bf` |
| `LICENSE` | `LICENSE` | `0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594` |

Control loads the two JavaScript files only when their SHA-256 values are the ones pinned in `src/control/kb/text/pdf.ts`, in a child process that Node starts with `--no-addons`. PDF.js tries to load `@napi-rs/canvas`, its optional native part for drawing pages, and goes on without it: text extraction needs no canvas.

## Update it

1. Pick a release at least two weeks old, and read its release notes.
2. In a new, empty folder: `npm pack pdfjs-dist@<version>`. Check the tarball against `npm view pdfjs-dist@<version> dist.integrity`. Install nothing.
3. Extract it in another new folder, and copy `package/legacy/build/pdf.mjs`, `package/legacy/build/pdf.worker.mjs` and `package/LICENSE` here.
4. Write the new SHA-256 values (`shasum -a 256 vendor/pdfjs/*`) in this file and in `PDFJS_SHA256` in `src/control/kb/text/pdf.ts`, with the version in `PDFJS_VERSION`, and the version in `CREDITS.md`.
5. Run `node scripts/test.mjs tests/control/kb/text.test.ts`, which extracts the text of PDFs made in the test.
