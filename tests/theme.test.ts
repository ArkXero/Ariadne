import { describe, expect, it } from "vitest";
import {
  applyAriadneAnsiTheme,
  ARIADNE_CSS_VARIABLES,
  ARIADNE_PALETTE,
  ARIADNE_REPORT_INK,
  ARIADNE_THEME,
  withAriadneTerminalTheme
} from "../src/theme.js";

describe("Ariadne design system", () => {
  it("defines the supplied palette as the single semantic source", () => {
    expect(ARIADNE_PALETTE).toEqual({
      coral: "#F6453C",
      warningOrange: "#F59E0B",
      successGreen: "#4ADE80",
      infoCyan: "#22D3EE",
      snow: "#FCF7F8",
      paleSlate: "#CED3DC",
      deepSlate: "#64748B"
    });
    expect(ARIADNE_THEME).toMatchObject({
      accent: ARIADNE_PALETTE.coral,
      foreground: ARIADNE_PALETTE.snow,
      muted: ARIADNE_PALETTE.paleSlate,
      border: ARIADNE_PALETTE.coral,
      focusedBorder: ARIADNE_PALETTE.coral,
      warning: ARIADNE_PALETTE.warningOrange,
      error: ARIADNE_PALETTE.coral,
      success: ARIADNE_PALETTE.successGreen,
      info: ARIADNE_PALETTE.infoCyan
    });
    expect(ARIADNE_REPORT_INK).toBe("#9C2630");
    for (const value of Object.values(ARIADNE_PALETTE)) expect(ARIADNE_CSS_VARIABLES).toContain(value);
    expect(ARIADNE_CSS_VARIABLES).toContain(ARIADNE_REPORT_INK);
    expect(ARIADNE_CSS_VARIABLES).toContain("--ariadne-border:var(--ariadne-coral)");
    expect(ARIADNE_CSS_VARIABLES).toContain("--ariadne-focused-border:var(--ariadne-coral)");
  });

  it("maps Clack's legacy semantic colors onto semantic Ariadne roles", () => {
    const output = applyAriadneAnsiTheme("\u001B[36mactive\u001B[39m \u001B[90mrail\u001B[39m \u001B[33mwarning\u001B[39m \u001B[34msecondary\u001B[39m");
    expect(output).toContain("\u001B[38;2;246;69;60mactive");
    expect(output).toContain("\u001B[38;2;246;69;60mrail");
    expect(output).toContain("\u001B[38;2;245;158;11mwarning");
    expect(output).toContain("\u001B[38;2;206;211;220msecondary");
    expect(output).toContain("\u001B[38;2;252;247;248m");
    expect(output).not.toMatch(/\u001B\[(?:33|34|36|90)m/);
    expect(output.endsWith("\u001B[0m")).toBe(true);
  });

  it("scopes the Init writer adapter and restores the original writer", async () => {
    const writes: string[] = [];
    const originalWrite = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as NodeJS.WriteStream["write"];
    const output = { write: originalWrite };

    await withAriadneTerminalTheme(true, async () => {
      output.write("\u001B[33mWarning\u001B[39m");
    }, output);

    expect(writes.join("")).toContain("\u001B[38;2;245;158;11mWarning");
    expect(output.write).toBe(originalWrite);
  });
});
