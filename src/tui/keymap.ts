import type { Key } from "ink";
import type { Screen } from "./types.js";

export type KeyAction =
  | "quit"
  | "help"
  | "back"
  | "refresh"
  | "warnings"
  | "history"
  | "down"
  | "up"
  | "first"
  | "last"
  | "inspect"
  | "toggle-history"
  | "cycle-filter"
  | "toggle-attempts"
  | "previous-attempt"
  | "next-attempt"
  | "next-process"
  | "stdout"
  | "stderr"
  | "page-up"
  | "page-down"
  | "plan-workflow"
  | "toggle-task"
  | "select-all"
  | "clear-selection"
  | "edit-options"
  | "option-left"
  | "option-right"
  | "cancel-workflow"
  | "resume-workflow"
  | "rerun-failed"
  | "rerun-branch"
  | "rerun-all";

export interface KeyBinding {
  keys: string;
  label: string;
  action: KeyAction;
  contexts: Array<"global" | Screen["kind"]>;
  footerPriority: number;
}

export const KEYMAP: KeyBinding[] = [
  { keys: "q", label: "quit", action: "quit", contexts: ["global"], footerPriority: 1 },
  { keys: "?", label: "help", action: "help", contexts: ["global"], footerPriority: 2 },
  { keys: "Esc/b", label: "back", action: "back", contexts: ["global"], footerPriority: 6 },
  { keys: "r", label: "refresh", action: "refresh", contexts: ["global"], footerPriority: 3 },
  { keys: "w", label: "warnings", action: "warnings", contexts: ["global"], footerPriority: 3 },
  { keys: "h", label: "history", action: "history", contexts: ["global"], footerPriority: 3 },
  { keys: "j/Down", label: "next", action: "down", contexts: ["global"], footerPriority: 0 },
  { keys: "k/Up", label: "previous", action: "up", contexts: ["global"], footerPriority: 0 },
  { keys: "g", label: "first", action: "first", contexts: ["global"], footerPriority: 0 },
  { keys: "G", label: "last", action: "last", contexts: ["global"], footerPriority: 0 },
  { keys: "Enter", label: "inspect", action: "inspect", contexts: ["global"], footerPriority: 10 },
  { keys: "Tab", label: "batch/task", action: "toggle-history", contexts: ["history"], footerPriority: 9 },
  { keys: "f", label: "filter", action: "cycle-filter", contexts: ["history"], footerPriority: 8 },
  { keys: "a", label: "attempt summary", action: "toggle-attempts", contexts: ["workflow"], footerPriority: 8 },
  { keys: "[", label: "previous attempt", action: "previous-attempt", contexts: ["attempt"], footerPriority: 10 },
  { keys: "]", label: "next attempt", action: "next-attempt", contexts: ["attempt"], footerPriority: 10 },
  { keys: "Tab", label: "next process", action: "next-process", contexts: ["attempt"], footerPriority: 9 },
  { keys: "o", label: "stdout", action: "stdout", contexts: ["attempt"], footerPriority: 8 },
  { keys: "e", label: "stderr", action: "stderr", contexts: ["attempt"], footerPriority: 8 },
  { keys: "PgUp", label: "preview up", action: "page-up", contexts: ["attempt"], footerPriority: 7 },
  { keys: "PgDn", label: "preview down", action: "page-down", contexts: ["attempt"], footerPriority: 7 },
  { keys: "p", label: "plan", action: "plan-workflow", contexts: ["dashboard"], footerPriority: 10 },
  { keys: "Space", label: "toggle task", action: "toggle-task", contexts: ["planner"], footerPriority: 10 },
  { keys: "a", label: "select all", action: "select-all", contexts: ["planner"], footerPriority: 9 },
  { keys: "x", label: "clear", action: "clear-selection", contexts: ["planner"], footerPriority: 8 },
  { keys: "e", label: "edit options", action: "edit-options", contexts: ["plan", "confirm", "resume-preview", "rerun-preview"], footerPriority: 9 },
  { keys: "h/Left", label: "previous value", action: "option-left", contexts: ["options"], footerPriority: 9 },
  { keys: "l/Right", label: "next value", action: "option-right", contexts: ["options"], footerPriority: 9 },
  { keys: "c/Ctrl+C", label: "cancel", action: "cancel-workflow", contexts: ["live", "cancel-progress"], footerPriority: 9 },
  { keys: "Tab", label: "next process", action: "next-process", contexts: ["live"], footerPriority: 8 },
  { keys: "o", label: "stdout", action: "stdout", contexts: ["live"], footerPriority: 8 },
  { keys: "e", label: "stderr", action: "stderr", contexts: ["live"], footerPriority: 8 },
  { keys: "R", label: "resume", action: "resume-workflow", contexts: ["workflow"], footerPriority: 7 },
  { keys: "f", label: "rerun failed", action: "rerun-failed", contexts: ["workflow"], footerPriority: 7 },
  { keys: "B", label: "rerun branch", action: "rerun-branch", contexts: ["workflow"], footerPriority: 6 },
  { keys: "A", label: "rerun all", action: "rerun-all", contexts: ["workflow"], footerPriority: 6 }
];

export function bindingsFor(screen: Screen["kind"]): KeyBinding[] {
  return KEYMAP.filter((binding) => {
    if (binding.action === "inspect" && !["dashboard", "history", "workflow", "task", "planner", "plan", "options", "confirm", "live", "cancel-confirm", "exit-confirm", "resume-preview", "rerun-preview"].includes(screen)) return false;
    if (binding.action === "back" && screen === "dashboard") return false;
    return binding.contexts.includes("global") || binding.contexts.includes(screen);
  });
}

export function resolveKey(input: string, key: Key, screen: Screen["kind"]): KeyAction | undefined {
  if (screen === "options" && (key.leftArrow || input === "h")) return "option-left";
  if (screen === "options" && (key.rightArrow || input === "l")) return "option-right";
  if (screen === "planner" && input === " ") return "toggle-task";
  if (screen === "planner" && input === "a") return "select-all";
  if (screen === "planner" && input === "x") return "clear-selection";
  if (screen === "dashboard" && input === "p") return "plan-workflow";
  if (["plan", "confirm", "resume-preview", "rerun-preview"].includes(screen) && input === "e") return "edit-options";
  if (["live", "cancel-progress"].includes(screen) && input === "c") return "cancel-workflow";
  if (screen === "live" && key.tab) return "next-process";
  if (screen === "live" && input === "o") return "stdout";
  if (screen === "live" && input === "e") return "stderr";
  if (screen === "workflow" && input === "R") return "resume-workflow";
  if (screen === "workflow" && input === "f") return "rerun-failed";
  if (screen === "workflow" && input === "B") return "rerun-branch";
  if (screen === "workflow" && input === "A") return "rerun-all";
  if (input === "q") return "quit";
  if (input === "?") return "help";
  if (key.escape || input === "b") return "back";
  if (input === "r") return "refresh";
  if (input === "w") return "warnings";
  if (input === "h") return "history";
  if (key.downArrow || input === "j") return "down";
  if (key.upArrow || input === "k") return "up";
  if (input === "g") return "first";
  if (input === "G") return "last";
  if (key.return) return "inspect";
  if (screen === "history" && key.tab) return "toggle-history";
  if (screen === "history" && input === "f") return "cycle-filter";
  if (screen === "workflow" && input === "a") return "toggle-attempts";
  if (screen === "attempt" && input === "[") return "previous-attempt";
  if (screen === "attempt" && input === "]") return "next-attempt";
  if (screen === "attempt" && key.tab) return "next-process";
  if (screen === "attempt" && input === "o") return "stdout";
  if (screen === "attempt" && input === "e") return "stderr";
  if (screen === "attempt" && key.pageUp) return "page-up";
  if (screen === "attempt" && key.pageDown) return "page-down";
  return undefined;
}
