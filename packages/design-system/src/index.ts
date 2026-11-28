/**
 * `@iammrduncan/magnesium` convenience entry point: core composed parts, utilities, hooks, and
 * non-colliding stock primitives.
 *
 * For explicit subpath isolation or optional peer modules (`./chat`, `./providers`, `./editor`),
 * import directly from `@iammrduncan/magnesium/primitives`, `@iammrduncan/magnesium/parts`, etc.
 */

export * from "./hooks/use-mobile.ts";
export * from "./lib/nonce.ts";
export * from "./lib/utils.ts";
export * from "./parts/index.ts";

// Re-export non-colliding core primitives (`Empty` and `Tabs` live on `./primitives` and `./parts`).
export * from "./primitives/avatar.tsx";
export * from "./primitives/badge.tsx";
export * from "./primitives/button.tsx";
export * from "./primitives/checkbox.tsx";
export * from "./primitives/collapsible.tsx";
export * from "./primitives/context-menu.tsx";
export * from "./primitives/dialog.tsx";
export * from "./primitives/dropdown-menu.tsx";
export {
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./primitives/empty.tsx";
export * from "./primitives/input.tsx";
export * from "./primitives/input-group.tsx";
export * from "./primitives/native-select.tsx";
export * from "./primitives/popover.tsx";
export * from "./primitives/separator.tsx";
export * from "./primitives/sheet.tsx";
export * from "./primitives/sidebar.tsx";
export * from "./primitives/skeleton.tsx";
export * from "./primitives/switch.tsx";
export { TabsContent, TabsList, TabsTrigger, tabsListVariants } from "./primitives/tabs.tsx";
export * from "./primitives/textarea.tsx";
export * from "./primitives/tooltip.tsx";
