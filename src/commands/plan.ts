import { createWorkflowPlanPreview } from "../core/workflow-application.js";
import { AriadneError } from "../core/errors.js";
import { hasShownPlanGuide, markPlanGuideShown } from "../core/onboarding-state.js";
import { formatWorkflowPlan, formatWorkflowPlanGuide } from "../core/workflow-report.js";
import type { FailureMode, IsolationStrategy, WorkflowPlan } from "../types/index.js";

export async function planCommand(options: { cwd: string; configPath: string; taskIds?: string[]; concurrency?: number; failureMode?: FailureMode; isolation?: IsolationStrategy; allowDirtyBase?: boolean; json?: boolean; quiet?: boolean }): Promise<WorkflowPlan> {
  const preview = await createWorkflowPlanPreview(options);
  const blocker = preview.blockers[0];
  if (blocker) throw new AriadneError({ category: blocker.category, code: blocker.code, stage: "validated", message: blocker.message, correction: blocker.correction });
  const plan = preview.plan;
  const guideWasShown = await hasShownPlanGuide(options.cwd).catch(() => false);
  const showGuide = !options.json && !options.quiet && !guideWasShown;
  const formatted = options.json
    ? JSON.stringify(plan, null, 2)
    : [formatWorkflowPlan(plan), ...(showGuide ? ["", formatWorkflowPlanGuide()] : [])].join("\n");
  process.stdout.write(`${formatted}\n`);
  if (showGuide) await markPlanGuideShown(options.cwd).catch(() => undefined);
  if (!options.quiet) for (const warning of preview.warnings) process.stderr.write(`Warning: ${warning}\n`);
  return plan;
}
