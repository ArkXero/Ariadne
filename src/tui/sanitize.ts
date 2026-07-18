import stringWidth from "string-width";
import stripAnsi from "strip-ansi";

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const CARRIAGE_RETURNS = /\r\n?/g;

export function sanitizeTerminalText(value: string): string {
  return stripAnsi(value)
    .replace(CARRIAGE_RETURNS, "\n")
    .replace(CONTROL_CHARACTERS, "")
    .replace(/\t/g, "    ");
}

export function truncateDisplay(value: string, maximumWidth: number): string {
  const safe = sanitizeTerminalText(value).replace(/\n/g, " ");
  if (maximumWidth <= 0) return "";
  if (stringWidth(safe) <= maximumWidth) return safe;
  if (maximumWidth === 1) return "…";
  let result = "";
  for (const character of safe) {
    if (stringWidth(`${result}${character}…`) > maximumWidth) break;
    result += character;
  }
  return `${result}…`;
}

export function wrapHostileLines(value: string, maximumWidth = 240): string {
  return sanitizeTerminalText(value).split("\n").flatMap((line) => {
    if (stringWidth(line) <= maximumWidth) return [line];
    const chunks: string[] = [];
    let chunk = "";
    for (const character of line) {
      if (chunk && stringWidth(`${chunk}${character}`) > maximumWidth) {
        chunks.push(chunk);
        chunk = character;
      } else chunk += character;
    }
    chunks.push(chunk);
    return chunks;
  }).join("\n");
}

