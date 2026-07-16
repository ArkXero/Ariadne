import { prepareWorkflow } from "../core/workflow-runner.js";
import { formatWorkflowPlan } from "../core/workflow-report.js";
import type { FailureMode, IsolationStrategy, WorkflowPlan } from "../types/index.js";

export async function planCommand(options: { cwd: string; configPath: string; taskIds?: string[]; concurrency?: number; failureMode?: FailureMode; isolation?: IsolationStrategy; allowDirtyBase?: boolean; json?: boolean; quiet?: boolean }): Promise<WorkflowPlan> {
  const prepared = await prepareWorkflow(options);
  const plan = prepared.plan;
  process.stdout.write(options.json ? `${JSON.stringify(plan, null, 2)}\n` : `${formatWorkflowPlan(plan)}\n`);
  if (!options.quiet) for (const warning of prepared.compatibilityWarnings) process.stderr.write(`Warning: ${warning}\n`);
  return plan;
}
