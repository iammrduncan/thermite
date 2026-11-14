import {
  BellIcon,
  CircleDotIcon,
  FlameIcon,
  FolderTreeIcon,
  GaugeIcon,
  ListIcon,
  type LucideIcon,
  MousePointerClickIcon,
  PaletteIcon,
  PanelLeftIcon,
  PanelTopIcon,
  SearchIcon,
  SquareMenuIcon,
  TextCursorInputIcon,
} from "lucide-react";

/**
 * The site's pages: one for each group of parts, in the brand guide's order. A page has the
 * group's rule as its one sentence, and its examples, each shown as it draws and as its code
 * (examples/<file>.tsx).
 */
export interface Example {
  /** The example's file in examples/, without its ending. */
  file: string;
  title: string;
  /** When to use the part, or what to keep to, in one or two sentences. */
  rule: string;
}

export interface Page {
  id: string;
  /** The page's icon on its line of the sidebar. */
  icon: LucideIcon;
  title: string;
  /** The group's rule, as the page's one sentence. */
  sentence: string;
  examples: Example[];
}

export const PAGES: Page[] = [
  {
    id: "foundations",
    icon: PaletteIcon,
    title: "Foundations",
    sentence: "Warm greys, one flame, and a colour for every state.",
    examples: [
      {
        file: "colours",
        title: "Colours, by their use",
        rule: "A colour is named for its use and changes by its use between light and dark. A screen sets no colour of its own: it writes the class of the use.",
      },
      {
        file: "type",
        title: "Type",
        rule: "Geist, in four sizes and two weights. Geist Mono for what a person may copy.",
      },
      {
        file: "space",
        title: "Space and corners",
        rule: "Five gaps and three corners. Text and forms sit in a column of at most 720 px; a field is at most 480 px wide.",
      },
      {
        file: "icons",
        title: "Icons",
        rule: "Lucide, 16 px, in the colour of their text. Every line of a sidebar and of a tree has one; a button may lead with one.",
      },
    ],
  },
  {
    id: "buttons",
    icon: MousePointerClickIcon,
    title: "Buttons",
    sentence: "The flame is for the one thing most people came to do. Everything else is plain.",
    examples: [
      {
        file: "buttons",
        title: "Main, plain, red, text, an icon alone, a link",
        rule: "One main button on a screen, last in its row. Red is for an act that loses work. At most three buttons at the top of a screen, each of at most three words.",
      },
    ],
  },
  {
    id: "states",
    icon: CircleDotIcon,
    title: "States and changes",
    sentence: "A state always wears its colour, with a word or a shape beside it.",
    examples: [
      {
        file: "chips",
        title: "A chip, a dot alone, a count, a legend",
        rule: "A chip is a state: the server picks its word and its kind. A dot alone is for where a word has no room. The count is for what waits for you.",
      },
      {
        file: "changes",
        title: "A change of a number",
        rule: "An arrow is a change: green when it is better and red when it is worse, whatever its direction. A number has its unit and what it is compared with.",
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
        title: "Tiles, with a sparkline or a share bar",
        rule: "The sparkline is green for the number that is the score and grey for one that must only hold. A share bar shows a whole as its parts.",
      },
    ],
  },
  {
    id: "lists",
    icon: ListIcon,
    title: "Rows, facts and tables",
    sentence: "Up to four things are rows. A table needs five, and has at most five columns.",
    examples: [
      {
        file: "rows",
        title: "A few things, as rows",
        rule: "A name with one line under it, its history and its state in the middle, its one number at the end. No table and no search for up to four things.",
      },
      {
        file: "facts",
        title: "Facts",
        rule: "What a thing is, as at most six facts: a label and its value.",
      },
      {
        file: "table",
        title: "A table",
        rule: "The first cell is a name with one short line under it, then at most four more columns with one line in a cell. Search from ten rows, with at most two filters.",
      },
    ],
  },
  {
    id: "asks",
    icon: BellIcon,
    title: "What asks, and what is empty",
    sentence: "A need is a card in amber, so the eye finds it first.",
    examples: [
      {
        file: "need-card",
        title: "A need",
        rule: "Who asks, the question, one quiet line, and the choices with the main one last. Each choice says what it does in at most twelve words.",
      },
      {
        file: "empty",
        title: "An empty list, nothing, and loading",
        rule: "An empty list is Thermy, one line and the one button that makes the first thing. Loading is one line: nothing jumps into place around it.",
      },
      {
        file: "wrong",
        title: "Something is wrong now",
        rule: "What is wrong, in the server's own words, with one way out.",
      },
    ],
  },
  {
    id: "tree",
    icon: FolderTreeIcon,
    title: "The tree, and a tool's split",
    sentence: "Folders and files, with what is picked beside them. Only a tool has two columns.",
    examples: [
      {
        file: "tree",
        title: "A tree beside what is picked",
        rule: "Every line has an icon; what is chosen is in the flame's tint. On a narrow screen what is picked goes under the tree.",
      },
    ],
  },
  {
    id: "explorer",
    icon: SearchIcon,
    title: "The explorer",
    sentence:
      "Fields with counts, the records over time, dense rows. Only an explorer is this dense.",
    examples: [
      {
        file: "explorer",
        title: "Views, fields, the band and dense rows",
        rule: "Saved views are quieter than tabs. The fields shown as columns come first; one field may be open with its most common values. The band shows the records over time, stacked by outcome: a drag across it picks the time to look at, the arrow keys move it, and Escape looks at all of it again.",
      },
    ],
  },
  {
    id: "forms",
    icon: TextCursorInputIcon,
    title: "Forms",
    sentence: 'A label with its "i", one control, an example in the field. No hint under it.',
    examples: [
      {
        file: "fields",
        title: "Fields",
        rule: 'A form asks at most seven things before its button. Help is behind the label\'s "i". A choice of a few is in sight; a choice of many is a list.',
      },
      {
        file: "fold",
        title: "Advanced, and groups of settings",
        rule: "Everything else is one section, closed when you arrive, with each default said in words. Settings that belong together are a group: a title, one line, its settings.",
      },
    ],
  },
  {
    id: "opens",
    icon: SquareMenuIcon,
    title: "What opens",
    sentence:
      "A menu for rare acts. A dialog only where work is lost. Undo where it can be undone.",
    examples: [
      {
        file: "menu",
        title: "A menu",
        rule: "At most seven lines, the red one last.",
      },
      {
        file: "dialog",
        title: "The one dialog",
        rule: "Only for work that is lost and cannot come back: a title, at most two sentences, and two buttons, the one that keeps things first.",
      },
      {
        file: "undo",
        title: "One line, and Undo",
        rule: "An act that can be undone is done at once, and says so in one line with Undo.",
      },
    ],
  },
  {
    id: "screen",
    icon: PanelTopIcon,
    title: "A screen",
    sentence: "Where it is, its name, its state, its buttons, then its one sentence.",
    examples: [
      {
        file: "screen-top",
        title: "The top of a screen, and a block",
        rule: "The sentence says the thing's state in at most 20 words, and is the largest text on the screen. A screen names its kind, which sets the budget of its first view.",
      },
      {
        file: "tabs",
        title: "Tabs",
        rule: "The parts of one thing are tabs, the chosen one with a flame line.",
      },
    ],
  },
  {
    id: "frame",
    icon: PanelLeftIcon,
    title: "The frame",
    sentence: "Every line has an icon. What grows goes last.",
    examples: [
      {
        file: "frame",
        title: "The sidebar's lines",
        rule: "Places that are fixed come first and the list that grows comes last, with set-up and the person at the foot. What is chosen is in the flame's tint, with its icon in the flame. On a phone the sidebar is a menu under a top bar: this site's own frame is the same part.",
      },
      {
        file: "lone",
        title: "A page with one thing on it",
        rule: "A page with nothing around it, such as the sign-in: one card on the sidebar's paper, with its one sentence and what it asks.",
      },
      {
        file: "alone",
        title: "One message alone",
        rule: "Before an app has its frame, a fault or a wait is one message in the middle of the page, with its way out.",
      },
    ],
  },
  {
    id: "brand",
    icon: FlameIcon,
    title: "The mark and Thermy",
    sentence: "The mark, Thermy's face, and an ID a person may copy.",
    examples: [
      {
        file: "brand",
        title: "The mark, Thermy, and an ID to copy",
        rule: "The ember and Thermy's clay are never text. Thermy keeps its own colours in light and in dark.",
      },
    ],
  },
];
