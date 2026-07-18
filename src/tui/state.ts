import type { AttemptDetail, HistoryFilter, LogPreview, Screen, TuiSnapshot, TuiState } from "./types.js";

export type TuiAction =
  | { type: "navigate"; screen: Screen }
  | { type: "replace-screen"; screen: Screen }
  | { type: "dashboard" }
  | { type: "back" }
  | { type: "move"; selection: number }
  | { type: "history-mode" }
  | { type: "history-filter" }
  | { type: "toggle-attempts"; taskId: string }
  | { type: "attempt-index"; index: number }
  | { type: "process-index"; index: number }
  | { type: "stream"; stream: "stdout" | "stderr" }
  | { type: "scroll"; value: number }
  | { type: "snapshot-start"; generation: number }
  | { type: "snapshot-success"; generation: number; snapshot: TuiSnapshot }
  | { type: "snapshot-error"; generation: number; error: string }
  | { type: "attempt-start"; key: string; generation: number }
  | { type: "attempt-success"; key: string; generation: number; detail: AttemptDetail }
  | { type: "attempt-error"; key: string; generation: number; error: string }
  | { type: "log-start"; key: string; generation: number }
  | { type: "log-success"; key: string; generation: number; preview: LogPreview }
  | { type: "log-error"; key: string; generation: number; error: string };

export function initialTuiState(): TuiState {
  return {
    screen: { kind: "dashboard", selection: 0 },
    backStack: [],
    snapshotRequest: { generation: 0, loading: false },
    attempts: {},
    attemptRequests: {},
    logs: {},
    logRequests: {}
  };
}

const FILTERS: HistoryFilter[] = ["all", "failed", "running", "unapplied", "workspace"];

function withSelection(screen: Screen, selection: number): Screen {
  if (screen.kind === "help") return screen;
  return { ...screen, selection: Math.max(0, selection) } as Screen;
}

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "navigate":
      return { ...state, backStack: [...state.backStack, state.screen], screen: action.screen };
    case "replace-screen":
      return { ...state, screen: action.screen };
    case "dashboard":
      return { ...state, backStack: [], screen: { kind: "dashboard", selection: 0 } };
    case "back": {
      const previous = state.backStack.at(-1);
      return previous ? { ...state, screen: previous, backStack: state.backStack.slice(0, -1) } : { ...state, screen: { kind: "dashboard", selection: 0 } };
    }
    case "move":
      return { ...state, screen: withSelection(state.screen, action.selection) };
    case "history-mode":
      return state.screen.kind === "history" ? { ...state, screen: { ...state.screen, mode: state.screen.mode === "batches" ? "tasks" : "batches", selection: 0, filter: "all" } } : state;
    case "history-filter": {
      if (state.screen.kind !== "history") return state;
      const index = FILTERS.indexOf(state.screen.filter);
      return { ...state, screen: { ...state.screen, filter: FILTERS[(index + 1) % FILTERS.length]!, selection: 0 } };
    }
    case "toggle-attempts":
      return state.screen.kind === "workflow" ? { ...state, screen: { ...state.screen, expandedTask: state.screen.expandedTask === action.taskId ? undefined : action.taskId } } : state;
    case "attempt-index":
      return state.screen.kind === "attempt" ? { ...state, screen: { ...state.screen, attemptIndex: Math.max(0, action.index), processIndex: 0, scroll: 0 } } : state;
    case "process-index":
      return state.screen.kind === "attempt" ? { ...state, screen: { ...state.screen, processIndex: Math.max(0, action.index), scroll: 0 } } : state;
    case "stream":
      return state.screen.kind === "attempt" ? { ...state, screen: { ...state.screen, stream: action.stream, scroll: 0 } } : state;
    case "scroll":
      return state.screen.kind === "attempt" ? { ...state, screen: { ...state.screen, scroll: Math.max(0, action.value) } } : state;
    case "snapshot-start":
      if (state.snapshotRequest.loading && action.generation <= state.snapshotRequest.generation) return state;
      return { ...state, snapshotRequest: { generation: action.generation, loading: true } };
    case "snapshot-success":
      if (action.generation !== state.snapshotRequest.generation) return state;
      return { ...state, snapshot: action.snapshot, snapshotRequest: { generation: action.generation, loading: false } };
    case "snapshot-error":
      if (action.generation !== state.snapshotRequest.generation) return state;
      return { ...state, snapshotRequest: { generation: action.generation, loading: false, error: action.error } };
    case "attempt-start": {
      const previous = state.attemptRequests[action.key];
      if (previous?.loading && action.generation <= previous.generation) return state;
      return { ...state, attemptRequests: { ...state.attemptRequests, [action.key]: { generation: action.generation, loading: true } } };
    }
    case "attempt-success":
      if (state.attemptRequests[action.key]?.generation !== action.generation) return state;
      return { ...state, attempts: { ...state.attempts, [action.key]: action.detail }, attemptRequests: { ...state.attemptRequests, [action.key]: { generation: action.generation, loading: false } } };
    case "attempt-error":
      if (state.attemptRequests[action.key]?.generation !== action.generation) return state;
      return { ...state, attemptRequests: { ...state.attemptRequests, [action.key]: { generation: action.generation, loading: false, error: action.error } } };
    case "log-start":
      return { ...state, logRequests: { ...state.logRequests, [action.key]: { generation: action.generation, loading: true } } };
    case "log-success":
      if (state.logRequests[action.key]?.generation !== action.generation) return state;
      return { ...state, logs: { ...state.logs, [action.key]: action.preview }, logRequests: { ...state.logRequests, [action.key]: { generation: action.generation, loading: false } } };
    case "log-error":
      if (state.logRequests[action.key]?.generation !== action.generation) return state;
      return { ...state, logRequests: { ...state.logRequests, [action.key]: { generation: action.generation, loading: false, error: action.error } } };
  }
}
