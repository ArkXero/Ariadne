import type { ProcessSpec } from "../types/index.js";

const SECRET_FLAG = /(?:token|secret|password|passwd|api[-_]?key|authorization|credential)/i;

function quote(value: string): string {
  return value === "" || /[\s"'\\]/.test(value) ? JSON.stringify(value) : value;
}

export function redactArguments(args: string[]): { args: string[]; redacted: boolean } {
  let redactNext = false;
  let redacted = false;
  const result = args.map((argument) => {
    if (redactNext) {
      redactNext = false;
      redacted = true;
      return "[REDACTED]";
    }

    const equalsIndex = argument.indexOf("=");
    if (equalsIndex > 0 && SECRET_FLAG.test(argument.slice(0, equalsIndex))) {
      redacted = true;
      return `${argument.slice(0, equalsIndex + 1)}[REDACTED]`;
    }

    if (argument.startsWith("-") && SECRET_FLAG.test(argument)) {
      redactNext = true;
    }
    return argument;
  });
  return { args: result, redacted };
}

export function redactShellCommand(command: string): string {
  return command
    .replace(/((?:token|secret|password|passwd|api[-_]?key|authorization|credential)\s*=\s*)("(?:\\.|[^"])*"|'[^']*'|[^\s]+)/gi, "$1[REDACTED]")
    .replace(/((?:--?)(?:token|secret|password|passwd|api[-_]?key|authorization|credential)(?:=|\s+))("(?:\\.|[^"])*"|'[^']*'|[^\s]+)/gi, "$1[REDACTED]");
}

export function persistedCommand(spec: ProcessSpec): { executable: string; args: string[]; displayCommand: string } {
  if (spec.kind === "shell") {
    const command = redactShellCommand(spec.command);
    return {
      executable: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
      args: process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command],
      displayCommand: command
    };
  }

  const redacted = redactArguments(spec.args);
  return {
    executable: spec.file,
    args: redacted.args,
    displayCommand: [spec.file, ...redacted.args].map(quote).join(" ")
  };
}

export function actualCommand(spec: ProcessSpec): { file: string; args: string[] } {
  if (spec.kind === "shell") {
    return process.platform === "win32"
      ? { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", spec.command] }
      : { file: "/bin/sh", args: ["-c", spec.command] };
  }
  return { file: spec.file, args: spec.args };
}
