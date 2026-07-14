import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "fs-extra";

let cachedVersion: string | undefined;

export async function getAriadneVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion;
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const packagePath = path.resolve(moduleDirectory, "..", "..", "package.json");
  const packageJson = await fs.readJson(packagePath) as { version?: unknown };
  cachedVersion = typeof packageJson.version === "string" ? packageJson.version : "0.0.0-unknown";
  return cachedVersion;
}

