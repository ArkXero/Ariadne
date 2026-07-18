import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useApp, useInput, useStdout } from "ink";
import { AriadneTuiView, activeBatches, artifactFor, filteredBatches, filteredTasks, processesFor, recentBatches } from "./components.js";
import { resolveKey } from "./keymap.js";
import { initialTuiState, tuiReducer } from "./state.js";
import { createRuntimeView, reconcileRuntimeRecord, reduceRuntimeEvent } from "./runtime-state.js";
import type { WorkflowExecutionHandle, WorkflowExecutionOverrides } from "../core/workflow-application.js";
import type { AttemptReference, Screen, TuiDataService, TuiOperationalState, TuiWorkflowLaunchRequest } from "./types.js";

export interface AriadneTuiProps {
  service: TuiDataService;
  color: boolean;
  unicode: boolean;
  verbose?: boolean;
  dimensions?: { width: number; height: number };
  onDetachActive?: () => void;
}

function initialOperationalState(): TuiOperationalState {
  return {
    loading: false,
    draft: { taskIds: [], overrides: {}, optionBaseline: {} },
    cancellationRequested: false,
    detached: false,
    clock: Date.now()
  };
}

function currentReference(screen: Extract<Screen, { kind: "attempt" }>, serviceData: ReturnType<typeof initialTuiState>["snapshot"]): AttemptReference | undefined {
  return serviceData?.tasks.find((task) => task.key === screen.taskKey)?.attempts[screen.attemptIndex];
}

export function AriadneTui({ service, color, unicode, verbose, dimensions, onDetachActive }: AriadneTuiProps) {
  const [state, dispatch] = useReducer(tuiReducer, undefined, initialTuiState);
  const [operational, setOperational] = useState<TuiOperationalState>(initialOperationalState);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [terminalSize, setTerminalSize] = useState(() => dimensions ?? ({ width: stdout.columns || 80, height: stdout.rows || 24 }));
  const generation = useRef(0);
  const handle = useRef<WorkflowExecutionHandle | undefined>(undefined);
  const unsubscribeRuntime = useRef<(() => void) | undefined>(undefined);
  const screen = useRef(state.screen);
  const mounted = useRef(true);

  useEffect(() => { screen.current = state.screen; }, [state.screen]);
  useEffect(() => () => {
    mounted.current = false;
    unsubscribeRuntime.current?.();
  }, []);

  useEffect(() => {
    if (dimensions) return;
    const resize = () => setTerminalSize({ width: stdout.columns || 80, height: stdout.rows || 24 });
    stdout.on("resize", resize);
    return () => { stdout.off("resize", resize); };
  }, [dimensions, stdout]);

  const refresh = useCallback(() => {
    if (state.snapshotRequest.loading) return;
    const request = ++generation.current;
    dispatch({ type: "snapshot-start", generation: request });
    void service.loadSnapshot().then(
      (snapshot) => dispatch({ type: "snapshot-success", generation: request, snapshot }),
      (error: unknown) => dispatch({ type: "snapshot-error", generation: request, error: error instanceof Error ? error.message : String(error) })
    );
  }, [service, state.snapshotRequest.loading]);

  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (state.screen.kind !== "attempt") return;
    const reference = currentReference(state.screen, state.snapshot);
    if (!reference || state.attempts[reference.key] || state.attemptRequests[reference.key]?.loading) return;
    const request = ++generation.current;
    dispatch({ type: "attempt-start", key: reference.key, generation: request });
    void service.loadAttempt(reference).then(
      (detail) => dispatch({ type: "attempt-success", key: reference.key, generation: request, detail }),
      (error: unknown) => dispatch({ type: "attempt-error", key: reference.key, generation: request, error: error instanceof Error ? error.message : String(error) })
    );
  }, [service, state.attemptRequests, state.attempts, state.screen, state.snapshot]);

  useEffect(() => {
    if (state.screen.kind !== "attempt") return;
    const reference = currentReference(state.screen, state.snapshot);
    const detail = reference ? state.attempts[reference.key] : undefined;
    const processView = detail ? processesFor(detail)[state.screen.processIndex] : undefined;
    const artifact = artifactFor(processView, state.screen.stream);
    if (!reference || !artifact) return;
    const key = `${reference.key}:${state.screen.processIndex}:${state.screen.stream}`;
    if (state.logs[key] || state.logRequests[key]?.loading) return;
    const request = ++generation.current;
    dispatch({ type: "log-start", key, generation: request });
    void service.loadLogPreview(artifact).then(
      (preview) => dispatch({ type: "log-success", key, generation: request, preview }),
      (error: unknown) => dispatch({ type: "log-error", key, generation: request, error: error instanceof Error ? error.message : String(error) })
    );
  }, [service, state.attempts, state.logRequests, state.logs, state.screen, state.snapshot]);

  const setOperationError = useCallback((error: unknown) => {
    setOperational((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : String(error) }));
  }, []);

  const reconcileActive = useCallback(() => {
    const current = handle.current;
    if (!current || !service.loadBatch) return;
    void service.loadBatch(current.batchId).then((batch) => {
      if (!mounted.current) return;
      setOperational((value) => value.runtime ? { ...value, runtime: reconcileRuntimeRecord(value.runtime, batch), clock: Date.now() } : value);
    }, setOperationError);
  }, [service, setOperationError]);

  useEffect(() => {
    if (!operational.runtime || operational.runtime.completedManifest) return;
    const timer = setInterval(() => {
      setOperational((current) => ({ ...current, clock: Date.now() }));
      reconcileActive();
      refresh();
    }, 1_000);
    return () => clearInterval(timer);
  }, [operational.runtime?.batchId, operational.runtime?.completedManifest, reconcileActive, refresh]);

  const openPlanner = useCallback(() => {
    if (!service.inspectWorkflowOptions) return setOperationError(new Error("Operational workflow services are unavailable."));
    dispatch({ type: "navigate", screen: { kind: "planner", selection: 0 } });
    setOperational((current) => ({ ...current, loading: true, error: undefined, inspection: undefined, preview: undefined, resumePreview: undefined, rerunPreview: undefined, draft: { taskIds: [], overrides: {}, optionBaseline: {} } }));
    void service.inspectWorkflowOptions().then((inspection) => {
      const overrides: WorkflowExecutionOverrides = {
        concurrency: inspection.defaults.concurrency,
        failureMode: inspection.defaults.failureMode,
        isolation: inspection.defaults.isolation,
        allowDirtyBase: false
      };
      setOperational((current) => ({ ...current, loading: false, inspection, draft: { taskIds: [], overrides, optionBaseline: { ...overrides } } }));
    }, setOperationError);
  }, [service, setOperationError]);

  const requestPreview = useCallback(() => {
    const draft = operational.draft;
    setOperational((current) => ({ ...current, loading: true, error: undefined }));
    const onReady = () => dispatch({
      type: "navigate",
      screen: { kind: draft.relation === "resume" ? "resume-preview" : draft.relation ? "rerun-preview" : "plan", selection: 0 }
    });
    if (draft.relation === "resume" && draft.sourceBatchId && service.previewResumeWorkflow) {
      void service.previewResumeWorkflow(draft.sourceBatchId, draft.overrides).then((preview) => {
        const effectivePlan = preview.plan ? { ...preview.plan, blockers: [...preview.blockers], warnings: [...preview.warnings] } : undefined;
        setOperational((current) => ({ ...current, loading: false, resumePreview: preview, preview: effectivePlan, error: undefined, draft: { ...current.draft, optionBaseline: { ...current.draft.overrides } } }));
        onReady();
      }, setOperationError);
      return;
    }
    if (draft.relation && draft.relation !== "resume" && draft.sourceBatchId && service.previewRerunWorkflow) {
      void service.previewRerunWorkflow(draft.sourceBatchId, draft.relation, draft.overrides).then((preview) => {
        setOperational((current) => ({ ...current, loading: false, rerunPreview: preview, preview: preview.plan, error: undefined, draft: { ...current.draft, optionBaseline: { ...current.draft.overrides } } }));
        onReady();
      }, setOperationError);
      return;
    }
    if (!service.createWorkflowPlanPreview) return setOperationError(new Error("Workflow planning is unavailable."));
    if (draft.taskIds.length === 0) return setOperationError(new Error("Select at least one task before reviewing the plan."));
    void service.createWorkflowPlanPreview(draft.taskIds, draft.overrides).then((preview) => {
      setOperational((current) => ({ ...current, loading: false, preview, error: undefined, draft: { ...current.draft, optionBaseline: { ...current.draft.overrides } } }));
      onReady();
    }, setOperationError);
  }, [operational.draft, service, setOperationError]);

  const selectedHistoryBatch = useCallback(() => {
    if (state.screen.kind !== "workflow") return undefined;
    const batchKey = state.screen.batchKey;
    return state.snapshot?.batches.find((batch) => batch.key === batchKey);
  }, [state.screen, state.snapshot]);

  const previewHistoryAction = useCallback((relation: "resume" | "failed" | "failed-branch" | "all") => {
    const batch = selectedHistoryBatch();
    if (!batch) return;
    const overrides: WorkflowExecutionOverrides = relation === "resume"
      ? { concurrency: batch.record.plan?.concurrency ?? 1, allowDirtyBase: batch.record.plan?.dirtyBaseAcknowledged ?? false }
      : {};
    setOperational((current) => ({
      ...current, loading: true, error: undefined, preview: undefined, resumePreview: undefined, rerunPreview: undefined,
      draft: { taskIds: [], overrides, optionBaseline: { ...overrides }, sourceBatchId: batch.key, relation }
    }));
    const promise = relation === "resume"
      ? service.previewResumeWorkflow?.(batch.key, overrides)
      : service.previewRerunWorkflow?.(batch.key, relation, overrides);
    if (!promise) return setOperationError(new Error("This workflow action is unavailable."));
    void promise.then((preview) => {
      if (preview.kind === "resume") {
        const effectivePlan = preview.plan ? { ...preview.plan, blockers: [...preview.blockers], warnings: [...preview.warnings] } : undefined;
        setOperational((current) => ({ ...current, loading: false, resumePreview: preview, preview: effectivePlan }));
        dispatch({ type: "navigate", screen: { kind: "resume-preview", selection: 0 } });
      } else {
        setOperational((current) => ({ ...current, loading: false, rerunPreview: preview, preview: preview.plan }));
        dispatch({ type: "navigate", screen: { kind: "rerun-preview", selection: 0 } });
      }
    }, setOperationError);
  }, [selectedHistoryBatch, service, setOperationError]);

  const launchWorkflow = useCallback(() => {
    const preview = operational.preview;
    if (!preview || !service.startWorkflowExecution) return setOperationError(new Error("No launchable workflow plan is available."));
    if (preview.blockers[0]) return setOperationError(new Error(`${preview.blockers[0].message} ${preview.blockers[0].correction}`));
    const draft = operational.draft;
    let request: TuiWorkflowLaunchRequest;
    if (draft.relation === "resume" && draft.sourceBatchId) request = { kind: "resume", sourceBatchId: draft.sourceBatchId, ...draft.overrides };
    else if (draft.relation && draft.relation !== "resume" && draft.sourceBatchId) request = { kind: "rerun", sourceBatchId: draft.sourceBatchId, mode: draft.relation, ...draft.overrides };
    else request = { kind: "run", taskIds: draft.taskIds, ...draft.overrides };
    setOperational((current) => ({ ...current, loading: true, error: undefined }));
    void service.startWorkflowExecution(request).then((execution) => {
      handle.current = execution;
      unsubscribeRuntime.current?.();
      const runtime = createRuntimeView(execution.batchId, preview.plan, execution.startedAt);
      unsubscribeRuntime.current = execution.subscribe((event) => {
        if (mounted.current) setOperational((current) => current.runtime ? { ...current, runtime: reduceRuntimeEvent(current.runtime, event), clock: Date.now() } : current);
      });
      setOperational((current) => ({ ...current, loading: false, runtime, cancellationRequested: false, error: undefined }));
      dispatch({ type: "navigate", screen: { kind: "live", selection: 0, processIndex: 0, stream: "stdout", scroll: 0 } });
      refresh();
      void execution.completion.then((batch) => {
        if (!mounted.current) return;
        setOperational((current) => current.runtime ? { ...current, runtime: reconcileRuntimeRecord(current.runtime, batch), cancellationRequested: false, clock: Date.now() } : current);
        const request = ++generation.current;
        dispatch({ type: "snapshot-start", generation: request });
        void service.loadSnapshot().then((snapshot) => {
          if (!mounted.current) return;
          dispatch({ type: "snapshot-success", generation: request, snapshot });
          if (["live", "cancel-progress", "cancel-confirm"].includes(screen.current.kind)) dispatch({ type: "replace-screen", screen: { kind: "workflow", batchKey: batch.batchId, selection: 0 } });
        }, (error: unknown) => dispatch({ type: "snapshot-error", generation: request, error: error instanceof Error ? error.message : String(error) }));
      }, setOperationError);
    }, setOperationError);
  }, [operational.draft, operational.preview, refresh, service, setOperationError]);

  const changeOption = useCallback((direction: -1 | 1) => {
    if (state.screen.kind !== "options") return;
    const index = state.screen.selection;
    setOperational((current) => {
      const overrides = { ...current.draft.overrides };
      if (index === 0) overrides.concurrency = Math.max(1, Math.min(32, (overrides.concurrency ?? current.inspection?.defaults.concurrency ?? current.preview?.plan.concurrency ?? 1) + direction));
      else if (index === 1) overrides.failureMode = (overrides.failureMode ?? current.preview?.plan.failureMode ?? "continue") === "continue" ? "fail-fast" : "continue";
      else if (index === 2) overrides.isolation = (overrides.isolation ?? current.preview?.plan.isolation ?? "shared") === "worktree" ? "shared" : "worktree";
      else overrides.allowDirtyBase = !overrides.allowDirtyBase;
      return { ...current, draft: { ...current.draft, overrides }, error: undefined };
    });
  }, [state.screen]);

  const requestCancellation = useCallback(() => {
    const active = handle.current ?? service.registry?.current();
    if (!active) return setOperationError(new Error("No attached workflow is active."));
    setOperational((current) => ({ ...current, cancellationRequested: true, error: undefined }));
    dispatch({ type: "navigate", screen: { kind: "cancel-progress", selection: 0 } });
    void active.requestCancellation("Cancelled from the operational TUI.").catch(setOperationError);
  }, [service, setOperationError]);

  function selectableCount(): number {
    const snapshot = state.snapshot;
    if (!snapshot) return 0;
    const screen = state.screen;
    if (screen.kind === "dashboard") return activeBatches(snapshot).length + recentBatches(snapshot).length;
    if (screen.kind === "history") return screen.mode === "batches" ? filteredBatches(snapshot, screen.filter).length : filteredTasks(snapshot, screen.filter).length;
    if (screen.kind === "workflow") return snapshot.batches.find((batch) => batch.key === screen.batchKey)?.report.tasks.length ?? 0;
    if (screen.kind === "task") return snapshot.tasks.find((task) => task.key === screen.taskKey)?.attempts.length ?? 0;
    if (screen.kind === "warnings") return snapshot.warnings.length;
    if (screen.kind === "planner") return operational.inspection?.tasks.length ?? 0;
    if (["plan", "resume-preview", "rerun-preview"].includes(screen.kind)) return operational.preview?.plan.tasks.length ?? 0;
    if (screen.kind === "options") return 4;
    if (screen.kind === "live") return operational.runtime?.tasks.length ?? 0;
    return 0;
  }

  function selection(): number {
    return state.screen.kind === "help" || state.screen.kind === "attempt" ? 0 : state.screen.selection;
  }

  function inspect(): void {
    const snapshot = state.snapshot;
    if (!snapshot) return;
    const screen = state.screen;
    if (screen.kind === "dashboard") {
      const item = [...activeBatches(snapshot), ...recentBatches(snapshot)][screen.selection];
      if (item && operational.runtime?.batchId === item.key && !operational.runtime.completedManifest) {
        dispatch({ type: "navigate", screen: { kind: "live", selection: 0, processIndex: 0, stream: "stdout", scroll: 0 } });
      } else if (item) dispatch({ type: "navigate", screen: { kind: "workflow", batchKey: item.key, selection: 0 } });
    } else if (screen.kind === "history") {
      if (screen.mode === "batches") {
        const item = filteredBatches(snapshot, screen.filter)[screen.selection];
        if (item) dispatch({ type: "navigate", screen: { kind: "workflow", batchKey: item.key, selection: 0 } });
      } else {
        const item = filteredTasks(snapshot, screen.filter)[screen.selection];
        if (item) dispatch({ type: "navigate", screen: { kind: "task", taskKey: item.key, selection: 0 } });
      }
    } else if (screen.kind === "workflow") {
      const batch = snapshot.batches.find((entry) => entry.key === screen.batchKey);
      const taskId = batch?.report.tasks[screen.selection]?.id;
      const task = taskId ? snapshot.tasks.find((entry) => entry.batchId === screen.batchKey && entry.taskId === taskId) : undefined;
      if (task) dispatch({ type: "navigate", screen: { kind: "task", taskKey: task.key, selection: Math.max(0, task.attempts.findIndex((attempt) => attempt.final)) } });
    } else if (screen.kind === "task") {
      const task = snapshot.tasks.find((entry) => entry.key === screen.taskKey);
      if (task?.attempts[screen.selection]) dispatch({ type: "navigate", screen: { kind: "attempt", taskKey: task.key, attemptIndex: screen.selection, processIndex: 0, stream: "stdout", scroll: 0 } });
    }
  }

  useInput((input, key) => {
    const attached = handle.current ?? service.registry?.current();
    const active = attached && attached.latestSnapshot().state !== "completed";
    if (key.ctrl && input === "c") {
      if (active) dispatch({ type: "navigate", screen: { kind: "cancel-confirm", selection: 0 } });
      else exit();
      return;
    }
    const action = resolveKey(input, key, state.screen.kind);
    if (!action) return;
    if (action === "quit") {
      if (active) {
        if (state.screen.kind !== "exit-confirm") dispatch({ type: "navigate", screen: { kind: "exit-confirm", selection: 0 } });
      } else exit();
      return;
    }
    if (action === "help") { if (state.screen.kind !== "help") dispatch({ type: "navigate", screen: { kind: "help" } }); return; }
    if (action === "back") {
      if (state.screen.kind === "live") dispatch({ type: "dashboard" });
      else if (state.screen.kind === "options") {
        setOperational((current) => ({ ...current, draft: { ...current.draft, overrides: { ...current.draft.optionBaseline } }, error: undefined }));
        dispatch({ type: "back" });
      } else dispatch({ type: "back" });
      return;
    }
    if (action === "refresh") { refresh(); if (state.screen.kind === "live") reconcileActive(); return; }
    if (action === "warnings") { dispatch({ type: "navigate", screen: { kind: "warnings", selection: 0 } }); return; }
    if (action === "history") { dispatch({ type: "navigate", screen: { kind: "history", mode: "batches", filter: "all", selection: 0 } }); return; }
    if (action === "plan-workflow") { openPlanner(); return; }
    if (action === "toggle-task" && state.screen.kind === "planner") {
      const task = operational.inspection?.tasks[state.screen.selection];
      if (task) setOperational((current) => ({
        ...current,
        draft: { ...current.draft, taskIds: current.draft.taskIds.includes(task.id) ? current.draft.taskIds.filter((id) => id !== task.id) : [...current.draft.taskIds, task.id] },
        error: undefined
      }));
      return;
    }
    if (action === "select-all") {
      setOperational((current) => ({ ...current, draft: { ...current.draft, taskIds: current.inspection?.tasks.map((task) => task.id) ?? [] }, error: undefined }));
      return;
    }
    if (action === "clear-selection") {
      setOperational((current) => ({ ...current, draft: { ...current.draft, taskIds: [] }, error: undefined }));
      return;
    }
    if (action === "edit-options") { dispatch({ type: "navigate", screen: { kind: "options", selection: 0 } }); return; }
    if (action === "option-left") { changeOption(-1); return; }
    if (action === "option-right") { changeOption(1); return; }
    if (action === "cancel-workflow") { dispatch({ type: "navigate", screen: { kind: "cancel-confirm", selection: 0 } }); return; }
    if (action === "resume-workflow") { previewHistoryAction("resume"); return; }
    if (action === "rerun-failed") { previewHistoryAction("failed"); return; }
    if (action === "rerun-branch") { previewHistoryAction("failed-branch"); return; }
    if (action === "rerun-all") { previewHistoryAction("all"); return; }
    if (action === "inspect") {
      if (state.screen.kind === "planner") requestPreview();
      else if (["plan", "resume-preview", "rerun-preview"].includes(state.screen.kind)) {
        if (operational.preview?.blockers[0]) setOperationError(new Error(`${operational.preview.blockers[0].message} ${operational.preview.blockers[0].correction}`));
        else dispatch({ type: "navigate", screen: { kind: "confirm", selection: 0 } });
      } else if (state.screen.kind === "options") requestPreview();
      else if (state.screen.kind === "confirm") launchWorkflow();
      else if (state.screen.kind === "cancel-confirm") requestCancellation();
      else if (state.screen.kind === "exit-confirm") {
        onDetachActive?.();
        setOperational((current) => ({ ...current, detached: true }));
        exit();
      } else if (state.screen.kind === "live") {
        const liveTask = operational.runtime?.tasks[state.screen.selection];
        const persisted = liveTask ? state.snapshot?.tasks.find((task) => task.batchId === operational.runtime?.batchId && task.taskId === liveTask.id) : undefined;
        if (persisted) dispatch({ type: "navigate", screen: { kind: "task", taskKey: persisted.key, selection: Math.max(0, persisted.attempts.length - 1) } });
      } else inspect();
      return;
    }
    if (action === "toggle-history") { dispatch({ type: "history-mode" }); return; }
    if (action === "cycle-filter") { dispatch({ type: "history-filter" }); return; }
    if (action === "toggle-attempts" && state.screen.kind === "workflow") {
      const screen = state.screen;
      const batch = state.snapshot?.batches.find((entry) => entry.key === screen.batchKey);
      const taskId = batch?.report.tasks[screen.selection]?.id;
      if (taskId) dispatch({ type: "toggle-attempts", taskId });
      return;
    }
    if (state.screen.kind === "attempt") {
      const screen = state.screen;
      const task = state.snapshot?.tasks.find((entry) => entry.key === screen.taskKey);
      const reference = task?.attempts[screen.attemptIndex];
      const detail = reference ? state.attempts[reference.key] : undefined;
      const processCount = detail ? processesFor(detail).length : 0;
      if (action === "previous-attempt") dispatch({ type: "attempt-index", index: Math.max(0, screen.attemptIndex - 1) });
      else if (action === "next-attempt") dispatch({ type: "attempt-index", index: Math.min(Math.max(0, (task?.attempts.length ?? 1) - 1), screen.attemptIndex + 1) });
      else if (action === "next-process") dispatch({ type: "process-index", index: processCount === 0 ? 0 : (screen.processIndex + 1) % processCount });
      else if (action === "stdout") dispatch({ type: "stream", stream: "stdout" });
      else if (action === "stderr") dispatch({ type: "stream", stream: "stderr" });
      else if (action === "up") dispatch({ type: "scroll", value: screen.scroll - 1 });
      else if (action === "down") dispatch({ type: "scroll", value: screen.scroll + 1 });
      else if (action === "page-up") dispatch({ type: "scroll", value: screen.scroll - 10 });
      else if (action === "page-down") dispatch({ type: "scroll", value: screen.scroll + 10 });
      else if (action === "first") dispatch({ type: "scroll", value: 0 });
      else if (action === "last") dispatch({ type: "scroll", value: Number.MAX_SAFE_INTEGER });
      return;
    }
    if (state.screen.kind === "live") {
      const live = state.screen;
      const task = operational.runtime?.tasks[live.selection];
      const processCount = task?.processes.length ?? 0;
      if (action === "next-process") dispatch({ type: "replace-screen", screen: { ...live, processIndex: processCount === 0 ? 0 : (live.processIndex + 1) % processCount, scroll: 0 } });
      else if (action === "stdout") dispatch({ type: "replace-screen", screen: { ...live, stream: "stdout", scroll: 0 } });
      else if (action === "stderr") dispatch({ type: "replace-screen", screen: { ...live, stream: "stderr", scroll: 0 } });
      else if (action === "up") dispatch({ type: "replace-screen", screen: { ...live, selection: Math.max(0, live.selection - 1), processIndex: 0, scroll: 0 } });
      else if (action === "down") dispatch({ type: "replace-screen", screen: { ...live, selection: Math.min(Math.max(0, (operational.runtime?.tasks.length ?? 1) - 1), live.selection + 1), processIndex: 0, scroll: 0 } });
      else if (action === "first") dispatch({ type: "replace-screen", screen: { ...live, selection: 0, processIndex: 0, scroll: 0 } });
      else if (action === "last") dispatch({ type: "replace-screen", screen: { ...live, selection: Math.max(0, (operational.runtime?.tasks.length ?? 1) - 1), processIndex: 0, scroll: 0 } });
      return;
    }
    const count = selectableCount();
    if (action === "up") dispatch({ type: "move", selection: Math.max(0, selection() - 1) });
    else if (action === "down") dispatch({ type: "move", selection: Math.min(Math.max(0, count - 1), selection() + 1) });
    else if (action === "first") dispatch({ type: "move", selection: 0 });
    else if (action === "last") dispatch({ type: "move", selection: Math.max(0, count - 1) });
  });

  return <AriadneTuiView state={state} operational={operational} width={terminalSize.width} height={terminalSize.height} color={color} unicode={unicode} verbose={verbose} />;
}
