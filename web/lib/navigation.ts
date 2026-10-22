// The console's page table and the ⌘K palette's commands: the sidebar's Pages nav and the palette's Pages
// section both derive from PAGES (components/console/sidebar.tsx, components/console/search-palette.tsx).
import type { SearchResult } from "effect-pi/api";
import {
  BookOpen,
  Flag,
  Gauge,
  LayoutTemplate,
  MessageSquare,
  Plus,
  Settings,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/** One console page: the sidebar's link and the palette's "Go to" row share it. */
export interface Page {
  readonly href: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly keywords: readonly string[];
}

/** The console's route table; the sidebar's Pages nav and the palette's Go-to commands derive from it. */
export const PAGES: readonly Page[] = [
  {
    href: "/",
    label: "Conversations",
    icon: MessageSquare,
    keywords: ["chat", "home"],
  },
  {
    href: "/skills",
    label: "Skills",
    icon: BookOpen,
    keywords: ["skill", "prompts", "agents"],
  },
  {
    href: "/artifacts",
    label: "Artifacts",
    icon: LayoutTemplate,
    keywords: ["files", "pages", "outputs"],
  },
  {
    href: "/friction",
    label: "Friction",
    icon: Flag,
    keywords: ["papercuts", "problems", "triage", "log"],
  },
  {
    href: "/capacity",
    label: "Capacity",
    icon: Gauge,
    keywords: ["perms", "permissions", "seats", "sandboxes", "limits"],
  },
  {
    href: "/settings",
    label: "Settings",
    icon: Settings,
    keywords: ["config", "preferences", "trusted domains", "theme"],
  },
];

/** A row in the palette's Pages section. `select` is for future action commands; exactly one of `href`/`select`. */
export type NavCommand = {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly keywords: readonly string[];
} & ({ readonly href: string } | { readonly select: () => void });

/** Static catalog: a "Go to" per PAGES row except "/" (its palette entry is "New conversation"), then New conversation. */
export const NAV_COMMANDS: readonly NavCommand[] = [
  ...PAGES.filter((page) => page.href !== "/").map((page) => ({
    id: `page:${page.href}`,
    label: `Go to ${page.label}`,
    icon: page.icon,
    keywords: page.keywords,
    href: page.href,
  })),
  {
    id: "new-conversation",
    label: "New conversation",
    icon: Plus,
    keywords: ["create", "start", "chat", "new chat", "home"],
    href: "/",
  },
];

/** Case-insensitive substring of the trimmed query over label, each keyword, and href; catalog order
 * kept. Empty query returns all. */
export const matchCommands = (
  commands: readonly NavCommand[],
  query: string
): readonly NavCommand[] => {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return commands;
  }
  return commands.filter(
    (command) =>
      command.label.toLowerCase().includes(needle) ||
      command.keywords.some((keyword) =>
        keyword.toLowerCase().includes(needle)
      ) ||
      ("href" in command && command.href.toLowerCase().includes(needle))
  );
};

export interface NavItem {
  readonly type: "nav";
  /** Position in the flattened listbox; optionId, aria-activedescendant and arrow keys index it. */
  readonly index: number;
  /** React key, unique across both sections, e.g. "nav:page:/skills". */
  readonly key: string;
  readonly command: NavCommand;
}

export interface ConversationItem {
  readonly type: "conversation";
  readonly index: number;
  readonly key: string;
  readonly result: SearchResult;
}

export type PaletteItem = NavItem | ConversationItem;

/** One labelled group inside the listbox; `id` narrows `items` for the renderer. */
export type PaletteSection =
  | {
      readonly id: "pages";
      readonly label: "Pages";
      readonly items: readonly NavItem[];
    }
  | {
      readonly id: "conversations";
      readonly label: "Conversations";
      readonly items: readonly ConversationItem[];
    };

/**
 * The listbox's contents for the immediate `query` plus fetched `results`. `pages` is present only
 * when at least one command matches; `conversations` is always present (it also carries the status
 * rows). Item `index` values are contiguous from 0, pages first.
 */
export const paletteSections = (
  query: string,
  results: readonly SearchResult[]
): readonly PaletteSection[] => {
  const pages: NavItem[] = matchCommands(NAV_COMMANDS, query).map(
    (command, index) => ({
      type: "nav",
      index,
      key: `nav:${command.id}`,
      command,
    })
  );
  const conversations: ConversationItem[] = results.map((result, index) => ({
    type: "conversation",
    index: pages.length + index,
    key: `conv:${result.id}`,
    result,
  }));
  const sections: PaletteSection[] = [];
  if (pages.length > 0) {
    sections.push({ id: "pages", label: "Pages", items: pages });
  }
  sections.push({
    id: "conversations",
    label: "Conversations",
    items: conversations,
  });
  return sections;
};
