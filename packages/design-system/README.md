# `@iammrduncan/magnesium`

Magnesium is the shared design system for Thermite and `fxbot`: semantic CSS tokens with thin brand presets, 26 stock shadcn/ui `radix-nova` primitives, composed UI parts, and optional subpath entries for providers, chat/trace transcripts, rich Input Markdown editing, and Vite icon optimization.

It imports nothing from Thermite or any host product. Brand assets (`Mark`, `Thermy`, `Blob`) stay in each consumer app and pass in via `brand` / `art` props.

## Commands

```sh
npm install              # once, from the repository root (npm workspaces)
npm run design:dev       # dev-only gallery at http://127.0.0.1:5174/?preset=thermite
npm run design:build     # builds the gallery into dist/
npm run typecheck        # typechecks the design system alongside all workspaces
```

Pass `?preset=thermite` or `?preset=fxbot` (or use the in-page Preset switcher) to preview both brand presets live in light and dark mode.

## Package layout & subpaths

| Subpath | Source | Purpose |
| --- | --- | --- |
| `@iammrduncan/magnesium` | `src/index.ts` | Convenience re-export of core parts, utilities, hooks, and non-colliding primitives |
| `@iammrduncan/magnesium/primitives` | `src/primitives/index.ts` | 21 core stock `radix-nova` shadcn/ui primitives |
| `@iammrduncan/magnesium/primitives/*` | `src/primitives/*.tsx` | Any individual primitive (including the 5 chat/trace primitives) |
| `@iammrduncan/magnesium/parts` | `src/parts/index.ts` | Composed parts (`Frame`, `Screen`, `Act`, `Chip`, `Stat`, `Grid`, `Tree`, `Explorer`, `ResizeGutter`, `BesidePanel`, `SettingsShell`, `ResponsiveDialog`, `FoldPill`, `ScreenHeader`, `PluginIcon`, `CopyId`, …) |
| `@iammrduncan/magnesium/providers` | `src/providers/index.ts` | API-agnostic `ProviderCatalog`, `ProviderConnectCard`, `ModelCombobox`, `DeviceCodePanel`, `QrCode`, and lazy `ProviderMark` |
| `@iammrduncan/magnesium/provider-logos` | `src/providers/logos.ts` | Lazy-loaded bundle of 183 MIT-licensed provider SVGs |
| `@iammrduncan/magnesium/chat` | `src/chat/index.ts` | Optional chat/trace entry (`TraceSteps`, `Markdown`, `Attachment`, `Bubble`, `Message`, `MessageScroller`, `Trace`) |
| `@iammrduncan/magnesium/editor` | `src/editor/index.ts` | Optional ProseMirror Input Markdown `Editor`, `FormatBar`, `FormatButton`, and `formatting` helpers |
| `@iammrduncan/magnesium/vite/lucide-icons` | `src/vite/lucide-icons.ts` | Vite dev plugin rewriting `lucide-react` barrel imports into per-icon imports |
| `@iammrduncan/magnesium/theme/base.css` | `src/theme/base.css` | Tailwind 4, `tw-animate-css`, `radix-nova` `tailwind.css`, `@source`, semantic tokens, and structural rules |
| `@iammrduncan/magnesium/theme/thermite.css` | `src/theme/presets/thermite.css` | Thermite brand preset (warm stone greys, flame accent, 2 weights, 3-step radii, 36 px controls, Geist Mono, Lucide 1.75) |
| `@iammrduncan/magnesium/theme/fxbot.css` | `src/theme/presets/fxbot.css` | `fxbot` brand preset (OKLCH neutral surfaces, 0.625 rem proportional radii, 500/600 weights, 32 px controls, Lucide 2) |
| `@iammrduncan/magnesium/theme/chat.css` | `src/theme/chat.css` | Optional Streamdown bubble overrides |
| `@iammrduncan/magnesium/theme/editor.css` | `src/theme/editor.css` | Optional ProseMirror / `.fx-editor` rules |

## Consumer usage

```css
@import "@iammrduncan/magnesium/theme/base.css";
@import "@iammrduncan/magnesium/theme/thermite.css"; /* or fxbot.css */
```

```tsx
import { Chip, Frame, Screen } from "@iammrduncan/magnesium/parts";
import { Badge, Button } from "@iammrduncan/magnesium/primitives";
```
