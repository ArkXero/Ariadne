import path from "node:path";
import fs from "fs-extra";

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function canonicalizePath(candidate: string): Promise<string> {
  const absolute = path.resolve(candidate);
  const suffix: string[] = [];
  let ancestor = absolute;
  while (!(await fs.pathExists(ancestor))) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  const canonicalAncestor = await fs.realpath(ancestor).catch(() => ancestor);
  return path.join(canonicalAncestor, ...suffix);
}
