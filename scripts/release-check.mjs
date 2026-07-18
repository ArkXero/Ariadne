import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readlink, rm, symlink } from "node:fs/promises";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ariadne-release-check-"));
const snapshotRoot = path.join(temporaryRoot, "source snapshot");

function run(file, args, cwd, options = {}) {
  const result = spawnSync(file, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...options.env },
    maxBuffer: 50 * 1024 * 1024,
    stdio: options.capture ? "pipe" : "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stdout}\n${result.stderr}` : "";
    throw new Error(`${file} ${args.join(" ")} failed (${result.status ?? result.signal}).${detail}`);
  }
  return result;
}

async function copyOwnedFiles() {
  const listed = run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], sourceRoot, { capture: true });
  const files = listed.stdout.split("\0").filter(Boolean);
  if (files.length === 0) throw new Error("Git did not report any repository-owned files.");
  for (const relative of files) {
    const source = path.resolve(sourceRoot, relative);
    const target = path.resolve(snapshotRoot, relative);
    const contained = path.relative(snapshotRoot, target);
    if (contained.startsWith("..") || path.isAbsolute(contained)) throw new Error(`Refusing to copy path outside the snapshot: ${relative}`);
    await mkdir(path.dirname(target), { recursive: true });
    const sourceStat = await lstat(source);
    if (sourceStat.isSymbolicLink()) {
      await symlink(await readlink(source), target);
    } else if (sourceStat.isFile()) {
      await copyFile(source, target);
      await chmod(target, sourceStat.mode);
    } else {
      throw new Error(`Unsupported repository entry in release snapshot: ${relative}`);
    }
  }
  return files.length;
}

try {
  const fileCount = await copyOwnedFiles();
  run("git", ["init", "--quiet"], snapshotRoot);
  run("git", ["config", "user.name", "Ariadne Release Check"], snapshotRoot);
  run("git", ["config", "user.email", "release-check@example.test"], snapshotRoot);
  run("git", ["add", "--all"], snapshotRoot);
  run("git", ["commit", "--quiet", "-m", "release-check snapshot"], snapshotRoot);

  process.stdout.write(`Release snapshot: ${fileCount} repository-owned files in ${snapshotRoot}\n`);
  run("pnpm", ["install", "--frozen-lockfile"], snapshotRoot);
  run("pnpm", ["check"], snapshotRoot);
  run("pnpm", ["check"], snapshotRoot);
  run("pnpm", ["release:profile"], snapshotRoot);
  run("pnpm", ["audit", "--prod"], snapshotRoot);
  run("npm", ["pack", "--dry-run", "--json"], snapshotRoot);
  run("git", ["diff", "--check"], snapshotRoot);

  const status = run("git", ["status", "--porcelain=v1", "--untracked-files=all"], snapshotRoot, { capture: true }).stdout.trim();
  if (status) throw new Error(`Release verification changed repository-owned files:\n${status}`);
  process.stdout.write("release check ok: frozen install, two full gates, resource profile, production audit, package dry run, and clean snapshot\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
