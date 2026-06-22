export interface ForbiddenCommandMatch {
  rule: string;
  command: string;
}

const TOKEN_PATTERN = /(?:[^\s"'\\]+|\\.|"(?:\\.|[^"])*"|'[^']*')+/g;

function tokenize(command: string): string[] {
  return (command.match(TOKEN_PATTERN) ?? [])
    .map((token) => token.replace(/^(['"])(.*)\1$/, "$2"));
}

function commandStartTokens(tokens: string[]): string[] {
  let index = 0;

  while (tokens[index]?.includes("=") && !tokens[index]?.startsWith("=")) {
    index += 1;
  }

  if (tokens[index] === "env") {
    index += 1;
    while (tokens[index]?.includes("=") && !tokens[index]?.startsWith("=")) {
      index += 1;
    }
  }

  return tokens.slice(index);
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function commandLines(values: string[]): string[] {
  const lines = values.flatMap((value) => value.split(/\r?\n/));
  return [...new Set(lines.map(normalizeCommand).filter(Boolean))].sort();
}

function ruleMatchesCommand(rule: string, command: string): boolean {
  const ruleTokens = commandStartTokens(tokenize(rule));
  const commandTokens = commandStartTokens(tokenize(command));

  if (ruleTokens.length === 0 || commandTokens.length < ruleTokens.length) {
    return false;
  }

  return ruleTokens.every((token, index) => commandTokens[index] === token);
}

export function findForbiddenCommandMatches(rules: string[], observedCommands: string[]): ForbiddenCommandMatch[] {
  const matches: ForbiddenCommandMatch[] = [];

  for (const rule of commandLines(rules)) {
    for (const command of commandLines(observedCommands)) {
      if (ruleMatchesCommand(rule, command)) {
        matches.push({ rule, command });
      }
    }
  }

  return matches.sort((left, right) => {
    const ruleOrder = left.rule.localeCompare(right.rule);
    return ruleOrder === 0 ? left.command.localeCompare(right.command) : ruleOrder;
  });
}
