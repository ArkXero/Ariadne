export const ENTER_ALTERNATE_SCREEN = "\u001B[?1049h\u001B[2J\u001B[H\u001B[?25l";
export const LEAVE_ALTERNATE_SCREEN = "\u001B[0m\u001B[?25h\u001B[?1049l";

export interface TerminalSession {
  enter(): void;
  restore(): void;
  readonly active: boolean;
}

export function createTerminalSession(output: Pick<NodeJS.WriteStream, "write">): TerminalSession {
  let active = false;
  return {
    get active() { return active; },
    enter() {
      if (active) return;
      output.write(ENTER_ALTERNATE_SCREEN);
      active = true;
    },
    restore() {
      if (!active) return;
      active = false;
      output.write(LEAVE_ALTERNATE_SCREEN);
    }
  };
}

export function supportsUnicodeTerminal(environment: NodeJS.ProcessEnv = process.env): boolean {
  if (environment.TERM === "dumb") return false;
  const locale = `${environment.LC_ALL ?? ""} ${environment.LC_CTYPE ?? ""} ${environment.LANG ?? ""}`;
  return locale.length === 2 || /utf-?8/i.test(locale);
}

export function supportsTuiColor(output: NodeJS.WriteStream, requested: boolean | undefined, environment: NodeJS.ProcessEnv = process.env): boolean {
  if (requested === false || Object.prototype.hasOwnProperty.call(environment, "NO_COLOR") || environment.TERM === "dumb") return false;
  return typeof output.getColorDepth !== "function" || output.getColorDepth() >= 4;
}
