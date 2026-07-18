export const ARIADNE_PALETTE = Object.freeze({
  coral: "#F6453C",
  warningOrange: "#F59E0B",
  successGreen: "#4ADE80",
  infoCyan: "#22D3EE",
  snow: "#FCF7F8",
  paleSlate: "#CED3DC",
  deepSlate: "#64748B"
} as const);

export const ARIADNE_REPORT_INK = "#9C2630";

export const ARIADNE_THEME = Object.freeze({
  accent: ARIADNE_PALETTE.coral,
  foreground: ARIADNE_PALETTE.snow,
  muted: ARIADNE_PALETTE.paleSlate,
  border: ARIADNE_PALETTE.coral,
  focusedBorder: ARIADNE_PALETTE.coral,
  warning: ARIADNE_PALETTE.warningOrange,
  error: ARIADNE_PALETTE.coral,
  success: ARIADNE_PALETTE.successGreen,
  info: ARIADNE_PALETTE.infoCyan,
  reportForeground: ARIADNE_REPORT_INK,
  canvas: ARIADNE_PALETTE.paleSlate,
  surface: ARIADNE_PALETTE.snow,
  codeBackground: ARIADNE_REPORT_INK,
  codeForeground: ARIADNE_PALETTE.snow
} as const);

export const ARIADNE_CSS_VARIABLES = `:root{--ariadne-coral:${ARIADNE_PALETTE.coral};--ariadne-report-ink:${ARIADNE_REPORT_INK};--ariadne-warning-orange:${ARIADNE_PALETTE.warningOrange};--ariadne-success-green:${ARIADNE_PALETTE.successGreen};--ariadne-info-cyan:${ARIADNE_PALETTE.infoCyan};--ariadne-snow:${ARIADNE_PALETTE.snow};--ariadne-pale-slate:${ARIADNE_PALETTE.paleSlate};--ariadne-deep-slate:${ARIADNE_PALETTE.deepSlate};--ariadne-accent:var(--ariadne-coral);--ariadne-foreground:var(--ariadne-snow);--ariadne-report-foreground:var(--ariadne-report-ink);--ariadne-muted:var(--ariadne-pale-slate);--ariadne-border:var(--ariadne-coral);--ariadne-focused-border:var(--ariadne-coral);--ariadne-warning:var(--ariadne-warning-orange);--ariadne-error:var(--ariadne-coral);--ariadne-success:var(--ariadne-success-green);--ariadne-info:var(--ariadne-info-cyan);--ariadne-canvas:var(--ariadne-pale-slate);--ariadne-surface:var(--ariadne-snow);--ariadne-code-background:var(--ariadne-report-ink);--ariadne-code-foreground:var(--ariadne-snow)}`;

function rgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16)
  ];
}

function foregroundSequence(hex: string): string {
  const [red, green, blue] = rgb(hex);
  return `\u001B[38;2;${red};${green};${blue}m`;
}

function backgroundSequence(hex: string): string {
  const [red, green, blue] = rgb(hex);
  return `\u001B[48;2;${red};${green};${blue}m`;
}

const FOREGROUND_BY_ANSI_CODE: Readonly<Record<string, string>> = Object.freeze({
  "30": ARIADNE_THEME.accent,
  "31": ARIADNE_THEME.accent,
  "32": ARIADNE_THEME.accent,
  "33": ARIADNE_THEME.warning,
  "34": ARIADNE_THEME.muted,
  "35": ARIADNE_THEME.accent,
  "36": ARIADNE_THEME.accent,
  "37": ARIADNE_THEME.foreground,
  "39": ARIADNE_THEME.foreground,
  "90": ARIADNE_THEME.accent,
  "91": ARIADNE_THEME.accent,
  "92": ARIADNE_THEME.accent,
  "93": ARIADNE_THEME.warning,
  "94": ARIADNE_THEME.muted,
  "95": ARIADNE_THEME.accent,
  "96": ARIADNE_THEME.accent,
  "97": ARIADNE_THEME.foreground
});

const BACKGROUND_BY_ANSI_CODE: Readonly<Record<string, string>> = Object.freeze({
  "40": ARIADNE_THEME.accent,
  "41": ARIADNE_THEME.accent,
  "42": ARIADNE_THEME.accent,
  "43": ARIADNE_THEME.warning,
  "44": ARIADNE_THEME.muted,
  "45": ARIADNE_THEME.accent,
  "46": ARIADNE_THEME.accent,
  "47": ARIADNE_THEME.muted,
  "100": ARIADNE_THEME.accent,
  "101": ARIADNE_THEME.accent,
  "102": ARIADNE_THEME.accent,
  "103": ARIADNE_THEME.warning,
  "104": ARIADNE_THEME.muted,
  "105": ARIADNE_THEME.accent,
  "106": ARIADNE_THEME.accent,
  "107": ARIADNE_THEME.muted
});

/** Remap Clack's semantic ANSI colors onto the Ariadne palette. */
export function applyAriadneAnsiTheme(value: string): string {
  const foreground = foregroundSequence(ARIADNE_THEME.foreground);
  const themed = value.replace(/\u001B\[(\d+)m/g, (sequence, code: string) => {
    if (code === "0") return `\u001B[0m${foreground}`;
    const foregroundColor = FOREGROUND_BY_ANSI_CODE[code];
    if (foregroundColor) return foregroundSequence(foregroundColor);
    const backgroundColor = BACKGROUND_BY_ANSI_CODE[code];
    if (backgroundColor) return backgroundSequence(backgroundColor);
    return sequence;
  });
  return `${foreground}${themed}\u001B[0m`;
}

/** Scope the Clack palette adapter to one interactive onboarding session. */
export async function withAriadneTerminalTheme<T>(
  enabled: boolean,
  operation: () => Promise<T>,
  output: Pick<NodeJS.WriteStream, "write"> = process.stdout
): Promise<T> {
  if (!enabled) return operation();
  const originalWrite = output.write;
  const themedWrite = ((chunk: string | Uint8Array, ...args: unknown[]) => Reflect.apply(
    originalWrite,
    output,
    [typeof chunk === "string" ? applyAriadneAnsiTheme(chunk) : chunk, ...args]
  )) as typeof output.write;
  output.write = themedWrite;
  try {
    return await operation();
  } finally {
    output.write = originalWrite;
  }
}
