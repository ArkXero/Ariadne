import React, { createContext, useContext, type ComponentProps } from "react";
import { Box, Text as InkText } from "ink";
import stringWidth from "string-width";
import type { ProcessView } from "../core/report.js";
import { filterReviewResults } from "../core/change-application.js";
import { ARIADNE_THEME } from "../theme.js";
import { bindingsFor, type KeyBinding } from "./keymap.js";
import { sanitizeTerminalText, truncateDisplay, wrapHostileLines } from "./sanitize.js";
import { liveOutputText } from "./runtime-state.js";
import type {
  AttemptDetail,
  AttemptReference,
  BatchHistoryEntry,
  HistoryFilter,
  LogPreview,
  Screen,
  TaskHistoryEntry,
  TuiSnapshot,
  TuiState,
  TuiWarning,
  TuiOperationalState,
  WorkspaceReviewFilter
} from "./types.js";

export type LayoutMode = "wide" | "compact" | "stacked" | "minimum";

export interface TuiVisualOptions {
  width: number;
  height: number;
  color: boolean;
  unicode: boolean;
  verbose?: boolean;
  layout?: LayoutMode;
}

interface TuiViewProps extends TuiVisualOptions {
  state: TuiState;
  operational?: TuiOperationalState;
}

interface PaneProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  options: TuiVisualOptions;
  focused?: boolean;
  width?: number | string;
  height?: number | string;
  flexGrow?: number;
}

export interface VisibleWindow {
  start: number;
  end: number;
}

type StatusLabel = "Passed" | "Failed" | "Running" | "Waiting" | "Blocked" | "Warning" | "Not applicable" | "Unavailable";
type StatusTone = "success" | "error" | "info" | "warning" | "muted";

const ColorThemeContext = createContext(false);

function Text({ color, ...props }: ComponentProps<typeof InkText>) {
  const enabled = useContext(ColorThemeContext);
  return <InkText {...props} color={enabled ? color ?? ARIADNE_THEME.foreground : undefined} />;
}

export function layoutFor(width: number, height: number): LayoutMode {
  if (width < 40 || height < 12) return "minimum";
  if (width >= 100 && height >= 20) return "wide";
  if (width >= 60) return "compact";
  return "stacked";
}

export function visibleWindow(total: number, selection: number, capacity: number): VisibleWindow {
  if (total <= 0) return { start: 0, end: 0 };
  const size = Math.max(1, Math.min(total, capacity));
  const selected = Math.max(0, Math.min(selection, total - 1));
  const start = Math.min(Math.max(0, selected - Math.floor(size / 2)), total - size);
  return { start, end: start + size };
}

export function windowLabel(window: VisibleWindow, total: number): string {
  return total === 0 ? "0 of 0" : `${window.start + 1}-${window.end} of ${total}`;
}

function childOptions(options: TuiVisualOptions, width: number, height: number): TuiVisualOptions {
  return { ...options, width: Math.max(1, width), height: Math.max(1, height), layout: options.layout ?? layoutFor(options.width, options.height) };
}

function pad(value: string, width: number): string {
  const clipped = truncateDisplay(value, Math.max(1, width));
  return `${clipped}${" ".repeat(Math.max(0, width - stringWidth(clipped)))}`;
}

function humanize(value: string): string {
  const text = value.replace(/[-_]/g, " ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function meta(values: string[], options: TuiVisualOptions): string {
  return values.join(options.unicode ? " · " : " | ");
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `00:00:${String(seconds).padStart(2, "0")}`;
  const minutes = Math.floor(seconds / 60);
  return `00:${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function statusLabel(value: string): StatusLabel {
  if (["pass", "passed", "succeeded", "completed", "applied"].includes(value)) return "Passed";
  if (["fail", "failed", "partially_failed", "preparation_failed", "agent_failed", "verification_failed", "policy_failed", "timeout", "internal_failed", "conflicted", "application-failed", "corrupt", "spawn-failed"].includes(value)) return "Failed";
  if (["running", "ready", "preparing", "capturing", "applying", "preflighting"].includes(value)) return "Running";
  if (["pending", "retry_wait", "incomplete"].includes(value)) return "Waiting";
  if (["blocked", "skipped"].includes(value)) return "Blocked";
  if (["warning", "interrupted", "abandoned", "succeeded_with_warnings", "retained", "stale", "unapplied", "apply-ineligible", "discarded"].includes(value)) return "Warning";
  if (["not-applicable", "metadata-only", "binary"].includes(value)) return "Not applicable";
  return "Unavailable";
}

function statusTone(label: StatusLabel): StatusTone {
  if (label === "Passed") return "success";
  if (label === "Failed") return "error";
  if (label === "Running") return "info";
  if (["Waiting", "Warning"].includes(label)) return "warning";
  return "muted";
}

function toneColor(tone: StatusTone): string {
  return tone === "success"
    ? ARIADNE_THEME.success
    : tone === "error"
      ? ARIADNE_THEME.error
      : tone === "info"
        ? ARIADNE_THEME.info
        : tone === "warning"
          ? ARIADNE_THEME.warning
          : ARIADNE_THEME.muted;
}

function statusSymbol(label: StatusLabel, unicode: boolean): string {
  if (!unicode) {
    if (label === "Passed") return "[OK]";
    if (label === "Failed") return "[FAIL]";
    if (label === "Running") return "[RUN]";
    if (label === "Waiting") return "[WAIT]";
    if (label === "Blocked") return "[BLOCK]";
    if (label === "Warning") return "[WARN]";
    return "[-]";
  }
  if (label === "Passed") return "✓";
  if (label === "Failed") return "✗";
  if (label === "Running") return "●";
  if (label === "Waiting") return "◷";
  if (label === "Blocked") return "×";
  if (label === "Warning") return "!";
  return "—";
}

function Status({ value, options, compact = false }: { value: string; options: TuiVisualOptions; compact?: boolean }) {
  const label = statusLabel(value);
  const tone = statusTone(label);
  return <Text color={toneColor(tone)} bold={tone !== "muted"}>{statusSymbol(label, options.unicode)}{compact ? "" : ` ${label}`}</Text>;
}

function StatusLine({ status, outcome, options }: { status: string; outcome?: string; options: TuiVisualOptions }) {
  const label = statusLabel(status);
  const outcomeLabel = outcome ? humanize(outcome) : undefined;
  const redundant = outcomeLabel?.toLowerCase() === label.toLowerCase();
  return <Text><Status value={status} options={options} />{outcomeLabel && !redundant ? <Text color={ARIADNE_THEME.muted}>  {outcomeLabel}</Text> : null}</Text>;
}

function Pane({ title, subtitle, children, options, focused = false, width, height, flexGrow }: PaneProps) {
  const layout = options.layout ?? layoutFor(options.width, options.height);
  const framed = layout !== "stacked";
  return <Box
    flexDirection="column"
    width={width}
    height={height}
    flexGrow={flexGrow}
    flexShrink={1}
    overflow="hidden"
    borderStyle={framed ? options.unicode ? "round" : "classic" : undefined}
    borderColor={options.color ? focused ? ARIADNE_THEME.focusedBorder : ARIADNE_THEME.border : undefined}
    paddingX={framed ? 1 : 0}
  >
    <Box height={1} flexShrink={0} overflow="hidden"><Text wrap="truncate-end"><Text color={focused ? ARIADNE_THEME.info : ARIADNE_THEME.foreground} bold>{truncateDisplay(title, 240)}</Text>{subtitle ? <Text color={ARIADNE_THEME.muted}>  {truncateDisplay(subtitle, 240)}</Text> : null}</Text></Box>
    <Box flexDirection="column" flexGrow={1} overflow="hidden">{children}</Box>
  </Box>;
}

function Empty({ text }: { text: string }) {
  return <Text color={ARIADNE_THEME.muted}>{text}</Text>;
}

function Metadata({ label, value, width }: { label: string; value: string | number; width: number }) {
  const labelWidth = Math.min(12, Math.max(7, Math.floor(width * 0.25)));
  return <Text><Text color={ARIADNE_THEME.muted}>{pad(label, labelWidth)}</Text><Text>{truncateDisplay(String(value), Math.max(1, width - labelWidth))}</Text></Text>;
}

function Selection({ selected, children }: { selected: boolean; children: React.ReactNode }) {
  return <Text color={selected ? ARIADNE_THEME.info : undefined} bold={selected}>{selected ? ">" : " "} {children}</Text>;
}

function contentCapacity(height: number, subtitle = false): number {
  return Math.max(1, height - (subtitle ? 4 : 3));
}

function paneInnerWidth(width: number, options: TuiVisualOptions): number {
  return (options.layout ?? layoutFor(options.width, options.height)) === "stacked" ? width : Math.max(1, width - 4);
}

function workflowProgress(entry: BatchHistoryEntry): string {
  return `${entry.report.summary.succeeded}/${entry.report.summary.total}`;
}

function WorkflowRow({ entry, selected, options, width, marker }: { entry: BatchHistoryEntry; selected: boolean; options: TuiVisualOptions; width: number; marker?: string }) {
  const usable = Math.max(12, width);
  const idWidth = Math.max(8, usable - 25 - (marker ? 4 : 0));
  return <Selection selected={selected}>
    {marker ? <Text color={marker === "A" ? ARIADNE_THEME.info : marker === "U" ? ARIADNE_THEME.warning : ARIADNE_THEME.muted} bold={marker !== "R"}>{marker} </Text> : null}
    <Text>{pad(entry.key, idWidth)} </Text>
    <Status value={entry.record.batchStatus} options={options} compact />
    <Text color={ARIADNE_THEME.muted}> {pad(workflowProgress(entry), 6)} {formatDuration(entry.report.durationMs)}</Text>
  </Selection>;
}

function TaskRow({ entry, selected, options, width }: { entry: TaskHistoryEntry; selected: boolean; options: TuiVisualOptions; width: number }) {
  const label = width >= 32 ? `${entry.taskId}: ${entry.name}` : entry.taskId;
  const idWidth = Math.max(8, width - 12);
  return <Selection selected={selected}>
    <Text>{pad(label, idWidth)} </Text>
    <Status value={entry.state} options={options} compact />
    <Text color={ARIADNE_THEME.muted}> {String(entry.attempts.length).padStart(2)}x</Text>
  </Selection>;
}

function AttemptRow({ entry, selected, options, width }: { entry: AttemptReference; selected: boolean; options: TuiVisualOptions; width: number }) {
  const outcomeWidth = Math.max(8, width - 27);
  return <Selection selected={selected}>
    <Text>#{String(entry.attempt).padEnd(3)} </Text>
    <Status value={entry.status} options={options} compact />
    <Text color={ARIADNE_THEME.muted}> {pad(entry.outcome, outcomeWidth)} {entry.score ?? "n/a"}{entry.final ? " F" : ""}</Text>
  </Selection>;
}

export function activeBatches(snapshot: TuiSnapshot): BatchHistoryEntry[] {
  return snapshot.batches.filter((entry) => ["running", "incomplete", "interrupted", "abandoned"].includes(entry.record.batchStatus));
}

export function recentBatches(snapshot: TuiSnapshot): BatchHistoryEntry[] {
  const active = new Set(activeBatches(snapshot).map((entry) => entry.key));
  return snapshot.batches.filter((entry) => !active.has(entry.key)).slice(0, 10);
}

export function filteredBatches(snapshot: TuiSnapshot, filter: HistoryFilter): BatchHistoryEntry[] {
  if (filter === "failed") return snapshot.batches.filter((entry) => statusLabel(entry.record.batchStatus) === "Failed");
  if (filter === "running") return snapshot.batches.filter((entry) => ["running", "incomplete"].includes(entry.record.batchStatus));
  if (filter === "unapplied") return snapshot.batches.filter((entry) => Object.values(entry.resultStates).includes("unapplied"));
  if (filter === "workspace") return snapshot.batches.filter((entry) => entry.record.plan?.isolation === "worktree");
  return snapshot.batches;
}

export function filteredTasks(snapshot: TuiSnapshot, filter: HistoryFilter): TaskHistoryEntry[] {
  if (filter === "failed") return snapshot.tasks.filter((entry) => statusLabel(entry.state) === "Failed");
  if (filter === "running") return snapshot.tasks.filter((entry) => ["running", "retry_wait", "incomplete"].includes(entry.state));
  if (filter === "unapplied") return snapshot.tasks.filter((entry) => entry.resultState === "unapplied");
  if (filter === "workspace") return snapshot.tasks.filter((entry) => Boolean(entry.workspaceState));
  return snapshot.tasks;
}

function WorkflowSummary({ entry, options, width, attached = false }: { entry?: BatchHistoryEntry; options: TuiVisualOptions; width: number; attached?: boolean }) {
  if (!entry) return <Empty text="No workflow selected." />;
  const inner = paneInnerWidth(width, options);
  return <>
    <StatusLine status={entry.record.batchStatus} outcome={entry.record.outcome} options={options} />
    {attached ? <Text color={ARIADNE_THEME.info} bold>&gt; Active runtime attached</Text>
      : ["running", "incomplete"].includes(entry.record.batchStatus) ? <Text color={ARIADNE_THEME.warning} bold>! No active runtime attached</Text> : null}
    <Metadata label="Workflow" value={entry.key} width={inner} />
    <Metadata label="Progress" value={meta([`${workflowProgress(entry)} tasks`, `score ${entry.report.score ?? "n/a"}`], options)} width={inner} />
    <Metadata label="Duration" value={formatDuration(entry.report.durationMs)} width={inner} />
    <Metadata label="Plan" value={entry.report.graph.planId ?? "unavailable"} width={inner} />
    <Metadata label="Workspace" value={meta([entry.report.isolation ?? entry.record.plan?.isolation ?? "shared", entry.report.retention ?? entry.record.plan?.retention ?? "on-failure"], options)} width={inner} />
  </>;
}

function TaskSummary({ entry, options, width }: { entry?: TaskHistoryEntry; options: TuiVisualOptions; width: number }) {
  if (!entry) return <Empty text="No task selected." />;
  const inner = paneInnerWidth(width, options);
  return <>
    <StatusLine status={entry.state} outcome={entry.outcome} options={options} />
    <Metadata label="Task" value={entry.taskId} width={inner} />
    <Metadata label="Name" value={entry.name} width={inner} />
    <Metadata label="Result" value={meta([entry.resultState, `score ${entry.score ?? "n/a"}`], options)} width={inner} />
    <Metadata label="Attempts" value={meta([String(entry.attempts.length), `final ${entry.finalAttempt ?? "unavailable"}`], options)} width={inner} />
    <Metadata label="Workspace" value={entry.workspaceState ?? "not-applicable"} width={inner} />
  </>;
}

function AttemptSummary({ entry, options, width }: { entry?: AttemptReference; options: TuiVisualOptions; width: number }) {
  if (!entry) return <Empty text="No attempt selected." />;
  const inner = paneInnerWidth(width, options);
  return <>
    <StatusLine status={entry.status} outcome={entry.outcome} options={options} />
    <Metadata label="Attempt" value={`#${entry.attempt}${entry.final ? options.unicode ? " · final" : " | final" : ""}`} width={inner} />
    <Metadata label="Run" value={entry.runId} width={inner} />
    <Metadata label="Score" value={entry.score ?? "n/a"} width={inner} />
    <Metadata label="Duration" value={formatDuration(entry.durationMs)} width={inner} />
  </>;
}

export function attentionCategories(snapshot: TuiSnapshot) {
  return [
    { value: snapshot.attention.unappliedResults, label: "unapplied results", compactLabel: "unapplied", tone: "warning" as const, target: { kind: "results" as const, filter: "unapplied" as const } },
    { value: snapshot.attention.conflictedResults, label: "application conflicts", compactLabel: "conflicts", tone: "error" as const, target: { kind: "results" as const, filter: "conflicted" as const } },
    { value: snapshot.attention.applicationFailures, label: "application failures", compactLabel: "apply failed", tone: "error" as const, target: { kind: "results" as const, filter: "application-failed" as const } },
    { value: snapshot.attention.ineligibleResults, label: "ineligible results", compactLabel: "ineligible", tone: "warning" as const, target: { kind: "results" as const, filter: "ineligible" as const } },
    { value: snapshot.attention.missingOrCorruptResults, label: "missing or corrupt results", compactLabel: "missing", tone: "error" as const, target: { kind: "results" as const, filter: "missing-artifact" as const } },
    { value: snapshot.attention.retainedWorktrees, label: "retained worktrees", compactLabel: "retained", tone: "warning" as const, target: { kind: "workspaces" as const, filter: "retained" as const } },
    { value: snapshot.attention.staleWorktrees, label: "stale worktrees", compactLabel: "stale", tone: "warning" as const, target: { kind: "workspaces" as const, filter: "stale" as const } },
    { value: snapshot.attention.cleanupFailures, label: "cleanup failures", compactLabel: "cleanup", tone: "error" as const, target: { kind: "workspaces" as const, filter: "cleanup-failure" as const } }
  ];
}

function Attention({ snapshot, screen, options, width, compact = false }: { snapshot: TuiSnapshot; screen: Extract<Screen, { kind: "dashboard" }>; options: TuiVisualOptions; width: number; compact?: boolean }) {
  const categories = attentionCategories(snapshot);
  const failedTasks = snapshot.tasks.filter((task) => statusLabel(task.state) === "Failed").slice(0, 2);
  if (compact) {
    const selected = Math.min(screen.selection, categories.length - 1);
    const window = visibleWindow(categories.length, selected, 2);
    return <>
      {categories.slice(window.start, window.end).map((item, offset) => <Selection key={item.label} selected={screen.focus === "attention" && window.start + offset === selected}>
        <Text color={item.value > 0 ? toneColor(item.tone) : ARIADNE_THEME.muted} bold={item.value > 0}>{item.value > 0 ? "!" : options.unicode ? "—" : "-"} {item.value} {truncateDisplay(item.label, Math.max(1, width - 8))}</Text>
      </Selection>)}
    </>;
  }
  return <>
    {categories.map((item, index) => <Selection key={item.label} selected={screen.focus === "attention" && screen.selection === index}>
      <Text color={item.value > 0 ? toneColor(item.tone) : ARIADNE_THEME.muted} bold={item.value > 0}>{item.value > 0 ? "!" : options.unicode ? "—" : "-"} {item.value} {item.label}</Text>
    </Selection>)}
    {failedTasks.map((task) => <Text key={task.key} color={ARIADNE_THEME.error}>  {truncateDisplay(`${task.taskId}: ${task.name}`, Math.max(1, width - 4))}</Text>)}
  </>;
}

function Dashboard({ snapshot, screen, operational, options }: { snapshot: TuiSnapshot; screen: Extract<Screen, { kind: "dashboard" }>; operational?: TuiOperationalState; options: TuiVisualOptions }) {
  const active = activeBatches(snapshot);
  const recent = recentBatches(snapshot);
  const entries = [...active, ...recent];
  const selected = Math.min(screen.selection, Math.max(0, entries.length - 1));
  const layout = layoutFor(options.width, options.height);
  const bodyHeight = options.height;
  const leftWidth = layout === "wide" ? Math.floor(options.width * 0.4) : options.width;
  const rightWidth = options.width - leftWidth;
  const capacity = contentCapacity(bodyHeight, true);
  const window = visibleWindow(entries.length, selected, capacity);
  const attachedBatchId = operational?.runtime && !operational.runtime.completedManifest ? operational.runtime.batchId : undefined;
  const unattached = active.filter((entry) => ["running", "incomplete"].includes(entry.record.batchStatus) && entry.key !== attachedBatchId).length;
  const list = <Pane
    title="Workflows"
    subtitle={meta([`${attachedBatchId ? 1 : 0} attached`, `${unattached} unattached`, `${recent.length} recent`, windowLabel(window, entries.length)], options)}
    options={childOptions(options, leftWidth, bodyHeight)}
    focused={screen.focus !== "attention"}
    width={leftWidth}
    height={bodyHeight}
  >
    {entries.length === 0 ? <Empty text="No workflow history." /> : entries.slice(window.start, window.end).map((entry, offset) => <WorkflowRow
      key={entry.key}
      entry={entry}
      selected={window.start + offset === selected}
      marker={entry.key === attachedBatchId ? "A" : window.start + offset < active.length && ["running", "incomplete"].includes(entry.record.batchStatus) ? "U" : "R"}
      options={options}
      width={paneInnerWidth(leftWidth, options)}
    />)}
  </Pane>;
  if (layout !== "wide") return <Box flexDirection="column" width={options.width} height={bodyHeight} overflow="hidden">
    <Box flexGrow={1} overflow="hidden">{list}</Box>
    <Pane title="Needs attention" options={childOptions(options, options.width, 6)} width={options.width} height={Math.min(6, Math.max(4, bodyHeight - 5))}>
      <Attention snapshot={snapshot} screen={screen} options={options} width={options.width} compact />
    </Pane>
  </Box>;
  return <Box width={options.width} height={bodyHeight} gap={0} overflow="hidden">
    {list}
    <Box flexDirection="column" width={rightWidth} height={bodyHeight} gap={0} overflow="hidden">
      <Pane title="Selected workflow" options={childOptions(options, rightWidth, 9)} width={rightWidth} height={Math.min(9, bodyHeight - 5)}>
        <WorkflowSummary entry={entries[selected]} options={options} width={rightWidth} attached={entries[selected]?.key === attachedBatchId} />
      </Pane>
      <Pane title="Needs attention" options={childOptions(options, rightWidth, bodyHeight - 10)} focused={screen.focus === "attention"} width={rightWidth} flexGrow={1}>
        <Attention snapshot={snapshot} screen={screen} options={options} width={rightWidth} />
      </Pane>
    </Box>
  </Box>;
}

function History({ snapshot, screen, options }: { snapshot: TuiSnapshot; screen: Extract<Screen, { kind: "history" }>; options: TuiVisualOptions }) {
  const batches = filteredBatches(snapshot, screen.filter);
  const tasks = filteredTasks(snapshot, screen.filter);
  const items = screen.mode === "batches" ? batches : tasks;
  const selected = Math.min(screen.selection, Math.max(0, items.length - 1));
  const layout = layoutFor(options.width, options.height);
  const leftWidth = layout === "wide" ? Math.floor(options.width * 0.4) : options.width;
  const rightWidth = options.width - leftWidth;
  const window = visibleWindow(items.length, selected, contentCapacity(options.height, true));
  const list = <Pane title="History" subtitle={meta([humanize(screen.mode), `Filter: ${humanize(screen.filter)}`, windowLabel(window, items.length)], options)} options={childOptions(options, leftWidth, options.height)} focused width={leftWidth} height={options.height}>
    {items.length === 0 ? <Empty text="No records match this filter." /> : screen.mode === "batches"
      ? batches.slice(window.start, window.end).map((entry, offset) => <WorkflowRow key={entry.key} entry={entry} selected={window.start + offset === selected} options={options} width={paneInnerWidth(leftWidth, options)} />)
      : tasks.slice(window.start, window.end).map((entry, offset) => <TaskRow key={entry.key} entry={entry} selected={window.start + offset === selected} options={options} width={paneInnerWidth(leftWidth, options)} />)}
  </Pane>;
  if (layout !== "wide") return list;
  return <Box width={options.width} height={options.height} gap={0} overflow="hidden">
    {list}
    <Pane title={screen.mode === "batches" ? "Selected workflow" : "Selected task"} options={childOptions(options, rightWidth, options.height)} width={rightWidth} height={options.height}>
      {screen.mode === "batches"
        ? <WorkflowSummary entry={batches[selected]} options={options} width={rightWidth} />
        : <TaskSummary entry={tasks[selected]} options={options} width={rightWidth} />}
    </Pane>
  </Box>;
}

function Workflow({ snapshot, screen, options }: { snapshot: TuiSnapshot; screen: Extract<Screen, { kind: "workflow" }>; options: TuiVisualOptions }) {
  const entry = snapshot.batches.find((item) => item.key === screen.batchKey);
  if (!entry) return <Pane title="Workflow" options={options} focused width={options.width} height={options.height}><Empty text="Workflow record is unavailable after refresh." /></Pane>;
  const report = entry.report;
  const selected = Math.min(screen.selection, Math.max(0, report.tasks.length - 1));
  const selectedTask = report.tasks[selected];
  const taskEntry = selectedTask ? snapshot.tasks.find((task) => task.batchId === entry.key && task.taskId === selectedTask.id) : undefined;
  const layout = layoutFor(options.width, options.height);
  const leftWidth = layout === "wide" ? Math.floor(options.width * 0.38) : options.width;
  const rightWidth = options.width - leftWidth;
  const window = visibleWindow(report.tasks.length, selected, contentCapacity(layout === "wide" ? options.height : Math.max(5, options.height - 8), true));
  const taskList = <Pane title="Tasks" subtitle={windowLabel(window, report.tasks.length)} options={childOptions(options, leftWidth, options.height)} focused width={leftWidth} height={layout === "wide" ? options.height : undefined} flexGrow={layout === "wide" ? undefined : 1}>
    {report.tasks.length === 0 ? <Empty text="No task records." /> : report.tasks.slice(window.start, window.end).map((task, offset) => {
      const index = window.start + offset;
      const width = paneInnerWidth(leftWidth, options);
      return <React.Fragment key={task.id}>
        <Selection selected={index === selected}>
          <Text>{pad(task.id, Math.max(8, width - 25))} </Text><Status value={task.status} options={options} compact />
          <Text color={ARIADNE_THEME.muted}> {task.attempts}x {task.score ?? "n/a"}</Text>
        </Selection>
        {screen.expandedTask === task.id ? task.history.slice(-2).map((attempt) => <Text key={attempt.attempt} color={ARIADNE_THEME.muted}>    #{attempt.attempt} {statusSymbol(statusLabel(attempt.status), options.unicode)} {humanize(attempt.outcome)}</Text>) : null}
      </React.Fragment>;
    })}
  </Pane>;
  const workflowOverview = <Pane title="Workflow overview" options={childOptions(options, layout === "wide" ? rightWidth : options.width, 9)} width={layout === "wide" ? rightWidth : options.width} height={9}>
    <WorkflowSummary entry={entry} options={options} width={layout === "wide" ? rightWidth : options.width} />
  </Pane>;
  if (layout !== "wide") return <Box flexDirection="column" width={options.width} height={options.height} overflow="hidden">{workflowOverview}{taskList}</Box>;
  return <Box width={options.width} height={options.height} gap={0} overflow="hidden">
    {taskList}
    <Box flexDirection="column" width={rightWidth} height={options.height} gap={0} overflow="hidden">
      {workflowOverview}
      <Pane title="Selected task" options={childOptions(options, rightWidth, report.warnings.length > 0 ? options.height - 15 : options.height - 10)} width={rightWidth} flexGrow={1}>
        {taskEntry ? <TaskSummary entry={taskEntry} options={options} width={rightWidth} /> : selectedTask ? <>
          <Text><Status value={selectedTask.status} options={options} /> <Text color={ARIADNE_THEME.muted}>{humanize(selectedTask.outcome)}</Text></Text>
          <Metadata label="Task" value={selectedTask.id} width={paneInnerWidth(rightWidth, options)} />
          <Metadata label="Name" value={selectedTask.name} width={paneInnerWidth(rightWidth, options)} />
          <Metadata label="Attempts" value={meta([String(selectedTask.attempts), `score ${selectedTask.score ?? "n/a"}`], options)} width={paneInnerWidth(rightWidth, options)} />
        </> : <Empty text="No task selected." />}
      </Pane>
      {report.warnings.length > 0 ? <Pane title="Warnings" subtitle={`${report.warnings.length}`} options={childOptions(options, rightWidth, 5)} width={rightWidth} height={5}>
        {report.warnings.slice(0, 2).map((warning, index) => <Text key={index} color={ARIADNE_THEME.warning}>! {truncateDisplay(warning, Math.max(1, rightWidth - 6))}</Text>)}
      </Pane> : null}
    </Box>
  </Box>;
}

function TaskDetailView({ entry, screen, options }: { entry: TaskHistoryEntry; screen: Extract<Screen, { kind: "task" }>; options: TuiVisualOptions }) {
  const selected = Math.min(screen.selection, Math.max(0, entry.attempts.length - 1));
  const layout = layoutFor(options.width, options.height);
  const leftWidth = layout === "wide" ? Math.floor(options.width * 0.3) : options.width;
  const rightWidth = options.width - leftWidth;
  const listHeight = layout === "wide" ? options.height : Math.max(5, options.height - 9);
  const window = visibleWindow(entry.attempts.length, selected, contentCapacity(listHeight, true));
  const attempts = <Pane title="Attempts" subtitle={windowLabel(window, entry.attempts.length)} options={childOptions(options, leftWidth, listHeight)} focused width={leftWidth} height={layout === "wide" ? options.height : undefined} flexGrow={layout === "wide" ? undefined : 1}>
    {entry.attempts.length === 0 ? <Empty text="No attempts were recorded." /> : entry.attempts.slice(window.start, window.end).map((attempt, offset) => <AttemptRow key={attempt.key} entry={attempt} selected={window.start + offset === selected} options={options} width={paneInnerWidth(leftWidth, options)} />)}
  </Pane>;
  const summary = <Pane title="Task overview" options={childOptions(options, layout === "wide" ? rightWidth : options.width, 9)} width={layout === "wide" ? rightWidth : options.width} height={9}>
    <TaskSummary entry={entry} options={options} width={layout === "wide" ? rightWidth : options.width} />
  </Pane>;
  if (layout !== "wide") return <Box flexDirection="column" width={options.width} height={options.height} overflow="hidden">{summary}{attempts}</Box>;
  return <Box width={options.width} height={options.height} gap={0} overflow="hidden">
    {attempts}
    <Box flexDirection="column" width={rightWidth} height={options.height} gap={0} overflow="hidden">
      {summary}
      <Pane title="Selected attempt" options={childOptions(options, rightWidth, options.height - 10)} width={rightWidth} flexGrow={1}>
        <AttemptSummary entry={entry.attempts[selected]} options={options} width={rightWidth} />
      </Pane>
    </Box>
  </Box>;
}

export function processesFor(detail: AttemptDetail): ProcessView[] {
  const task = detail.report.tasks[detail.taskIndex];
  return task ? [...(task.agent ? [task.agent] : []), ...task.verification] : [];
}

export function artifactFor(processView: ProcessView | undefined, stream: "stdout" | "stderr"): string | undefined {
  return stream === "stdout" ? processView?.stdoutArtifact : processView?.stderrArtifact;
}

function Preview({ preview, fallback, scroll, height, width, options }: { preview?: LogPreview; fallback: string; scroll: number; height: number; width: number; options: TuiVisualOptions }) {
  const source = preview?.status === "ready" ? preview.text : preview?.message ? `${humanize(preview.status)}: ${preview.message}` : fallback || "No output.";
  const text = wrapHostileLines(source, Math.max(10, width));
  const lines = text.split("\n");
  const metadataRows = preview ? 1 : 0;
  const capacity = Math.max(1, height - metadataRows);
  const start = Math.min(scroll, Math.max(0, lines.length - capacity));
  const visible = lines.slice(start, start + capacity);
  return <>
    {preview ? <Text color={preview.status === "ready" ? ARIADNE_THEME.muted : ["unsafe", "unreadable"].includes(preview.status) ? ARIADNE_THEME.error : ARIADNE_THEME.warning}>
      {preview.status === "ready" ? "" : `${humanize(preview.status)}${options.unicode ? " · " : " | "}`}{preview.readBytes}/{preview.totalBytes} bytes{preview.truncated ? options.unicode ? " · tail 64 KiB" : " | tail 64 KiB" : ""}
    </Text> : null}
    {visible.map((line, index) => <Text key={index}>{line || " "}</Text>)}
  </>;
}

function ProcessSummary({ processView, processIndex, processCount, stream, options, width }: { processView?: ProcessView; processIndex: number; processCount: number; stream: string; options: TuiVisualOptions; width: number }) {
  if (!processView) return <Empty text="No agent or verification process was recorded." />;
  const inner = paneInnerWidth(width, options);
  return <>
    <Text><Status value={processView.status} options={options} /> <Text color={ARIADNE_THEME.muted}>  {meta([`${processIndex + 1}/${processCount}`, stream], options)}</Text></Text>
    <Metadata label="Command" value={processView.command} width={inner} />
    <Metadata label="Exit" value={meta([String(processView.exitCode ?? "n/a"), processView.signal ?? "no signal"], options)} width={inner} />
    <Metadata label="Duration" value={formatDuration(processView.durationMs)} width={inner} />
  </>;
}

function Diagnostics({ detail, options, width }: { detail: AttemptDetail; options: TuiVisualOptions; width: number }) {
  const task = detail.report.tasks[detail.taskIndex];
  const policies = task?.policies ?? [];
  const failedPolicies = policies.filter((policy) => policy.outcome !== "pass");
  const passed = policies.length - failedPolicies.length;
  const failures = task?.failures ?? [];
  const messages = [...failures, ...failedPolicies.map((policy) => `${policy.ruleId}: ${policy.summary}`)];
  const failureMarker = options.unicode ? "✗" : "[FAIL]";
  return <>
    {messages.length === 0 ? <Text color={ARIADNE_THEME.success}>{options.unicode ? "✓" : "[OK]"} No failures</Text> : messages.slice(0, 4).map((message, index) => <Text key={index} color={ARIADNE_THEME.error}>{failureMarker} {truncateDisplay(message, Math.max(1, width - stringWidth(failureMarker) - 1))}</Text>)}
    <Text color={ARIADNE_THEME.muted}>{passed} checks passed{failedPolicies.length > 0 ? `${options.unicode ? " · " : " | "}${failedPolicies.length} failed` : ""}</Text>
  </>;
}

function AttemptView({ entry, screen, detail, preview, requestError, options }: {
  entry: TaskHistoryEntry;
  screen: Extract<Screen, { kind: "attempt" }>;
  detail?: AttemptDetail;
  preview?: LogPreview;
  requestError?: string;
  options: TuiVisualOptions;
}) {
  const reference = entry.attempts[Math.min(screen.attemptIndex, Math.max(0, entry.attempts.length - 1))];
  if (requestError) return <Pane title="Attempt" options={options} focused width={options.width} height={options.height}><Text color={ARIADNE_THEME.error}>Could not load attempt: {requestError}</Text></Pane>;
  if (!detail || !reference) return <Pane title="Attempt" options={options} focused width={options.width} height={options.height}><Text color={ARIADNE_THEME.info}>Loading attempt...</Text></Pane>;
  const task = detail.report.tasks[detail.taskIndex];
  const processes = processesFor(detail);
  const processIndex = Math.min(screen.processIndex, Math.max(0, processes.length - 1));
  const processView = processes[processIndex];
  const fallback = screen.stream === "stdout" ? processView?.stdoutPreview ?? "" : processView?.stderrPreview ?? "";
  const artifact = artifactFor(processView, screen.stream) ?? "embedded preview only";
  const layout = layoutFor(options.width, options.height);
  const leftWidth = layout === "wide" ? Math.floor(options.width * 0.36) : options.width;
  const rightWidth = options.width - leftWidth;
  const summary = <Pane title={`Attempt ${reference.attempt}${reference.final ? options.unicode ? " · final" : " | final" : ""}`} options={childOptions(options, leftWidth, 8)} width={leftWidth} height={8}>
    <Text><StatusLine status={reference.status} outcome={reference.outcome} options={options} /> <Text color={ARIADNE_THEME.muted}>  score {reference.score ?? "n/a"}</Text></Text>
    <Metadata label="Run" value={reference.runId} width={paneInnerWidth(leftWidth, options)} />
    <Metadata label="Failure" value={task?.failures[0] ?? detail.report.failures[0] ?? "none"} width={paneInnerWidth(leftWidth, options)} />
    <Metadata label="Changes" value={meta([`${task?.changedFiles.length ?? 0} files`, `${task?.diffLineCount ?? 0} lines`], options)} width={paneInnerWidth(leftWidth, options)} />
    <Metadata label="Result" value={meta([detail.resultState, detail.report.changeArtifact?.state ?? "no artifact"], options)} width={paneInnerWidth(leftWidth, options)} />
  </Pane>;
  const process = <Pane title="Process" subtitle={`${processes.length === 0 ? 0 : processIndex + 1}/${processes.length}`} options={childOptions(options, leftWidth, 7)} width={leftWidth} height={7}>
    <ProcessSummary processView={processView} processIndex={processIndex} processCount={processes.length} stream={screen.stream} options={options} width={leftWidth} />
  </Pane>;
  const diagnostics = <Pane title="Failures and policies" options={childOptions(options, leftWidth, options.height - 17)} width={leftWidth} flexGrow={1}>
    <Diagnostics detail={detail} options={options} width={paneInnerWidth(leftWidth, options)} />
  </Pane>;
  const outputWidth = layout === "wide" ? rightWidth : options.width;
  const outputHeight = layout === "wide" ? options.height : Math.max(4, options.height - 8 - (options.height >= 18 ? 5 : 0));
  const output = <Pane title="Process output" subtitle={meta([screen.stream, truncateDisplay(artifact, Math.max(8, outputWidth - 28))], options)} options={childOptions(options, outputWidth, outputHeight)} focused width={outputWidth} flexGrow={layout === "wide" ? undefined : 1} height={layout === "wide" ? options.height : undefined}>
    <Preview preview={preview} fallback={fallback} scroll={screen.scroll} height={Math.max(1, outputHeight - 4)} width={Math.max(10, paneInnerWidth(outputWidth, options))} options={options} />
  </Pane>;
  if (layout === "wide") return <Box width={options.width} height={options.height} gap={0} overflow="hidden">
    <Box flexDirection="column" width={leftWidth} height={options.height} gap={0} overflow="hidden">{summary}{process}{diagnostics}</Box>
    {output}
  </Box>;
  if (options.height < 18) return <Box flexDirection="column" width={options.width} height={options.height} overflow="hidden">
    <Pane title={`Attempt ${reference.attempt}${reference.final ? options.unicode ? " · final" : " | final" : ""}`} options={childOptions(options, options.width, 5)} width={options.width} height={5}>
      <Text><StatusLine status={reference.status} outcome={reference.outcome} options={options} /> <Text color={ARIADNE_THEME.muted}>  score {reference.score ?? "n/a"}</Text></Text>
      <Metadata label="Failure" value={task?.failures[0] ?? "none"} width={paneInnerWidth(options.width, options)} />
    </Pane>
    {output}
  </Box>;
  return <Box flexDirection="column" width={options.width} height={options.height} overflow="hidden">
    <Pane title={`Attempt ${reference.attempt}${reference.final ? options.unicode ? " · final" : " | final" : ""}`} options={childOptions(options, options.width, 7)} width={options.width} height={7}>
      <Text><StatusLine status={reference.status} outcome={reference.outcome} options={options} /> <Text color={ARIADNE_THEME.muted}>  score {reference.score ?? "n/a"}</Text></Text>
      <Metadata label="Run" value={reference.runId} width={paneInnerWidth(options.width, options)} />
      <Metadata label="Failure" value={task?.failures[0] ?? "none"} width={paneInnerWidth(options.width, options)} />
      <Metadata label="Changes" value={meta([`${task?.changedFiles.length ?? 0} files`, `${task?.diffLineCount ?? 0} lines`], options)} width={paneInnerWidth(options.width, options)} />
    </Pane>
    {output}
    <Pane title="Failures and policies" options={childOptions(options, options.width, 5)} width={options.width} height={5}>
      <Diagnostics detail={detail} options={options} width={paneInnerWidth(options.width, options)} />
    </Pane>
  </Box>;
}

function OperationalMessage({ operational }: { operational: TuiOperationalState }) {
  if (operational.loading) return <Text color={ARIADNE_THEME.info}>Loading...</Text>;
  if (operational.error) return <Text color={ARIADNE_THEME.error}>! {operational.error}</Text>;
  return null;
}

function PlannerView({ screen, operational, options }: { screen: Extract<Screen, { kind: "planner" }>; operational: TuiOperationalState; options: TuiVisualOptions }) {
  const tasks = operational.inspection?.tasks ?? [];
  const selected = Math.min(screen.selection, Math.max(0, tasks.length - 1));
  const direct = new Set(operational.draft.taskIds);
  const layout = layoutFor(options.width, options.height);
  const leftWidth = layout === "wide" ? Math.floor(options.width * 0.46) : options.width;
  const rightWidth = options.width - leftWidth;
  const window = visibleWindow(tasks.length, selected, contentCapacity(options.height, true));
  const list = <Pane title="Select tasks" subtitle={meta([`${direct.size} selected`, windowLabel(window, tasks.length)], options)} options={childOptions(options, leftWidth, options.height)} focused width={leftWidth} height={options.height}>
    <OperationalMessage operational={operational} />
    {tasks.slice(window.start, window.end).map((task, offset) => {
      const focused = window.start + offset === selected;
      const checked = direct.has(task.id);
      return <Selection key={task.id} selected={focused}>
        <Text color={checked ? ARIADNE_THEME.accent : ARIADNE_THEME.muted} bold={checked}>{checked ? "[x]" : "[ ]"}</Text>
        <Text> {pad(task.id, Math.max(8, paneInnerWidth(leftWidth, options) - 19))}</Text>
        <Text color={ARIADNE_THEME.muted}> {task.workspaceMode === "read-only" ? "read" : "edit"} {task.retry.attempts}x</Text>
      </Selection>;
    })}
    {!operational.loading && tasks.length === 0 ? <Empty text="No configured tasks." /> : null}
  </Pane>;
  if (layout !== "wide") return list;
  const task = tasks[selected];
  return <Box width={options.width} height={options.height} gap={0} overflow="hidden">
    {list}
    <Pane title="Task details" options={childOptions(options, rightWidth, options.height)} width={rightWidth} height={options.height}>
      {task ? <>
        <Text color={direct.has(task.id) ? ARIADNE_THEME.accent : ARIADNE_THEME.foreground} bold>{task.name}</Text>
        <Metadata label="Task" value={task.id} width={paneInnerWidth(rightWidth, options)} />
        <Metadata label="Depends on" value={task.dependencies.join(", ") || "none"} width={paneInnerWidth(rightWidth, options)} />
        <Metadata label="Workspace" value={task.workspaceMode} width={paneInnerWidth(rightWidth, options)} />
        <Metadata label="Retry" value={`${task.retry.attempts} attempts, ${task.retry.backoff}, ${task.retry.delayMs}ms`} width={paneInnerWidth(rightWidth, options)} />
        <Metadata label="Group" value={task.group ?? "none"} width={paneInnerWidth(rightWidth, options)} />
        <Metadata label="Tags" value={task.tags.join(", ") || "none"} width={paneInnerWidth(rightWidth, options)} />
        {task.description ? <Text>{wrapHostileLines(task.description, Math.max(10, paneInnerWidth(rightWidth, options)))}</Text> : null}
      </> : <Empty text="Select a task to inspect it." />}
    </Pane>
  </Box>;
}

function PlanReviewView({ screen, operational, options, title = "Workflow plan" }: { screen: Extract<Screen, { kind: "plan" | "resume-preview" | "rerun-preview" }>; operational: TuiOperationalState; options: TuiVisualOptions; title?: string }) {
  const preview = operational.preview;
  if (!preview) return <Pane title={title} options={options} focused width={options.width} height={options.height}><OperationalMessage operational={operational} /><Empty text="No plan preview is available." /></Pane>;
  const tasks = preview.plan.tasks;
  const selected = Math.min(screen.selection, Math.max(0, tasks.length - 1));
  const layout = layoutFor(options.width, options.height);
  const leftWidth = layout === "wide" ? Math.floor(options.width * 0.46) : options.width;
  const rightWidth = options.width - leftWidth;
  const window = visibleWindow(tasks.length, selected, contentCapacity(options.height, true));
  const list = <Pane title={title} subtitle={meta([`${preview.plan.selectedRoots.length} roots`, `${tasks.length} tasks`, `${preview.plan.levels.length} levels`], options)} options={childOptions(options, leftWidth, options.height)} focused width={leftWidth} height={options.height}>
    <OperationalMessage operational={operational} />
    {tasks.slice(window.start, window.end).map((task, offset) => <Selection key={task.id} selected={window.start + offset === selected}>
      <Text color={task.selected ? ARIADNE_THEME.accent : ARIADNE_THEME.muted} bold={task.selected}>{task.selected ? "ROOT" : options.unicode ? " DEP" : " DEP"}</Text>
      <Text> {pad(task.id, Math.max(8, paneInnerWidth(leftWidth, options) - 18))}</Text>
      <Text color={ARIADNE_THEME.muted}> L{task.level + 1} {task.retry.attempts}x</Text>
    </Selection>)}
  </Pane>;
  if (layout !== "wide") return list;
  const task = tasks[selected];
  return <Box width={options.width} height={options.height} gap={0} overflow="hidden">
    {list}
    <Box flexDirection="column" width={rightWidth} height={options.height} gap={0} overflow="hidden">
      <Pane title="Execution" options={childOptions(options, rightWidth, 11)} width={rightWidth} height={11}>
        <Metadata label="Concurrency" value={preview.plan.concurrency} width={paneInnerWidth(rightWidth, options)} />
        <Metadata label="Isolation" value={preview.plan.isolation} width={paneInnerWidth(rightWidth, options)} />
        <Metadata label="Failure" value={preview.plan.failureMode} width={paneInnerWidth(rightWidth, options)} />
        <Metadata label="Retention" value={preview.plan.retention} width={paneInnerWidth(rightWidth, options)} />
        <Metadata label="Repository" value={preview.sourceDirty ? "dirty" : "clean"} width={paneInnerWidth(rightWidth, options)} />
        <Metadata label="Source" value={preview.sourceHead ?? "unavailable"} width={paneInnerWidth(rightWidth, options)} />
        <Metadata label="Schedule" value={preview.plan.levels.map((level, index) => `L${index + 1}:${level.join(",")}`).join("  ")} width={paneInnerWidth(rightWidth, options)} />
        <Metadata label="Groups" value={preview.plan.concurrencyGroups.map((group, index) => `G${index + 1}:${group.join("+")}`).join("  ")} width={paneInnerWidth(rightWidth, options)} />
      </Pane>
      <Pane title="Selected task" options={childOptions(options, rightWidth, 8)} width={rightWidth} height={8}>
        {task ? <>
          <Text color={task.selected ? ARIADNE_THEME.accent : ARIADNE_THEME.foreground} bold>{task.selected ? "Direct root" : "Included dependency"}  {task.id}</Text>
          <Metadata label="Depends on" value={task.dependencies.join(", ") || "none"} width={paneInnerWidth(rightWidth, options)} />
          <Metadata label="Workspace" value={task.workspaceMode} width={paneInnerWidth(rightWidth, options)} />
          <Metadata label="Verify" value={`${task.verification.length} commands`} width={paneInnerWidth(rightWidth, options)} />
        </> : <Empty text="No task selected." />}
      </Pane>
      <Pane title="Warnings and blockers" subtitle={`${preview.warnings.length}/${preview.blockers.length}`} options={childOptions(options, rightWidth, options.height - 19)} width={rightWidth} flexGrow={1}>
        {preview.blockers.map((blocker) => <Text key={blocker.code} color={ARIADNE_THEME.error}>! {truncateDisplay(`${blocker.message} ${blocker.correction}`, Math.max(10, rightWidth - 6))}</Text>)}
        {preview.warnings.slice(0, 4).map((warning, index) => <Text key={index} color={ARIADNE_THEME.warning}>! {truncateDisplay(warning, Math.max(10, rightWidth - 6))}</Text>)}
        {preview.blockers.length === 0 && preview.warnings.length === 0 ? <Text color={ARIADNE_THEME.success}>{options.unicode ? "✓" : "[OK]"} Ready to launch</Text> : null}
      </Pane>
    </Box>
  </Box>;
}

function OptionsView({ screen, operational, options }: { screen: Extract<Screen, { kind: "options" }>; operational: TuiOperationalState; options: TuiVisualOptions }) {
  const values = operational.draft.overrides;
  const rows = [
    ["Concurrency", String(values.concurrency ?? operational.inspection?.defaults.concurrency ?? 1)],
    ["Failure mode", values.failureMode ?? operational.preview?.plan.failureMode ?? "continue"],
    ["Isolation", values.isolation ?? operational.preview?.plan.isolation ?? "shared"],
    ["Dirty base", values.allowDirtyBase ? "acknowledged" : "not acknowledged"]
  ];
  return <Pane title="Execution options" subtitle="Changes are replanned before launch" options={options} focused width={options.width} height={options.height}>
    <OperationalMessage operational={operational} />
    {rows.map(([label, value], index) => <Selection key={label} selected={screen.selection === index}>
      <Text color={screen.selection === index ? ARIADNE_THEME.info : ARIADNE_THEME.muted}>{pad(label!, 18)}</Text>
      <Text bold={screen.selection === index}>{value}</Text>
    </Selection>)}
    <Text> </Text>
    <Text color={ARIADNE_THEME.muted}>Use h/l or Left/Right. Concurrency is constrained to 1..32.</Text>
  </Pane>;
}

function LaunchConfirmation({ operational, options }: { operational: TuiOperationalState; options: TuiVisualOptions }) {
  const preview = operational.preview;
  const blocked = Boolean(preview?.blockers[0]);
  return <Pane title="Launch workflow?" subtitle="Explicit confirmation required" options={options} focused width={options.width} height={options.height}>
    <OperationalMessage operational={operational} />
    {preview ? <>
      <Text color={blocked ? ARIADNE_THEME.error : ARIADNE_THEME.accent} bold>{blocked ? "Launch blocked" : "Ready to launch"}</Text>
      <Metadata label="Tasks" value={preview.plan.tasks.length} width={paneInnerWidth(options.width, options)} />
      <Metadata label="Roots" value={preview.plan.selectedRoots.join(", ")} width={paneInnerWidth(options.width, options)} />
      <Metadata label="Dependencies" value={preview.plan.tasks.filter((task) => !task.selected).map((task) => task.id).join(", ") || "none"} width={paneInnerWidth(options.width, options)} />
      <Metadata label="Concurrency" value={preview.plan.concurrency} width={paneInnerWidth(options.width, options)} />
      <Metadata label="Isolation" value={preview.plan.isolation} width={paneInnerWidth(options.width, options)} />
      <Metadata label="Failure mode" value={preview.plan.failureMode} width={paneInnerWidth(options.width, options)} />
      <Metadata label="Repository" value={preview.sourceDirty ? "dirty" : "clean"} width={paneInnerWidth(options.width, options)} />
      {operational.resumePreview ? <Metadata label="Resume" value={`${operational.resumePreview.reusableTaskIds.length} reusable, ${operational.resumePreview.requeuedTaskIds.length} requeued`} width={paneInnerWidth(options.width, options)} /> : null}
      {operational.rerunPreview ? <Metadata label="Rerun" value={`${operational.rerunPreview.mode}: ${operational.rerunPreview.selectedSourceTaskIds.join(", ")}`} width={paneInnerWidth(options.width, options)} /> : null}
      {preview.blockers.map((blocker) => <Text key={blocker.code} color={ARIADNE_THEME.error}>! {blocker.message} {blocker.correction}</Text>)}
      <Text> </Text>
      <Text><Text color={ARIADNE_THEME.info} bold>Enter</Text> {blocked ? "blocked" : "launch"}  <Text color={ARIADNE_THEME.info} bold>e</Text> edit options  <Text color={ARIADNE_THEME.info} bold>Esc</Text> cancel</Text>
    </> : <Empty text="No plan is available." />}
  </Pane>;
}

function retryCountdown(retryAt: string | undefined, now: number): string | undefined {
  if (!retryAt) return undefined;
  return `${Math.max(0, Math.ceil((Date.parse(retryAt) - now) / 1_000))}s`;
}

function LiveWorkflowView({ screen, operational, options }: { screen: Extract<Screen, { kind: "live" | "cancel-progress" }>; operational: TuiOperationalState; options: TuiVisualOptions }) {
  const runtime = operational.runtime;
  if (!runtime) return <Pane title="Live workflow" options={options} focused width={options.width} height={options.height}><OperationalMessage operational={operational} /><Empty text="No attached runtime." /></Pane>;
  const selected = Math.min(screen.selection, Math.max(0, runtime.tasks.length - 1));
  const task = runtime.tasks[selected];
  const processIndex = Math.min("processIndex" in screen ? screen.processIndex : 0, Math.max(0, (task?.processes.length ?? 1) - 1));
  const process = task?.processes[processIndex];
  const stream = "stream" in screen ? screen.stream : "stdout";
  const output = process ? liveOutputText(process[stream]) : "No process output yet.";
  const layout = layoutFor(options.width, options.height);
  const leftWidth = layout === "wide" ? Math.floor(options.width * 0.43) : options.width;
  const rightWidth = options.width - leftWidth;
  const taskList = (width: number, height: number) => {
    const window = visibleWindow(runtime.tasks.length, selected, contentCapacity(height, true));
    return <Pane title={`Workflow ${runtime.batchId}`} subtitle={meta([runtime.status, `${runtime.summary.succeeded}/${runtime.summary.total} complete`, `${runtime.summary.retried} retried`, `${runtime.summary.blocked} blocked`, windowLabel(window, runtime.tasks.length)], options)} options={childOptions(options, width, height)} focused width={width} height={height}>
    {runtime.tasks.slice(window.start, window.end).map((item, offset) => {
      const index = window.start + offset;
      const countdown = retryCountdown(item.retryAt, operational.clock);
      return <Selection key={item.id} selected={index === selected}>
        <Text>{pad(item.id, Math.max(8, paneInnerWidth(width, options) - 24))} </Text>
        <Status value={item.state} options={options} compact />
        <Text color={ARIADNE_THEME.muted}> {item.attempt > 0 ? `${item.attempt}x` : "—"}{countdown ? ` ${countdown}` : ""}</Text>
      </Selection>;
    })}
  </Pane>;
  };
  const outputLines = (width: number, height: number) => wrapHostileLines(output, Math.max(10, paneInnerWidth(width, options)))
    .split("\n")
    .slice(-Math.max(1, height - 4));
  if (layout !== "wide") {
    const taskHeight = Math.min(10, Math.max(6, Math.floor(options.height * 0.38)));
    const outputHeight = Math.max(4, options.height - taskHeight);
    return <Box flexDirection="column" width={options.width} height={options.height} gap={0} overflow="hidden">
      {taskList(options.width, taskHeight)}
      <Pane title={task ? `${task.id} live output` : "Live output"} subtitle={process ? meta([process.phase, `${processIndex + 1}/${task?.processes.length ?? 0}`, stream, process[stream].truncated ? "truncated" : "recent"], options) : stream} options={childOptions(options, options.width, outputHeight)} focused width={options.width} flexGrow={1}>
        {runtime.warnings.at(-1) ? <Text color={ARIADNE_THEME.warning}>! {truncateDisplay(runtime.warnings.at(-1)!, Math.max(10, paneInnerWidth(options.width, options) - 2))}</Text> : null}
        {outputLines(options.width, outputHeight).map((line, index) => <Text key={index}>{line || " "}</Text>)}
      </Pane>
    </Box>;
  }
  return <Box width={options.width} height={options.height} gap={0} overflow="hidden">
    {taskList(leftWidth, options.height)}
    <Box flexDirection="column" width={rightWidth} height={options.height} gap={0} overflow="hidden">
      <Pane title={task ? `${task.id} — ${humanize(task.state)}` : "Selected task"} subtitle={process ? meta([process.phase, `${processIndex + 1}/${task?.processes.length ?? 0}`, stream], options) : undefined} options={childOptions(options, rightWidth, 8)} width={rightWidth} height={8}>
        {task ? <>
          <Metadata label="Attempt" value={task.attempt || 0} width={paneInnerWidth(rightWidth, options)} />
          <Metadata label="Run" value={task.runId ?? "not started"} width={paneInnerWidth(rightWidth, options)} />
          <Metadata label="Process" value={process?.displayCommand ?? "waiting"} width={paneInnerWidth(rightWidth, options)} />
          <Metadata label="Blocked by" value={task.blockedBy.join(" -> ") || "none"} width={paneInnerWidth(rightWidth, options)} />
        </> : <Empty text="No task selected." />}
      </Pane>
      <Pane title="Live output" subtitle={process ? `${process.phase} ${stream}${process[stream].truncated ? " · truncated" : ""}` : stream} options={childOptions(options, rightWidth, options.height - 8)} focused width={rightWidth} flexGrow={1}>
        {runtime.warnings.at(-1) ? <Text color={ARIADNE_THEME.warning}>! {truncateDisplay(runtime.warnings.at(-1)!, Math.max(10, paneInnerWidth(rightWidth, options) - 2))}</Text> : null}
        {outputLines(rightWidth, options.height - 8).map((line, index) => <Text key={index}>{line || " "}</Text>)}
      </Pane>
    </Box>
  </Box>;
}

function ConfirmationView({ kind, operational, options }: { kind: "cancel" | "exit"; operational: TuiOperationalState; options: TuiVisualOptions }) {
  const runtime = operational.runtime;
  return <Pane title={kind === "cancel" ? "Cancel workflow?" : "Detach TUI?"} subtitle="Explicit confirmation required" options={options} focused width={options.width} height={options.height}>
    <Text color={ARIADNE_THEME.accent} bold>{kind === "cancel" ? "Cancellation stops new work and interrupts active processes." : "The workflow will continue in this Ariadne process."}</Text>
    <Metadata label="Workflow" value={runtime?.batchId ?? "unavailable"} width={paneInnerWidth(options.width, options)} />
    {kind === "cancel" ? <>
      <Text>- stop launching pending tasks</Text>
      <Text>- cancel retry delays</Text>
      <Text>- terminate active process trees best-effort</Text>
      <Text>- persist the batch as interrupted</Text>
    </> : <>
      <Text>The alternate screen and raw mode will be restored.</Text>
      <Text>The shell remains occupied until the workflow settles.</Text>
      <Text>Ctrl+C after detaching requests cancellation.</Text>
    </>}
    <Text> </Text>
    <Text><Text color={ARIADNE_THEME.info} bold>Enter</Text> confirm  <Text color={ARIADNE_THEME.info} bold>Esc</Text> continue workflow</Text>
    <OperationalMessage operational={operational} />
  </Pane>;
}

function CancellationProgressView({ operational, options }: { operational: TuiOperationalState; options: TuiVisualOptions }) {
  const stages = ["launches-stopped", "retry-delays-cancelled", "processes-terminating", "tasks-finalizing", "batch-finalizing"] as const;
  const current = operational.runtime?.cancellationStage;
  const currentIndex = current ? stages.indexOf(current) : 0;
  return <Pane title="Cancelling workflow" subtitle={operational.runtime?.batchId} options={options} focused width={options.width} height={options.height}>
    {stages.map((stage, index) => <Text key={stage} color={index < currentIndex ? ARIADNE_THEME.success : index === currentIndex ? ARIADNE_THEME.info : ARIADNE_THEME.muted} bold={index === currentIndex}>
      {index < currentIndex ? options.unicode ? "✓" : "[OK]" : index === currentIndex ? options.unicode ? "▶" : ">" : options.unicode ? "○" : "-"} {humanize(stage)}
    </Text>)}
    <OperationalMessage operational={operational} />
  </Pane>;
}

function WarningRow({ warning, selected, options, width }: { warning: TuiWarning; selected: boolean; options: TuiVisualOptions; width: number }) {
  return <Selection selected={selected}><Text color={ARIADNE_THEME.warning}>! </Text><Text>{truncateDisplay(meta([humanize(warning.code), warning.message], options), Math.max(1, width - 4))}</Text></Selection>;
}

function WarningList({ snapshot, screen, options }: { snapshot: TuiSnapshot; screen: Extract<Screen, { kind: "warnings" }>; options: TuiVisualOptions }) {
  const selected = Math.min(screen.selection, Math.max(0, snapshot.warnings.length - 1));
  const layout = layoutFor(options.width, options.height);
  const leftWidth = layout === "wide" ? Math.floor(options.width * 0.4) : options.width;
  const rightWidth = options.width - leftWidth;
  const window = visibleWindow(snapshot.warnings.length, selected, contentCapacity(options.height, true));
  const list = <Pane title="Warnings" subtitle={windowLabel(window, snapshot.warnings.length)} options={childOptions(options, leftWidth, options.height)} focused width={leftWidth} height={options.height}>
    {snapshot.warnings.length === 0 ? <Empty text="No warnings." /> : snapshot.warnings.slice(window.start, window.end).map((warning, offset) => <WarningRow key={warning.id} warning={warning} selected={window.start + offset === selected} options={options} width={paneInnerWidth(leftWidth, options)} />)}
  </Pane>;
  if (layout !== "wide") return list;
  const warning = snapshot.warnings[selected];
  return <Box width={options.width} height={options.height} gap={0} overflow="hidden">
    {list}
    <Pane title="Warning detail" options={childOptions(options, rightWidth, options.height)} width={rightWidth} height={options.height}>
      {warning ? <>
        <Text color={ARIADNE_THEME.warning} bold>! {humanize(warning.code)}</Text>
        <Metadata label="Message" value={warning.message} width={paneInnerWidth(rightWidth, options)} />
        <Metadata label="Path" value={warning.path ?? "not recorded"} width={paneInnerWidth(rightWidth, options)} />
        <Metadata label="Record" value={warning.recordId ?? "not recorded"} width={paneInnerWidth(rightWidth, options)} />
      </> : <Empty text="No warning selected." />}
    </Pane>
  </Box>;
}

function BindingRows({ bindings, width }: { bindings: KeyBinding[]; width: number }) {
  return <>{bindings.map((binding) => <Text key={binding.action}><Text color={ARIADNE_THEME.info} bold>{pad(binding.keys, 14)}</Text><Text>{truncateDisplay(humanize(binding.label), Math.max(1, width - 14))}</Text></Text>)}</>;
}

function Help({ previous, options }: { previous: Screen["kind"]; options: TuiVisualOptions }) {
  const bindings = bindingsFor(previous);
  const global = bindings.filter((binding) => binding.contexts.includes("global"));
  const contextual = bindings.filter((binding) => !binding.contexts.includes("global"));
  const layout = layoutFor(options.width, options.height);
  if (layout !== "wide") return <Pane title="Help" subtitle={humanize(previous)} options={options} focused width={options.width} height={options.height}>
    <BindingRows bindings={bindings} width={paneInnerWidth(options.width, options)} />
    <Text color={ARIADNE_THEME.muted}>Plan, launch, monitor, cancel, resume, and rerun workflows from the keyboard.</Text>
  </Pane>;
  const leftWidth = Math.floor(options.width / 2);
  const rightWidth = options.width - leftWidth;
  return <Box width={options.width} height={options.height} gap={0} overflow="hidden">
    <Pane title="Navigation" options={childOptions(options, leftWidth, options.height)} focused width={leftWidth} height={options.height}>
      <BindingRows bindings={global} width={paneInnerWidth(leftWidth, options)} />
    </Pane>
    <Pane title={`${humanize(previous)} actions`} options={childOptions(options, rightWidth, options.height)} width={rightWidth} height={options.height}>
      {contextual.length > 0 ? <BindingRows bindings={contextual} width={paneInnerWidth(rightWidth, options)} /> : <Empty text="No additional actions on this screen." />}
      <Text> </Text>
      <Text color={ARIADNE_THEME.muted}>Change promotion, cleanup, remote execution, and mouse-first controls remain outside this TUI.</Text>
    </Pane>
  </Box>;
}

function screenTitle(screen: Screen): string {
  return screen.kind === "dashboard" ? "Dashboard" : humanize(screen.kind);
}

function Header({ state, options }: { state: TuiState; options: TuiVisualOptions }) {
  const snapshot = state.snapshot;
  const layout = options.layout ?? layoutFor(options.width, options.height);
  const leftWidth = Math.max(16, Math.floor(options.width * (layout === "stacked" ? 0.44 : 0.36)));
  const history = state.snapshotRequest.loading ? "Refreshing" : state.snapshotRequest.error ? "History unavailable" : "History ready";
  const configuration = snapshot ? `Config ${snapshot.configuration === "available" ? "ready" : snapshot.configuration}` : "Config pending";
  const warnings = snapshot ? `${snapshot.warnings.length} warning${snapshot.warnings.length === 1 ? "" : "s"}` : "";
  const compactHistory = state.snapshotRequest.loading ? "refreshing" : state.snapshotRequest.error ? "history error" : "ready";
  const compactConfiguration = snapshot ? `cfg ${snapshot.configuration === "available" ? "ready" : snapshot.configuration}` : "cfg pending";
  const right = layout === "stacked" ? meta([compactHistory, compactConfiguration, snapshot ? `${snapshot.warnings.length}w` : ""].filter(Boolean), options) : undefined;
  return <Box width={options.width} height={1} flexShrink={0} overflow="hidden">
    <Box width={leftWidth} overflow="hidden"><Text wrap="truncate-end"><Text color={ARIADNE_THEME.accent} bold>Ariadne</Text><Text color={ARIADNE_THEME.muted}> / </Text><Text bold>{screenTitle(state.screen)}</Text></Text></Box>
    <Box width={options.width - leftWidth} justifyContent="flex-end" overflow="hidden">
      {right ? <Text wrap="truncate-end" color={ARIADNE_THEME.muted}>{right}</Text> : <Text wrap="truncate-end"><Text color={state.snapshotRequest.error ? ARIADNE_THEME.error : state.snapshotRequest.loading ? ARIADNE_THEME.info : ARIADNE_THEME.success}>{history}</Text><Text color={ARIADNE_THEME.muted}>  {configuration}  </Text><Text color={(snapshot?.warnings.length ?? 0) > 0 ? ARIADNE_THEME.warning : ARIADNE_THEME.muted}>{warnings}</Text>{options.verbose && snapshot ? <Text color={ARIADNE_THEME.muted}>  {snapshot.loadedAt}</Text> : null}</Text>}
    </Box>
  </Box>;
}

export function packFooterBindings(screen: Screen["kind"], width: number): KeyBinding[] {
  const candidates = bindingsFor(screen)
    .map((binding, index) => ({ binding, index }))
    .filter(({ binding }) => binding.footerPriority > 0)
    .sort((left, right) => right.binding.footerPriority - left.binding.footerPriority || left.index - right.index);
  const packed: KeyBinding[] = [];
  let used = 0;
  for (const { binding } of candidates) {
    const size = stringWidth(`${binding.keys} ${binding.label}`) + (packed.length > 0 ? 2 : 0);
    if (used + size > width) continue;
    packed.push(binding);
    used += size;
  }
  return packed;
}

function Footer({ screen, options }: { screen: Screen; options: TuiVisualOptions }) {
  const bindings = packFooterBindings(screen.kind, options.width);
  return <Box width={options.width} height={1} flexShrink={0} overflow="hidden">
    <Text wrap="truncate-end">{bindings.map((binding, index) => <React.Fragment key={binding.action}>{index > 0 ? "  " : ""}<Text color={ARIADNE_THEME.info} bold>{binding.keys}</Text><Text color={ARIADNE_THEME.muted}> {binding.label}</Text></React.Fragment>)}</Text>
  </Box>;
}

function formatBytes(value: number | undefined): string {
  if (value === undefined) return "unavailable";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function ReviewMessage({ operational, options, title }: { operational: TuiOperationalState; options: TuiVisualOptions; title: string }) {
  return <Pane title={title} options={options} focused width={options.width} height={options.height}>
    <Text color={operational.reviewError ? ARIADNE_THEME.error : ARIADNE_THEME.info}>{sanitizeTerminalText(operational.reviewError ?? operational.actionProgress ?? "Loading...")}</Text>
  </Pane>;
}

function ResultsView({ snapshot, screen, options }: { snapshot: TuiSnapshot; screen: Extract<Screen, { kind: "results" }>; options: TuiVisualOptions }) {
  const items = filterReviewResults(snapshot.results, screen.filter);
  const selected = Math.min(screen.selection, Math.max(0, items.length - 1));
  const wide = options.width >= 100;
  const window = visibleWindow(items.length, selected, Math.max(1, Math.floor(contentCapacity(options.height, true) / (wide ? 2 : 1))));
  return <Pane title="Results" subtitle={`Filter: ${humanize(screen.filter)} ${windowLabel(window, items.length)}`} options={options} focused width={options.width} height={options.height}>
    {items.length === 0 ? <Empty text="No results match this filter." /> : items.slice(window.start, window.end).map((item, offset) => {
      const width = Math.max(12, options.width - 5);
      const identity = `${item.taskId}  ${item.batchId ?? "standalone"}  ${item.runId}`;
      const dimensions = `${item.executionStatus}/${item.verificationStatus}/${item.policyStatus}  score ${item.score ?? "n/a"}`;
      const counts = `${item.changedFiles} files  +${item.additions}/-${item.deletions}`;
      const state = `${item.resultState}  workspace ${item.workspaceState ?? "n/a"}  ${item.completedAt || "unknown time"}`;
      const label = wide ? `${truncateDisplay(`${identity}  ${dimensions}`, width)}\n  ${truncateDisplay(`${counts}  ${state}`, Math.max(1, width - 2))}` : `${identity}  ${counts}  ${item.resultState}`;
      return <Selection key={item.key} selected={window.start + offset === selected}><Text>{wide ? label : truncateDisplay(label, width)}</Text></Selection>;
    })}
  </Pane>;
}

function ResultReviewView({ operational, options }: { operational: TuiOperationalState; options: TuiVisualOptions }) {
  const summary = operational.resultSummary;
  if (!summary) return <ReviewMessage operational={operational} options={options} title="Result summary" />;
  const result = summary.result;
  const latestPromotion = summary.promotions.at(-1);
  return <Pane title="Result summary" subtitle={result.final ? "Final attempt" : "Earlier attempt · read-only"} options={options} focused width={options.width} height={options.height}>
    <StatusLine status={result.resultState} outcome={result.outcome} options={options} />
    <Metadata label="Task" value={`${result.taskId}: ${result.taskName}`} width={options.width - 4} />
    <Metadata label="Run" value={result.runId} width={options.width - 4} />
    <Metadata label="Workflow" value={result.batchId ? `${result.batchId} · attempt ${result.attempt}` : "standalone"} width={options.width - 4} />
    <Metadata label="Execution" value={`${result.executionStatus} · verification ${result.verificationStatus} · policy ${result.policyStatus} · score ${result.score ?? "n/a"}`} width={options.width - 4} />
    <Metadata label="Revisions" value={`${summary.sourceRevision ?? "unknown"} → ${summary.resultRevision ?? "none"}`} width={options.width - 4} />
    <Metadata label="Changes" value={`${result.changedFiles} files · +${result.additions}/-${result.deletions} · ${result.binaryFiles} binary · ${summary.omittedSensitive.length} redacted`} width={options.width - 4} />
    <Metadata label="Promotion" value={`${result.resultState} · ${summary.promotions.length} events`} width={options.width - 4} />
    {latestPromotion ? <Metadata label="Latest event" value={`${latestPromotion.kind} · ${latestPromotion.status} · ${latestPromotion.updatedAt}`} width={options.width - 4} /> : null}
    {latestPromotion ? <Metadata label="Event target" value={`${latestPromotion.targetBranch ?? "none"} · ${latestPromotion.preApplyRevision ?? "unknown"} → ${latestPromotion.postApplyRevision ?? "unchanged"}`} width={options.width - 4} /> : null}
    <Metadata label="Workspace" value={summary.workspaceId ? `${summary.workspaceId} · ${result.workspaceState ?? "unknown"}` : "not applicable"} width={options.width - 4} />
    {latestPromotion?.conflicts?.slice(0, 3).map((conflict) => <Text key={conflict.path} color={ARIADNE_THEME.error}>! {truncateDisplay(`${conflict.path}: ${conflict.category} conflict`, options.width - 5)}</Text>)}
    {latestPromotion?.failure ? <Text color={latestPromotion.failure.manualRecoveryRequired ? ARIADNE_THEME.error : ARIADNE_THEME.warning}>! {truncateDisplay(`${latestPromotion.failure.code}: ${latestPromotion.failure.message}`, options.width - 5)}</Text> : null}
    {latestPromotion?.failure?.manualRecoveryRequired ? latestPromotion.failure.recoveryCommands.map((command) => <Text key={command}>{truncateDisplay(command, options.width - 4)}</Text>) : null}
    {summary.ineligibleReason ? <Text color={ARIADNE_THEME.warning}>! {truncateDisplay(summary.ineligibleReason, options.width - 5)}</Text> : null}
    {summary.policyFailures.slice(0, 3).map((value) => <Text key={value} color={ARIADNE_THEME.error}>! {truncateDisplay(value, options.width - 5)}</Text>)}
  </Pane>;
}

function ChangeManifestView({ screen, operational, options }: { screen: Extract<Screen, { kind: "changes" }>; operational: TuiOperationalState; options: TuiVisualOptions }) {
  const changes = operational.resultSummary?.changes;
  if (!changes) return <ReviewMessage operational={operational} options={options} title="Changed files" />;
  const selected = Math.min(screen.selection, Math.max(0, changes.length - 1));
  const window = visibleWindow(changes.length, selected, contentCapacity(options.height, true));
  return <Pane title="Changed files" subtitle={windowLabel(window, changes.length)} options={options} focused width={options.width} height={options.height}>
    {changes.length === 0 ? <Empty text="No safe captured changes." /> : changes.slice(window.start, window.end).map((change, offset) => {
      const special = [change.binary ? "binary" : "", change.kind === "symlink" ? "symlink" : "", change.changeType === "mode-changed" ? "mode" : ""].filter(Boolean).join(",");
      const value = `${change.changeType.padEnd(15)} ${change.originalPath ? `${change.originalPath} → ` : ""}${change.path}  ${change.binary ? "—" : `+${change.additions ?? 0}/-${change.deletions ?? 0}`} ${special}`;
      return <Selection key={change.changeId ?? change.path} selected={window.start + offset === selected}><Text>{truncateDisplay(value, options.width - 5)}</Text></Selection>;
    })}
    {operational.resultSummary?.omittedSensitive.map((item) => <Text key={item.path} color={ARIADNE_THEME.warning}>REDACTED  {truncateDisplay(item.path, options.width - 16)}  {item.reason}</Text>)}
  </Pane>;
}

function DiffReviewView({ screen, operational, options }: { screen: Extract<Screen, { kind: "diff" }>; operational: TuiOperationalState; options: TuiVisualOptions }) {
  const page = operational.diffPage;
  if (!page) return <ReviewMessage operational={operational} options={options} title="Diff" />;
  const capacity = Math.max(1, options.height - 5);
  const start = Math.min(screen.scroll, Math.max(0, page.lines.length - capacity));
  return <Pane title={`Diff · ${truncateDisplay(page.change.path, Math.max(8, options.width - 20))}`} subtitle={`${page.status} · ${formatBytes(page.totalBytes)}${page.truncated ? " · bounded" : ""}`} options={options} focused width={options.width} height={options.height}>
    {page.message ? <Text color={ARIADNE_THEME.warning}>{truncateDisplay(page.message, options.width - 4)}</Text> : null}
    {page.lines.length === 0 ? <Empty text="No renderable text diff. Inspect metadata or export the safe patch." /> : page.lines.slice(start, start + capacity).map((line, index) => {
      const numbers = `${line.oldLine ?? ""}`.padStart(5) + " " + `${line.newLine ?? ""}`.padStart(5);
      const color = line.kind === "added" ? ARIADNE_THEME.success : line.kind === "removed" ? ARIADNE_THEME.error : line.kind === "hunk" ? ARIADNE_THEME.info : line.kind === "metadata" || line.kind === "header" ? ARIADNE_THEME.muted : undefined;
      return <Text key={`${start + index}:${line.text}`} color={color}>{numbers} {truncateDisplay(line.text, Math.max(1, options.width - 17))}</Text>;
    })}
  </Pane>;
}

function ComparisonView({ operational, options }: { operational: TuiOperationalState; options: TuiVisualOptions }) {
  const value = operational.comparison;
  if (!value) return <ReviewMessage operational={operational} options={options} title="Attempt comparison" />;
  return <Pane title="Attempt comparison" subtitle={`${value.left.runId} ↔ ${value.right.runId}`} options={options} focused width={options.width} height={options.height}>
    <Metadata label="Left" value={`attempt ${value.left.attempt ?? 1} · ${value.left.outcome} · score ${value.left.score ?? "n/a"} · ${value.left.changedFiles} files`} width={options.width - 4} />
    <Metadata label="Right" value={`attempt ${value.right.attempt ?? 1} · ${value.right.outcome} · score ${value.right.score ?? "n/a"} · ${value.right.changedFiles} files`} width={options.width - 4} />
    <Text color={ARIADNE_THEME.success} bold>Added in right</Text>
    {value.addedPaths.slice(0, 8).map((item) => <Text key={`a:${item}`}>+ {truncateDisplay(item, options.width - 5)}</Text>)}
    <Text color={ARIADNE_THEME.error} bold>Removed in right</Text>
    {value.removedPaths.slice(0, 8).map((item) => <Text key={`r:${item}`}>- {truncateDisplay(item, options.width - 5)}</Text>)}
    <Text color={ARIADNE_THEME.muted}>{value.sharedPaths.length} shared paths</Text>
  </Pane>;
}

function EligibilityView({ operational, options }: { operational: TuiOperationalState; options: TuiVisualOptions }) {
  const value = operational.applyEligibility;
  if (!value) return <ReviewMessage operational={operational} options={options} title="Apply eligibility" />;
  return <Pane title="Apply eligibility" subtitle={value.eligible ? "Eligible to preflight" : "Ineligible"} options={options} focused width={options.width} height={options.height}>
    {value.checks.map((check) => <Text key={check.id} color={check.status === "fail" ? ARIADNE_THEME.error : check.status === "warning" ? ARIADNE_THEME.warning : ARIADNE_THEME.success}>{check.status === "pass" ? options.unicode ? "✓" : "+" : check.status === "warning" ? "!" : options.unicode ? "✗" : "x"} {truncateDisplay(`${check.label}: ${check.detail}`, options.width - 6)}</Text>)}
  </Pane>;
}

function ApplyPreviewView({ operational, options }: { operational: TuiOperationalState; options: TuiVisualOptions }) {
  const value = operational.applyPreview;
  if (!value) return <ReviewMessage operational={operational} options={options} title="Apply preview" />;
  return <Pane title="Apply preview" subtitle={`Preflight: ${value.preflight}`} options={options} focused width={options.width} height={options.height}>
    <Metadata label="Target" value={`${value.targetRepository} · ${value.targetBranch ?? "detached"}`} width={options.width - 4} />
    <Metadata label="Revision" value={value.targetRevision ?? "unknown"} width={options.width - 4} />
    <Metadata label="Strategy" value={value.strategy} width={options.width - 4} />
    <Metadata label="Closure" value={value.closureRunIds.join(", ") || "none"} width={options.width - 4} />
    <Metadata label="Changes" value={`${value.changedFiles} files · +${value.additions}/-${value.deletions}`} width={options.width - 4} />
    {value.conflicts.map((item) => <Text key={item.path} color={ARIADNE_THEME.error}>! {truncateDisplay(`${item.path}: ${item.category} conflict`, options.width - 5)}</Text>)}
    {value.highRiskReasons.map((item) => <Text key={item} color={ARIADNE_THEME.warning}>! {truncateDisplay(item, options.width - 5)}</Text>)}
    <Text color={ARIADNE_THEME.muted}>Preflight is an estimate; execution revalidates the target.</Text>
  </Pane>;
}

function ReviewConfirmation({ kind, operational, options }: { kind: "apply" | "discard" | "cleanup"; operational: TuiOperationalState; options: TuiVisualOptions }) {
  const risky = kind === "apply" && (operational.applyPreview?.highRiskReasons.length ?? 0) > 0;
  return <Pane title={`${humanize(kind)} confirmation`} subtitle="Explicit confirmation required" options={options} focused width={options.width} height={options.height}>
    <Text color={ARIADNE_THEME.warning} bold>{kind === "apply" ? "This will create a commit in the target repository." : kind === "discard" ? "This will remove the managed result ref and eligible retained workspace." : "This will remove proven Ariadne-managed workspaces."}</Text>
    {risky ? <Text color={operational.riskAcknowledged ? ARIADNE_THEME.success : ARIADNE_THEME.warning}>{operational.riskAcknowledged ? "[x]" : "[ ]"} Space acknowledges elevated risk</Text> : null}
    {operational.actionProgress ? <Text color={ARIADNE_THEME.info}>{truncateDisplay(operational.actionProgress, options.width - 4)}</Text> : null}
    {operational.reviewError ? <Text color={ARIADNE_THEME.error}>{truncateDisplay(operational.reviewError, options.width - 4)}</Text> : null}
    <Text><Text color={ARIADNE_THEME.info} bold>Enter</Text> confirm  <Text color={ARIADNE_THEME.info} bold>Esc</Text> cancel</Text>
  </Pane>;
}

function DiscardPreviewView({ operational, options }: { operational: TuiOperationalState; options: TuiVisualOptions }) {
  const value = operational.discardPreview;
  if (!value) return <ReviewMessage operational={operational} options={options} title="Discard preview" />;
  return <Pane title="Discard preview" subtitle={value.eligible ? "Ready" : "Blocked"} options={options} focused width={options.width} height={options.height}>
    <Metadata label="Run" value={value.runId} width={options.width - 4} />
    <Metadata label="Result ref" value={value.resultRef ?? "none"} width={options.width - 4} />
    <Metadata label="Workspace" value={value.workspaceId ? `${value.workspaceId} · ${value.workspaceState}` : "none"} width={options.width - 4} />
    <Text bold>Preserves</Text>{value.preserves.map((item) => <Text key={item}>+ {truncateDisplay(item, options.width - 6)}</Text>)}
    {value.blockers.map((item) => <Text key={item} color={ARIADNE_THEME.error}>! {truncateDisplay(item, options.width - 6)}</Text>)}
  </Pane>;
}

function ExportPreviewView({ operational, options }: { operational: TuiOperationalState; options: TuiVisualOptions }) {
  const value = operational.patchExportPreview;
  if (!value) return <ReviewMessage operational={operational} options={options} title="Patch export" />;
  return <Pane title="Patch export" subtitle="No-clobber" options={options} focused width={options.width} height={options.height}>
    <Metadata label="Destination" value={value.destination} width={options.width - 4} />
    <Metadata label="Size" value={formatBytes(value.bytes)} width={options.width - 4} />
    <Metadata label="Included" value={`${value.includedFiles.length} files`} width={options.width - 4} />
    <Metadata label="Redacted" value={`${value.excludedSensitiveFiles.length} files`} width={options.width - 4} />
    {value.limitations.map((item) => <Text key={item} color={ARIADNE_THEME.warning}>! {truncateDisplay(item, options.width - 5)}</Text>)}
  </Pane>;
}

export function filteredWorkspaceDetails(snapshot: TuiSnapshot, filter: WorkspaceReviewFilter = "all") {
  if (filter === "retained") return snapshot.workspaceDetails.filter((workspace) => workspace.state === "retained");
  if (filter === "stale") return snapshot.workspaceDetails.filter((workspace) => workspace.state === "stale" || workspace.state === "missing");
  if (filter === "cleanup-failure") return snapshot.workspaceDetails.filter((workspace) => Boolean(workspace.cleanupError));
  return snapshot.workspaceDetails;
}

function WorkspacesView({ snapshot, screen, options }: { snapshot: TuiSnapshot; screen: Extract<Screen, { kind: "workspaces" }>; options: TuiVisualOptions }) {
  const values = filteredWorkspaceDetails(snapshot, screen.filter);
  const selected = Math.min(screen.selection, Math.max(0, values.length - 1));
  const window = visibleWindow(values.length, selected, contentCapacity(options.height, true));
  return <Pane title="Managed workspaces" subtitle={`${humanize(screen.filter ?? "all")} · ${windowLabel(window, values.length)}`} options={options} focused width={options.width} height={options.height}>
    {values.length === 0 ? <Empty text="No managed workspaces." /> : values.slice(window.start, window.end).map((item, offset) => <Selection key={item.workspaceId} selected={window.start + offset === selected}>
      <Text>{truncateDisplay(`${item.state.padEnd(10)} ${item.taskId.padEnd(18)} ${formatBytes(item.sizeBytes).padEnd(10)} ${item.workspaceId} ${item.cleanupEligible ? "cleanable" : "blocked"}`, options.width - 5)}</Text>
    </Selection>)}
  </Pane>;
}

function WorkspaceReviewView({ operational, options }: { operational: TuiOperationalState; options: TuiVisualOptions }) {
  const value = operational.workspaceDetail;
  if (!value) return <ReviewMessage operational={operational} options={options} title="Workspace" />;
  return <Pane title="Workspace" subtitle={value.cleanupEligible ? "Cleanup eligible" : "Protected"} options={options} focused width={options.width} height={options.height}>
    <Metadata label="ID" value={value.workspaceId} width={options.width - 4} />
    <Metadata label="Task/run" value={`${value.taskId} · ${value.runId} · attempt ${value.attempt}`} width={options.width - 4} />
    <Metadata label="State" value={`${value.state} · physical ${value.physicalState}`} width={options.width - 4} />
    <Metadata label="Path" value={value.path} width={options.width - 4} />
    <Metadata label="Revision" value={`${value.sourceRevision} → ${value.preparedRevision ?? "unprepared"}`} width={options.width - 4} />
    <Metadata label="Retention" value={`${value.retention}${value.retentionReason ? ` · ${value.retentionReason}` : ""}`} width={options.width - 4} />
    <Metadata label="Size" value={`${formatBytes(value.sizeBytes)}${value.sizeTruncated ? " lower bound" : ""}`} width={options.width - 4} />
    {value.cleanupBlockers.map((item) => <Text key={item} color={ARIADNE_THEME.warning}>! {truncateDisplay(item, options.width - 5)}</Text>)}
  </Pane>;
}

function CleanupPreviewView({ operational, options }: { operational: TuiOperationalState; options: TuiVisualOptions }) {
  const value = operational.cleanupPreview;
  if (!value) return <ReviewMessage operational={operational} options={options} title="Cleanup preview" />;
  return <Pane title="Cleanup preview" subtitle={value.eligible ? "Dry run · eligible" : "Dry run · blocked"} options={options} focused width={options.width} height={options.height}>
    <Metadata label="Workspace" value={value.workspaceId} width={options.width - 4} />
    <Metadata label="Recovery" value={formatBytes(value.estimatedBytes)} width={options.width - 4} />
    <Text bold>Will remove</Text>{value.removes.map((item) => <Text key={item}>- {truncateDisplay(item, options.width - 6)}</Text>)}
    <Text bold>Will preserve</Text>{value.preserves.map((item) => <Text key={item}>+ {truncateDisplay(item, options.width - 6)}</Text>)}
    {value.blockers.map((item) => <Text key={item} color={ARIADNE_THEME.error}>! {truncateDisplay(item, options.width - 6)}</Text>)}
  </Pane>;
}

function ActionResultView({ operational, options }: { operational: TuiOperationalState; options: TuiVisualOptions }) {
  const status = operational.promotionResult?.status ?? operational.cleanupResult?.action.status ?? (operational.reviewError ? "failed" : "succeeded");
  return <Pane title="Action result" subtitle={status} options={options} focused width={options.width} height={options.height}>
    <StatusLine status={status} options={options} />
    <Text>{truncateDisplay(operational.actionMessage ?? operational.reviewError ?? "Action completed.", options.width - 4)}</Text>
    {operational.promotionResult?.conflicts?.map((item) => <Text key={item.path} color={ARIADNE_THEME.error}>! {truncateDisplay(`${item.path}: ${item.category}`, options.width - 5)}</Text>)}
    {operational.promotionResult?.failure?.manualRecoveryRequired ? <><Text color={ARIADNE_THEME.error} bold>Manual recovery required</Text>{operational.promotionResult.failure.recoveryCommands.map((item) => <Text key={item}>{truncateDisplay(item, options.width - 4)}</Text>)}</> : null}
    {operational.cleanupResult ? <Text>{operational.cleanupResult.cleaned.length} cleaned · {operational.cleanupResult.skipped.length} skipped · {operational.cleanupResult.failed.length} failed</Text> : null}
  </Pane>;
}

function ScreenBody({ state, operational, options }: { state: TuiState; operational?: TuiOperationalState; options: TuiVisualOptions }) {
  const snapshot = state.snapshot;
  const screen = state.screen;
  const previousKind = state.backStack.at(-1)?.kind ?? "dashboard";
  if (operational) {
    if (screen.kind === "planner") return <PlannerView screen={screen} operational={operational} options={options} />;
    if (screen.kind === "plan") return <PlanReviewView screen={screen} operational={operational} options={options} />;
    if (screen.kind === "options") return <OptionsView screen={screen} operational={operational} options={options} />;
    if (screen.kind === "confirm") return <LaunchConfirmation operational={operational} options={options} />;
    if (screen.kind === "live") return <LiveWorkflowView screen={screen} operational={operational} options={options} />;
    if (screen.kind === "cancel-confirm") return <ConfirmationView kind="cancel" operational={operational} options={options} />;
    if (screen.kind === "exit-confirm") return <ConfirmationView kind="exit" operational={operational} options={options} />;
    if (screen.kind === "cancel-progress") return <CancellationProgressView operational={operational} options={options} />;
    if (screen.kind === "resume-preview") return <PlanReviewView screen={screen} operational={operational} options={options} title="Resume workflow" />;
    if (screen.kind === "rerun-preview") return <PlanReviewView screen={screen} operational={operational} options={options} title={`Rerun ${humanize(operational.rerunPreview?.mode ?? "workflow")}`} />;
    if (screen.kind === "result") return <ResultReviewView operational={operational} options={options} />;
    if (screen.kind === "changes") return <ChangeManifestView screen={screen} operational={operational} options={options} />;
    if (screen.kind === "diff") return <DiffReviewView screen={screen} operational={operational} options={options} />;
    if (screen.kind === "compare") return <ComparisonView operational={operational} options={options} />;
    if (screen.kind === "apply-eligibility") return <EligibilityView operational={operational} options={options} />;
    if (screen.kind === "apply-preview") return <ApplyPreviewView operational={operational} options={options} />;
    if (screen.kind === "apply-confirm") return <ReviewConfirmation kind="apply" operational={operational} options={options} />;
    if (screen.kind === "discard-preview") return <DiscardPreviewView operational={operational} options={options} />;
    if (screen.kind === "discard-confirm") return <ReviewConfirmation kind="discard" operational={operational} options={options} />;
    if (screen.kind === "export-preview") return <ExportPreviewView operational={operational} options={options} />;
    if (screen.kind === "workspace") return <WorkspaceReviewView operational={operational} options={options} />;
    if (screen.kind === "cleanup-preview") return <CleanupPreviewView operational={operational} options={options} />;
    if (screen.kind === "cleanup-confirm") return <ReviewConfirmation kind="cleanup" operational={operational} options={options} />;
    if (screen.kind === "action-result") return <ActionResultView operational={operational} options={options} />;
  }
  if (state.snapshotRequest.error && !snapshot) return <Pane title="Could not load history" options={options} focused width={options.width} height={options.height}><Text color={ARIADNE_THEME.error}>{state.snapshotRequest.error}</Text></Pane>;
  if (!snapshot) return <Pane title="History" options={options} focused width={options.width} height={options.height}><Text color={ARIADNE_THEME.info}>Loading...</Text></Pane>;
  if (screen.kind === "dashboard") return <Dashboard snapshot={snapshot} screen={screen} operational={operational} options={options} />;
  if (screen.kind === "results") return <ResultsView snapshot={snapshot} screen={screen} options={options} />;
  if (screen.kind === "workspaces") return <WorkspacesView snapshot={snapshot} screen={screen} options={options} />;
  if (screen.kind === "history") return <History snapshot={snapshot} screen={screen} options={options} />;
  if (screen.kind === "workflow") return <Workflow snapshot={snapshot} screen={screen} options={options} />;
  if (screen.kind === "task") {
    const entry = snapshot.tasks.find((task) => task.key === screen.taskKey);
    return entry ? <TaskDetailView entry={entry} screen={screen} options={options} /> : <Pane title="Task" options={options} focused width={options.width} height={options.height}><Empty text="Task record is unavailable after refresh." /></Pane>;
  }
  if (screen.kind === "attempt") {
    const entry = snapshot.tasks.find((task) => task.key === screen.taskKey);
    const reference = entry?.attempts[screen.attemptIndex];
    const detail = reference ? state.attempts[reference.key] : undefined;
    const processView = detail ? processesFor(detail)[screen.processIndex] : undefined;
    const artifact = artifactFor(processView, screen.stream);
    const logKey = artifact ? `${reference?.key}:${screen.processIndex}:${screen.stream}` : undefined;
    return entry ? <AttemptView entry={entry} screen={screen} detail={detail} preview={logKey ? state.logs[logKey] : undefined} requestError={reference ? state.attemptRequests[reference.key]?.error : undefined} options={options} /> : <Pane title="Attempt" options={options} focused width={options.width} height={options.height}><Empty text="Attempt record is unavailable after refresh." /></Pane>;
  }
  if (screen.kind === "warnings") return <WarningList snapshot={snapshot} screen={screen} options={options} />;
  return <Help previous={previousKind} options={options} />;
}

function Minimum({ options }: { options: TuiVisualOptions }) {
  return <Box flexDirection="column" width={options.width} height={options.height} overflow="hidden">
    <Text color={ARIADNE_THEME.accent} bold>Ariadne</Text>
    <Text color={ARIADNE_THEME.warning}>Terminal too small</Text>
    <Text>Resize to at least 40x12. Current size: {options.width}x{options.height}.</Text>
    <Text><Text color={ARIADNE_THEME.info} bold>r</Text> refresh  <Text color={ARIADNE_THEME.info} bold>?</Text> help  <Text color={ARIADNE_THEME.info} bold>q</Text> quit</Text>
  </Box>;
}

function AriadneTuiContent({ state, operational, ...options }: TuiViewProps) {
  if (layoutFor(options.width, options.height) === "minimum") return <Minimum options={options} />;
  const bodyHeight = Math.max(1, options.height - 2);
  const bodyOptions = childOptions(options, options.width, bodyHeight);
  return <Box flexDirection="column" width={options.width} height={options.height} overflow="hidden">
    <Header state={state} options={options} />
    <Box width={options.width} height={bodyHeight} flexShrink={0} overflow="hidden"><ScreenBody state={state} operational={operational} options={bodyOptions} /></Box>
    <Footer screen={state.screen} options={options} />
  </Box>;
}

export function AriadneTuiView(props: TuiViewProps) {
  return <ColorThemeContext.Provider value={props.color}><AriadneTuiContent {...props} /></ColorThemeContext.Provider>;
}
