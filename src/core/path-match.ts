import { minimatch } from "minimatch";

export function normalizeRepositoryPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

export function matchesFilePattern(filePath: string, pattern: string): boolean {
  const normalizedFile = normalizeRepositoryPath(filePath);
  const normalizedPattern = normalizeRepositoryPath(pattern);
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  const options = { dot: true, nocase: caseInsensitive };

  if (normalizedPattern.endsWith("/")) {
    const directory = normalizedPattern.slice(0, -1);
    return normalizedFile.replace(/\/$/, "") === directory || minimatch(normalizedFile, `${normalizedPattern}**`, options);
  }

  if (!normalizedPattern.includes("/")) {
    return minimatch(normalizedFile, normalizedPattern, { ...options, matchBase: true });
  }

  return minimatch(normalizedFile, normalizedPattern, options);
}

export function hasGlobMagic(pattern: string): boolean {
  return /[*?\[\]{}()!+@]/.test(pattern);
}
