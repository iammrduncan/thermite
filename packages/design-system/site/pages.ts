import {
  BellIcon,
  BlocksIcon,
  CircleDotIcon,
  FolderTreeIcon,
  GaugeIcon,
  KeyRoundIcon,
  LayoutPanelLeftIcon,
  ListIcon,
  type LucideIcon,
  MessageSquareTextIcon,
  MousePointerClickIcon,
  PaletteIcon,
  PanelLeftIcon,
  PanelTopIcon,
  SearchIcon,
  SparklesIcon,
  SquareMenuIcon,
  TextCursorInputIcon,
} from "lucide-react";

export interface Example {
  /** Example file basename under `site/examples/`. */
  file: string;
  title: string;
  /** Usage guidance in one or two sentences. */
  rule: string;
}

export interface Page {
  id: string;
  icon: LucideIcon;
  title: string;
  sentence: string;
  examples: Example[];
}

export const PAGES: Page[] = [
  {
    id: "foundations",
    icon: PaletteIcon,
    title: "Foundations",
    sentence: "Semantic surfaces, one brand accent, and five accessible status tones.",
    examples: [
      {
        file: "colours",
        title: "Colours, by their use",
        rule: "Every colour is named for its semantic role and switches automatically between light, dark, and active preset (Thermite or fxbot).",
      },
      {
        file: "type",
        title: "Type",
        rule: "Geist Variable for UI text; monospace for copyable IDs, queries, and code. Weight scale and body size adapt per preset.",
      },
      {
        file: "space",
        title: "Space and corners",
        rule: "Consistent spacing rhythm and preset-driven corner radii (3-step on Thermite, proportional 0.625 rem scale on fxbot).",
      },
      {
        file: "icons",
        title: "Icons",
        rule: "Lucide icons inherit text colour, with stroke width set by preset (1.75 on Thermite, 2 on fxbot).",
      },
    ],
  },
  {
    id: "primitives",
    icon: BlocksIcon,
    title: "Primitives",
    sentence: "26 stock shadcn/ui radix-nova primitives synced across Thermite and fxbot.",
    examples: [
      {
        file: "primitives",
        title: "Synced core primitives",
        rule: "Import directly from `@iammrduncan/magnesium/primitives` or individual subpaths (`./primitives/button`) and compose with standard Tailwind layout classes.",
      },
    ],
  },
  {
    id: "layout-panes",
    icon: LayoutPanelLeftIcon,
    title: "Layout & Panes",
    sentence:
      "Resizable panes, side inspection panels, responsive settings rails, and adaptive dialogs.",
    examples: [
      {
        file: "layout-panes",
        title: "BesidePanel, ResizeGutter, SettingsShell, ResponsiveDialog, FoldPill",
        rule: "Drag the pane gutter (or use keyboard arrows), switch responsive settings sections, open an adaptive dialog, or expand a fold pill.",
      },
    ],
  },
  {
    id: "providers",
    icon: KeyRoundIcon,
    title: "Providers",
    sentence: "API-agnostic provider catalog, lazy logos, model combobox, and device-code sign-in.",
    examples: [
      {
        file: "providers",
        title: "ProviderCatalog, ModelCombobox, DeviceCodePanel, lazy ProviderMark",
        rule: "Imported from `@iammrduncan/magnesium/providers`. Supports HTTPS, localhost, and LAN HTTP endpoints; the 183-SVG logo bundle loads lazily on demand.",
      },
    ],
  },
  {
    id: "chat-trace",
    icon: MessageSquareTextIcon,
    title: "Chat & Trace",
    sentence: "Collapsible agent traces, streaming Markdown, and chat message primitives.",
    examples: [
      {
        file: "chat-trace",
        title: "TraceSteps, Markdown, Message & Bubble",
        rule: "Isolated under `@iammrduncan/magnesium/chat` with optional peer dependencies so apps without chat or live transcripts pay zero bundle bytes.",
      },
    ],
  },
  {
    id: "buttons",
    icon: MousePointerClickIcon,
    title: "Buttons",
    sentence: "One primary action per view; everything else stays quiet and plain.",
    examples: [
      {
        file: "buttons",
        title: "Main, plain, red, text, icon-only, link",
        rule: "One main button on a screen, last in its row. Red marks actions that discard work. Control height follows `--control-h` per preset.",
      },
    ],
  },
  {
    id: "states",
    icon: CircleDotIcon,
    title: "States and changes",
    sentence: "A state always pairs its colour with a word or shape.",
    examples: [
      {
        file: "chips",
        title: "Chip, Dot, Count, Legend",
        rule: "A chip carries a status dot and label on a subtle tint. Dots stand alone in tight spaces; counts call out pending owner decisions.",
      },
      {
        file: "changes",
        title: "Change direction",
        rule: "Green means better and red means worse regardless of arrow direction.",
      },
    ],
  },
  {
    id: "numbers",
    icon: GaugeIcon,
    title: "Numbers",
    sentence: "A number, its unit, how it changed, and its history. At most four in a row.",
    examples: [
      {
        file: "numbers",
        title: "Stat tiles, Sparkline, ShareBar",
        rule: "Use green sparklines for objective metrics and neutral idle lines for guard metrics; use share bars to break down a total.",
      },
    ],
  },
  {
    id: "lists",
    icon: ListIcon,
    title: "Rows, facts and tables",
    sentence: "Up to four items use rows; five or more use a compact grid table.",
    examples: [
      {
        file: "rows",
        title: "Things and Thing rows",
        rule: "Name and subtitle on the left, sparkline and chip in the middle, primary metric on the right.",
      },
      {
        file: "facts",
        title: "Facts",
        rule: "Key-value summary pairs for an entity's essential metadata.",
      },
      {
        file: "table",
        title: "Grid table",
        rule: "First column carries title and subtitle; remaining columns stay single-line and scroll horizontally on narrow viewports.",
      },
    ],
  },
  {
    id: "asks",
    icon: BellIcon,
    title: "What asks, and what is empty",
    sentence: "Owner decisions surface in an amber card so the eye finds them first.",
    examples: [
      {
        file: "need-card",
        title: "NeedCard",
        rule: "Who is asking, the question, one concise note, and the available actions with the primary choice last.",
      },
      {
        file: "empty",
        title: "Empty, Nothing, Loading",
        rule: "Empty states accept an optional `art` prop supplied by the host app; loading stays single-line to avoid layout shift.",
      },
      {
        file: "wrong",
        title: "Wrong and Failure",
        rule: "State what failed plainly alongside a direct recovery action.",
      },
    ],
  },
  {
    id: "tree",
    icon: FolderTreeIcon,
    title: "The tree, and a tool's split",
    sentence: "Hierarchical folders and files beside detail content.",
    examples: [
      {
        file: "tree",
        title: "Tree and Split",
        rule: "Selected rows highlight in the preset brand-accent tint; on narrow viewports detail content stacks cleanly below.",
      },
    ],
  },
  {
    id: "explorer",
    icon: SearchIcon,
    title: "The explorer",
    sentence: "Facet fields with counts, a selectable timeline histogram, and dense rows.",
    examples: [
      {
        file: "explorer",
        title: "Views, Fields, Band, and dense Grid",
        rule: "Drag across the Band histogram or use Arrow/Shift+Arrow/Escape keys to narrow and reset the active time window.",
      },
    ],
  },
  {
    id: "forms",
    icon: TextCursorInputIcon,
    title: "Forms",
    sentence: 'A label with its "i" help badge, a stock-backed control, and clear defaults.',
    examples: [
      {
        file: "fields",
        title: "Fields",
        rule: "TextInput, TextArea, and Select wrap stock Input, Textarea, and NativeSelect primitives scaled by `--control-h`.",
      },
      {
        file: "fold",
        title: "Fold and Group",
        rule: "Tuck optional defaults inside Fold and cluster related settings inside Group.",
      },
    ],
  },
  {
    id: "opens",
    icon: SquareMenuIcon,
    title: "What opens",
    sentence: "Menus for rare acts, Confirm dialogs when work is lost, Undo when reversible.",
    examples: [
      {
        file: "menu",
        title: "Menu",
        rule: "At most seven items, with destructive actions placed last.",
      },
      {
        file: "dialog",
        title: "Confirm dialog",
        rule: "Reserve destructive confirmation for irreversible actions; keep the safe option first.",
      },
      {
        file: "undo",
        title: "Undo toast",
        rule: "Prefer immediate execution with a single-line Undo banner over modal prompts.",
      },
    ],
  },
  {
    id: "screen",
    icon: PanelTopIcon,
    title: "A screen",
    sentence: "Breadcrumbs, title, state chip, actions, tabs, and one headline sentence.",
    examples: [
      {
        file: "screen-top",
        title: "Screen and Section",
        rule: "Lead every screen with one concise status sentence followed by stacked sections.",
      },
      {
        file: "tabs",
        title: "Tabs",
        rule: "Active tabs take a crisp bottom rule in the preset's brand accent.",
      },
    ],
  },
  {
    id: "frame",
    icon: PanelLeftIcon,
    title: "The frame",
    sentence: "App shell with brand slot, navigation lines, and standalone pages.",
    examples: [
      {
        file: "frame",
        title: "Sidebar navigation parts",
        rule: "Frame accepts a `brand` slot from the host app and collapses into a mobile drawer under a top bar.",
      },
      {
        file: "lone",
        title: "Lone page",
        rule: "Centered card shell for sign-in or onboarding, taking host-supplied `brand` and `art` props.",
      },
      {
        file: "alone",
        title: "Alone message",
        rule: "Minimal centered layout for fatal faults or pre-shell loading.",
      },
    ],
  },
  {
    id: "brand",
    icon: SparklesIcon,
    title: "Brand slots, icons & IDs",
    sentence:
      "Product marks stay in each app; Magnesium provides procedural plugin icons and HTTP-safe copy.",
    examples: [
      {
        file: "brand",
        title: "Brand slot, procedural PluginIcon, and CopyId",
        rule: "Pass host marks via props, draw deterministic plugin emblems with PluginIcon, and copy IDs cleanly even over plain HTTP.",
      },
    ],
  },
];
