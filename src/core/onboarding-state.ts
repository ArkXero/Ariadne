import path from "node:path";
import fs from "fs-extra";
import { atomicWriteFile } from "./atomic.js";

const PLAN_GUIDE_MARKER = path.join(".ariadne", "onboarding", "plan-guide-v1");

export function planGuideMarkerPath(cwd: string): string {
  return path.join(cwd, PLAN_GUIDE_MARKER);
}

export async function hasShownPlanGuide(cwd: string): Promise<boolean> {
  return fs.pathExists(planGuideMarkerPath(cwd));
}

export async function markPlanGuideShown(cwd: string): Promise<void> {
  await atomicWriteFile(planGuideMarkerPath(cwd), "shown\n");
}
