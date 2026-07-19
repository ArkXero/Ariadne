import path from "node:path";
import fs from "fs-extra";
import { parse } from "yaml";
import { z } from "zod";
import { AriadneError } from "./errors.js";
import {
  CURRENT_CONFIG_VERSION,
  type AriadneConfig,
  type LoadedConfig,
  type ProcessSpec
} from "../types/index.js";

export const MAX_TIMEOUT_MS = 86_400_000;
export const MAX_CONCURRENCY = 32;
const DEFAULT_AGENT_TIMEOUT_MS = 600_000;
const DEFAULT_VERIFICATION_TIMEOUT_MS = 300_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const DEFAULT_PREPARATION_TIMEOUT_MS = 600_000;

const NonEmptyString = z.string().trim().min(1);
const TimeoutSchema = z.number().int().min(1).max(MAX_TIMEOUT_MS);
const ProcessSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("exec"),
    file: NonEmptyString,
    args: z.array(z.string()).default([])
  }).strict(),
  z.object({
    kind: z.literal("shell"),
    command: NonEmptyString
  }).strict()
]);

const ChecksSchema = z.object({
  forbidden_files: z.array(NonEmptyString).default([]),
  max_changed_files: z.number().int().nonnegative().optional(),
  max_diff_lines: z.number().int().nonnegative().optional(),
  forbidden_commands: z.array(NonEmptyString).default([])
}).strict().default({
  forbidden_files: [],
  forbidden_commands: []
});

const ConfigTailSchema = {
  tasks: z.object({
    directory: NonEmptyString.default(".ariadne/tasks")
  }).strict().default({ directory: ".ariadne/tasks" }),
  verification: z.object({
    commands: z.array(ProcessSpecSchema).default([]),
    timeout_ms: TimeoutSchema.default(DEFAULT_VERIFICATION_TIMEOUT_MS)
  }).strict().default({ commands: [], timeout_ms: DEFAULT_VERIFICATION_TIMEOUT_MS }),
  execution: z.object({
    termination_grace_ms: z.number().int().min(100).max(30_000).default(DEFAULT_TERMINATION_GRACE_MS),
    concurrency: z.number().int().min(1).max(MAX_CONCURRENCY).default(1),
    failure_mode: z.enum(["continue", "fail-fast"]).default("continue"),
    isolation: z.enum(["shared", "worktree"]).default("shared"),
    worktree: z.object({
      retention: z.enum(["always", "on-failure", "never"]).default("on-failure"),
      preparation: z.object({
        commands: z.array(ProcessSpecSchema).default([]),
        timeout_ms: TimeoutSchema.default(DEFAULT_PREPARATION_TIMEOUT_MS)
      }).strict().default({ commands: [], timeout_ms: DEFAULT_PREPARATION_TIMEOUT_MS })
    }).strict().default({ retention: "on-failure", preparation: { commands: [], timeout_ms: DEFAULT_PREPARATION_TIMEOUT_MS } })
  }).strict().default({ termination_grace_ms: DEFAULT_TERMINATION_GRACE_MS, concurrency: 1, failure_mode: "continue", isolation: "shared", worktree: { retention: "on-failure", preparation: { commands: [], timeout_ms: DEFAULT_PREPARATION_TIMEOUT_MS } } }),
  checks: ChecksSchema
};

const V5ConfigSchema = z.object({
  version: z.literal(CURRENT_CONFIG_VERSION),
  agent: z.object({
    command: ProcessSpecSchema,
    timeout_ms: TimeoutSchema.default(DEFAULT_AGENT_TIMEOUT_MS),
    model_label: NonEmptyString
  }).strict(),
  ...ConfigTailSchema,
  benchmarking: z.object({
    judge: z.object({
      command: ProcessSpecSchema,
      model_label: NonEmptyString,
      timeout_ms: TimeoutSchema.default(DEFAULT_AGENT_TIMEOUT_MS)
    }).strict(),
    blind_candidate_identity: z.boolean().default(true)
  }).strict().optional()
}).strict();

const V4ConfigSchema = z.object({
  version: z.literal(4),
  agent: z.object({
    command: ProcessSpecSchema,
    timeout_ms: TimeoutSchema.default(DEFAULT_AGENT_TIMEOUT_MS)
  }).strict(),
  ...ConfigTailSchema
}).strict();

const V3ConfigSchema = z.object({
  version: z.literal(3),
  agent: z.object({ command: ProcessSpecSchema, timeout_ms: TimeoutSchema.default(DEFAULT_AGENT_TIMEOUT_MS) }).strict(),
  tasks: z.object({ directory: NonEmptyString.default(".ariadne/tasks") }).strict().default({ directory: ".ariadne/tasks" }),
  verification: z.object({ commands: z.array(ProcessSpecSchema).default([]), timeout_ms: TimeoutSchema.default(DEFAULT_VERIFICATION_TIMEOUT_MS) }).strict().default({ commands: [], timeout_ms: DEFAULT_VERIFICATION_TIMEOUT_MS }),
  execution: z.object({
    termination_grace_ms: z.number().int().min(100).max(30_000).default(DEFAULT_TERMINATION_GRACE_MS),
    concurrency: z.number().int().min(1).max(MAX_CONCURRENCY).default(1),
    failure_mode: z.enum(["continue", "fail-fast"]).default("continue")
  }).strict().default({ termination_grace_ms: DEFAULT_TERMINATION_GRACE_MS, concurrency: 1, failure_mode: "continue" }),
  checks: ChecksSchema
}).strict();

const V2ConfigSchema = z.object({
  version: z.literal(2),
  agent: z.object({ command: ProcessSpecSchema, timeout_ms: TimeoutSchema.default(DEFAULT_AGENT_TIMEOUT_MS) }).strict(),
  tasks: z.object({ directory: NonEmptyString.default(".ariadne/tasks") }).strict().default({ directory: ".ariadne/tasks" }),
  verification: z.object({ commands: z.array(ProcessSpecSchema).default([]), timeout_ms: TimeoutSchema.default(DEFAULT_VERIFICATION_TIMEOUT_MS) }).strict().default({ commands: [], timeout_ms: DEFAULT_VERIFICATION_TIMEOUT_MS }),
  execution: z.object({ termination_grace_ms: z.number().int().min(100).max(30_000).default(DEFAULT_TERMINATION_GRACE_MS) }).strict().default({ termination_grace_ms: DEFAULT_TERMINATION_GRACE_MS }),
  checks: ChecksSchema
}).strict();

const LegacyConfigSchema = z.object({
  version: z.literal(1).optional(),
  agent: z.object({
    command: NonEmptyString,
    timeout_ms: TimeoutSchema.default(DEFAULT_AGENT_TIMEOUT_MS)
  }).strict(),
  tasks: z.object({
    directory: NonEmptyString.default(".ariadne/tasks")
  }).strict().default({ directory: ".ariadne/tasks" }),
  verification: z.object({
    commands: z.array(NonEmptyString).default([]),
    timeout_ms: TimeoutSchema.default(DEFAULT_VERIFICATION_TIMEOUT_MS)
  }).strict().default({ commands: [], timeout_ms: DEFAULT_VERIFICATION_TIMEOUT_MS }),
  checks: ChecksSchema
}).strict();

function issuePath(parts: PropertyKey[]): string {
  return parts.length === 0 ? "(root)" : parts.map(String).join(".");
}

function validationError(source: string, error: z.ZodError): AriadneError {
  const issues = error.issues.map((issue) => ({
    path: issuePath(issue.path),
    message: issue.message,
    code: issue.code
  }));
  return new AriadneError({
    category: "configuration",
    code: "CONFIG_SCHEMA_INVALID",
    stage: "loading",
    source,
    message: `Invalid Ariadne configuration:\n${issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n")}`,
    expected: `A strict Ariadne configuration with version ${CURRENT_CONFIG_VERSION}, or a compatible versionless, v1, v2, v3, or v4 configuration.`,
    correction: "Fix the listed fields and run \"ariadne doctor\" again.",
    details: { issues }
  });
}

function asLegacyShell(command: string): ProcessSpec {
  return { kind: "shell", command };
}

function normalizeLegacyConfig(
  config: z.infer<typeof LegacyConfigSchema>,
  sourceVersion: "versionless" | 1
): AriadneConfig {
  return {
    version: CURRENT_CONFIG_VERSION,
    sourceVersion,
    agent: {
      command: asLegacyShell(config.agent.command),
      timeout_ms: config.agent.timeout_ms
    },
    tasks: config.tasks,
    verification: {
      commands: config.verification.commands.map(asLegacyShell),
      timeout_ms: config.verification.timeout_ms
    },
    execution: legacyExecution({ termination_grace_ms: DEFAULT_TERMINATION_GRACE_MS, concurrency: 1, failure_mode: "continue" }),
    checks: config.checks
  };
}

function normalizeV2Config(config: z.infer<typeof V2ConfigSchema>): AriadneConfig {
  return {
    ...config,
    version: CURRENT_CONFIG_VERSION,
    sourceVersion: 2,
    execution: legacyExecution({ ...config.execution, concurrency: 1, failure_mode: "continue" })
  };
}

function legacyExecution(execution: { termination_grace_ms: number; concurrency: number; failure_mode: "continue" | "fail-fast" }): AriadneConfig["execution"] {
  return {
    ...execution,
    isolation: "shared",
    worktree: { retention: "on-failure", preparation: { commands: [], timeout_ms: DEFAULT_PREPARATION_TIMEOUT_MS } }
  };
}

function normalizeV3Config(config: z.infer<typeof V3ConfigSchema>): AriadneConfig {
  return { ...config, version: CURRENT_CONFIG_VERSION, sourceVersion: 3, execution: legacyExecution(config.execution) };
}

function normalizeV4Config(config: z.infer<typeof V4ConfigSchema>): AriadneConfig {
  return { ...config, version: CURRENT_CONFIG_VERSION, sourceVersion: 4 };
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeDeep(child);
    }
  }
  return value;
}

function containsTraversal(value: string): boolean {
  return value.replace(/\\/g, "/").split("/").some((segment) => segment === "..");
}

function isAbsoluteAnyPlatform(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function validateRelativePath(value: string, source: string, fieldPath: string): void {
  if (isAbsoluteAnyPlatform(value) || containsTraversal(value)) {
    throw new AriadneError({
      category: "configuration",
      code: "CONFIG_PATH_OUTSIDE_ROOT",
      stage: "validated",
      source,
      message: `${fieldPath} must stay inside the project root.`,
      fieldPath,
      offendingValue: value,
      expected: "A repository-relative path without '..' traversal segments.",
      correction: `Make ${fieldPath} relative to the Ariadne project root.`
    });
  }
}

function validatePatterns(patterns: string[], source: string): void {
  for (const [index, pattern] of patterns.entries()) {
    if (isAbsoluteAnyPlatform(pattern) || containsTraversal(pattern) || pattern.startsWith("!")) {
      throw new AriadneError({
        category: "configuration",
        code: "CONFIG_FORBIDDEN_PATTERN_INVALID",
        stage: "validated",
        source,
        message: "Forbidden-file pattern is unsafe or unsupported.",
        fieldPath: `checks.forbidden_files.${index}`,
        offendingValue: pattern,
        expected: "A non-negative repository-relative POSIX glob without traversal.",
        correction: "Remove absolute roots, '..' segments, or a leading '!'."
      });
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function loadConfig(cwd: string, configPath = "ariadne.yml"): Promise<LoadedConfig> {
  const projectRoot = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const unresolvedPath = path.resolve(projectRoot, configPath);

  if (!isInside(projectRoot, unresolvedPath)) {
    throw new AriadneError({
      category: "configuration",
      code: "CONFIG_PATH_OUTSIDE_ROOT",
      stage: "loading",
      source: unresolvedPath,
      message: "Config path must stay inside the invocation root.",
      offendingValue: configPath,
      expected: "A config file inside the invocation root.",
      correction: "Run Ariadne from the project root and use a config path inside it."
    });
  }

  if (!(await fs.pathExists(unresolvedPath))) {
    throw new AriadneError({
      category: "configuration",
      code: "CONFIG_NOT_FOUND",
      stage: "loading",
      source: unresolvedPath,
      message: `Config not found: ${configPath}.`,
      correction: "Run \"ariadne init\" first or pass --config with an existing project-relative path."
    });
  }

  const resolvedPath = await fs.realpath(unresolvedPath);
  if (!isInside(projectRoot, resolvedPath)) {
    throw new AriadneError({
      category: "configuration",
      code: "CONFIG_SYMLINK_OUTSIDE_ROOT",
      stage: "loading",
      source: unresolvedPath,
      message: "The config file resolves outside the invocation root.",
      correction: "Use a regular file or a symlink whose target remains inside the project."
    });
  }

  let rawConfig: unknown;
  try {
    rawConfig = parse(await fs.readFile(resolvedPath, "utf8"));
  } catch (error) {
    throw new AriadneError({
      category: "configuration",
      code: "CONFIG_YAML_INVALID",
      stage: "loading",
      source: resolvedPath,
      message: `Could not parse ${path.relative(projectRoot, resolvedPath) || path.basename(resolvedPath)}: ${error instanceof Error ? error.message : String(error)}`,
      correction: "Fix the YAML syntax and run \"ariadne doctor\" again.",
      cause: error
    });
  }

  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    throw new AriadneError({
      category: "configuration",
      code: "CONFIG_ROOT_INVALID",
      stage: "loading",
      source: resolvedPath,
      message: "Ariadne configuration must be a YAML mapping.",
      offendingValue: rawConfig,
      expected: "A top-level mapping with version, agent, tasks, verification, execution, and checks fields."
    });
  }

  const rawVersion = (rawConfig as Record<string, unknown>).version;
  let config: AriadneConfig;
  const warnings: string[] = [];

  if (rawVersion === CURRENT_CONFIG_VERSION) {
    const parsed = V5ConfigSchema.safeParse(rawConfig);
    if (!parsed.success) throw validationError(resolvedPath, parsed.error);
    config = { ...parsed.data, sourceVersion: CURRENT_CONFIG_VERSION };
  } else if (rawVersion === 4) {
    const parsed = V4ConfigSchema.safeParse(rawConfig);
    if (!parsed.success) throw validationError(resolvedPath, parsed.error);
    config = normalizeV4Config(parsed.data);
  } else if (rawVersion === 3) {
    const parsed = V3ConfigSchema.safeParse(rawConfig);
    if (!parsed.success) throw validationError(resolvedPath, parsed.error);
    config = normalizeV3Config(parsed.data);
    warnings.push("Configuration version 3 is deprecated; migrate to version 5. V3 parallelSafe: true tasks adapt to workspaceMode: read-only.");
  } else if (rawVersion === 2) {
    const parsed = V2ConfigSchema.safeParse(rawConfig);
    if (!parsed.success) throw validationError(resolvedPath, parsed.error);
    config = normalizeV2Config(parsed.data);
    warnings.push("Configuration version 2 is deprecated; migrate to version 5 for workflows, isolated execution, and model provenance.");
  } else if (rawVersion === undefined || rawVersion === 1) {
    const parsed = LegacyConfigSchema.safeParse(rawConfig);
    if (!parsed.success) throw validationError(resolvedPath, parsed.error);
    const sourceVersion = rawVersion === undefined ? "versionless" : 1;
    config = normalizeLegacyConfig(parsed.data, sourceVersion);
    warnings.push(
      sourceVersion === "versionless"
        ? "Versionless configuration is deprecated; migrate to version 5 and explicit process specs."
        : "Configuration version 1 is deprecated; migrate command strings to version 5 process specs."
    );
  } else if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion)) {
    throw new AriadneError({
      category: "configuration",
      code: "CONFIG_VERSION_MALFORMED",
      stage: "loading",
      source: resolvedPath,
      message: "Configuration version is malformed.",
      fieldPath: "version",
      offendingValue: rawVersion,
      expected: `Integer configuration version ${CURRENT_CONFIG_VERSION}.`,
      correction: `Set version: ${CURRENT_CONFIG_VERSION}.`
    });
  } else {
    throw new AriadneError({
      category: "configuration",
      code: rawVersion > CURRENT_CONFIG_VERSION ? "CONFIG_VERSION_FUTURE" : "CONFIG_VERSION_UNSUPPORTED",
      stage: "loading",
      source: resolvedPath,
      message: `Configuration version ${rawVersion} is not supported.`,
      fieldPath: "version",
      offendingValue: rawVersion,
      expected: `Configuration version 1, 2, 3, 4, or ${CURRENT_CONFIG_VERSION}.`,
      correction: rawVersion > CURRENT_CONFIG_VERSION
        ? "Upgrade Ariadne to a version that supports this configuration."
        : `Migrate the configuration to version ${CURRENT_CONFIG_VERSION}.`
    });
  }

  validateRelativePath(config.tasks.directory, resolvedPath, "tasks.directory");
  validatePatterns(config.checks.forbidden_files, resolvedPath);

  return {
    config: freezeDeep(config),
    path: resolvedPath,
    projectRoot,
    warnings
  };
}

export function renderProcessSpec(spec: ProcessSpec): string {
  return spec.kind === "shell"
    ? spec.command
    : [spec.file, ...spec.args].map((value) => /\s/.test(value) ? JSON.stringify(value) : value).join(" ");
}
