import path from "node:path";
import { renderProcessSpec } from "./config.js";
import type { ObservedCommand, ProcessSpec } from "../types/index.js";

export interface ForbiddenCommandMatch {
  rule: string;
  command: string;
  source?: ObservedCommand["source"];
  confidence?: ObservedCommand["confidence"];
  matchType: "executable-prefix" | "argument-prefix" | "shell-token-prefix";
}

const TOKEN_PATTERN = /&&|\|\||[;|]|(?:[^\s"'\\;&|]+|\\.|"(?:\\.|[^"])*"|'[^']*')+/g;

export function tokenizeCommand(command: string): string[] {
  return (command.match(TOKEN_PATTERN) ?? []).map((token) => token.replace(/^(['"])(.*)\1$/, "$2"));
}

function commandStartTokens(tokens: string[]): string[] {
  let index = 0;
  while (tokens[index]?.includes("=") && !tokens[index]?.startsWith("=")) index += 1;
  if (tokens[index] === "env") {
    index += 1;
    while (tokens[index]?.includes("=") && !tokens[index]?.startsWith("=")) index += 1;
  }
  return tokens.slice(index);
}

function normalize(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function normalizedRules(rules: string[]): string[] {
  return [...new Set(rules.map(normalize).filter(Boolean))].sort();
}

function matchTokens(ruleTokens: string[], commandTokens: string[]): ForbiddenCommandMatch["matchType"] | undefined {
  if (ruleTokens.length === 0 || commandTokens.length < ruleTokens.length) return undefined;
  const matches = ruleTokens.every((token, index) => {
    if (index === 0) return path.basename(commandTokens[index]) === path.basename(token);
    return commandTokens[index] === token;
  });
  if (!matches) return undefined;
  return ruleTokens.length === 1 ? "executable-prefix" : "argument-prefix";
}

function matchRule(rule: string, command: string): ForbiddenCommandMatch["matchType"] | undefined {
  const ruleTokens = commandStartTokens(tokenizeCommand(rule));
  const commandTokens = commandStartTokens(tokenizeCommand(command));
  return matchTokens(ruleTokens, commandTokens);
}

function shellSegments(command: string): string[][] {
  const segments: string[][] = [[]];
  for (const token of tokenizeCommand(command)) {
    if (["&&", "||", ";", "|"].includes(token)) segments.push([]);
    else segments.at(-1)!.push(token);
  }
  return segments.filter((segment) => segment.length > 0);
}

function shellMatch(rule: string, command: string): ForbiddenCommandMatch["matchType"] | undefined {
  const ruleTokens = commandStartTokens(tokenizeCommand(rule));
  for (const segment of shellSegments(command)) {
    const commandTokens = commandStartTokens(segment);
    if (matchTokens(ruleTokens, commandTokens)) return "shell-token-prefix";
    if (["sh", "bash", "zsh"].includes(path.basename(commandTokens[0] ?? "")) && commandTokens[1] === "-c") {
      if (shellMatch(rule, commandTokens.slice(2).join(" "))) return "shell-token-prefix";
    }
  }
  return undefined;
}

export function findForbiddenCommandMatches(rules: string[], observedCommands: string[]): ForbiddenCommandMatch[] {
  const matches: ForbiddenCommandMatch[] = [];
  for (const rule of normalizedRules(rules)) {
    for (const command of [...new Set(observedCommands.map(normalize).filter(Boolean))].sort()) {
      const matchType = matchRule(rule, command);
      if (matchType) matches.push({ rule, command, matchType });
    }
  }
  return matches;
}

export function findForbiddenObservedCommandMatches(rules: string[], commands: ObservedCommand[]): ForbiddenCommandMatch[] {
  return commands.flatMap((observation) => {
    const matches = normalizedRules(rules).flatMap((rule) => {
      const matchType = shellMatch(rule, observation.representation);
      return matchType ? [{ rule, command: observation.representation, matchType }] : [];
    });
    return matches.map((match) => ({ ...match, source: observation.source, confidence: observation.confidence }));
  });
}

export function findForbiddenProcessSpecMatches(rules: string[], spec: ProcessSpec): ForbiddenCommandMatch[] {
  const command = renderProcessSpec(spec);
  if (spec.kind === "exec") return findForbiddenCommandMatches(rules, [command]);
  return normalizedRules(rules).flatMap((rule) => {
    const matchType = shellMatch(rule, command);
    return matchType ? [{ rule, command, matchType }] : [];
  });
}
