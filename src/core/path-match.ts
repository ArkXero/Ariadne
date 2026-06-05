import { minimatch } from "minimatch";

export function matchesFilePattern(filePath: string, pattern: string): boolean {
  const normalizedFile = filePath.replace(/\\/g, "/");
  const normalizedPattern = pattern.replace(/\\/g, "/");

  return normalizedFile === normalizedPattern
    || minimatch(normalizedFile, normalizedPattern, { dot: true })
    || minimatch(normalizedFile, `**/${normalizedPattern}`, { dot: true });
}

export function hasGlobMagic(pattern: string): boolean {
  return /[*?[\]{}()!+@]/.test(pattern);
}
