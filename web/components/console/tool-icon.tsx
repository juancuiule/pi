import {
  BookOpen,
  Calculator,
  Camera,
  FilePen,
  FilePlus,
  FileText,
  FolderOpen,
  Globe,
  Keyboard,
  LayoutTemplate,
  MessageCircleQuestionMark,
  MousePointerClick,
  MoveVertical,
  Search,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// Lives beside the components (not in lib/) because it returns React components.
const ICONS: Record<string, LucideIcon> = {
  bash: SquareTerminal,
  read: FileText,
  write: FilePlus,
  edit: FilePen,
  ls: FolderOpen,
  grep: Search,
  find: Search,
  skill: BookOpen,
  calculate: Calculator,
  ask_user: MessageCircleQuestionMark,
  web_search: Globe,
  artifact_create: LayoutTemplate,
  artifact_update: LayoutTemplate,
  desktop_screenshot: Camera,
  desktop_click: MousePointerClick,
  desktop_drag: MousePointerClick,
  desktop_type: Keyboard,
  desktop_key: Keyboard,
  desktop_scroll: MoveVertical,
};

export const toolIcon = (name: string): LucideIcon => ICONS[name] ?? Wrench;
