# Thermite's design system

One theme, the stock shadcn/ui components it is built on, and the brand's parts. Thermite's dashboard (`web/`) takes its look from here and from nowhere else, so a change made here shows on every screen. It imports nothing of Thermite, so another app can import it too.

Its site shows every part with its states, its rule and its code. Control serves the site at `/design`.

```sh
npm run web:install      # once, from the repository's root: the packages it builds with
npm run design:dev       # the site, at http://127.0.0.1:5174/design/
npm run design:build     # writes dist/, which control serves
npm run design:typecheck
```

| Folder | What it holds |
| --- | --- |
| `src/index.ts` | The door: everything an app imports |
| `src/theme.css` | The theme: every colour by its use, in light and in dark |
| `src/parts/` | The brand's parts |
| `src/brand/` | The mark, and Thermy's face |
| `src/ui/` | Stock shadcn/ui components, as its tool writes them: `npx shadcn@latest add <component>` here adds one |
| `site/` | The site: `pages.ts` lists its pages; each file of `examples/` is one example, drawn and shown as code |

## Use it in an app

```tsx
import { Act, Chip, Screen, Section } from "@ds";
```

```css
@import "../../packages/design-system/src/theme.css";
```

The app gives `@ds` to its bundler and to TypeScript as the folder `src/`, and has the packages this package names as peer dependencies.

## The rule

A component and a look are made here, never in an app. A new part gets an example on the site in the same change. A screen writes no class and no style. The repository's checks hold this: see "The design system" in [CONVENTIONS.md](../../CONVENTIONS.md) and on the [Contributing](../../docs/_site/src/content/docs/project/contributing.md#the-design-system) page.
