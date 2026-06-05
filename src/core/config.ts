import path from "node:path";
import fs from "fs-extra";
import { parse } from "yaml";
import { z } from "zod";
import type { AriadneConfig } from "../types/index.js";

const ConfigSchema = z.object({
  version: z.number().int().positive().default(1),
  agent: z.object({
    command: z.string().min(1, "agent.command is required"),
    timeout_ms: z.number().int().positive().default(600_000)
  }),
  tasks: z.object({
    directory: z.string().min(1).default(".ariadne/tasks")
  }).default({
    directory: ".ariadne/tasks"
  }),
  verification: z.object({
    commands: z.array(z.string().min(1)).default([]),
    timeout_ms: z.number().int().positive().default(300_000)
  }).default({
    commands: [],
    timeout_ms: 300_000
  }),
  checks: z.object({
    forbidden_files: z.array(z.string().min(1)).default([]),
    max_changed_files: z.number().int().nonnegative().optional(),
    max_diff_lines: z.number().int().nonnegative().optional(),
    forbidden_commands: z.array(z.string().min(1)).default([])
  }).default({
    forbidden_files: [],
    forbidden_commands: []
  })
});

export async function loadConfig(cwd: string, configPath = "ariadne.yml"): Promise<{ config: AriadneConfig; path: string }> {
  const resolvedPath = path.resolve(cwd, configPath);

  if (!(await fs.pathExists(resolvedPath))) {
    throw new Error(`Config not found: ${resolvedPath}. Run "ariadne init" first.`);
  }

  let rawConfig: unknown;
  try {
    rawConfig = parse(await fs.readFile(resolvedPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse ${resolvedPath}: ${message}`);
  }

  const parsed = ConfigSchema.safeParse(rawConfig ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid Ariadne config:\n${issues}`);
  }

  return { config: parsed.data, path: resolvedPath };
}
