import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile, readdir, stat } from "node:fs/promises";
import { parse } from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(file, args) {
  const windowsShim = process.platform === "win32" && (["npm", "pnpm", "corepack"].includes(file) || /\.(?:cmd|bat)$/i.test(file));
  const executable = windowsShim && /\s/.test(file) ? `"${file}"` : file;
  const result = spawnSync(executable, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 20 * 1024 * 1024,
    shell: windowsShim
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${file} ${args.join(" ")} failed (${result.status ?? result.signal}).\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(target));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(target);
  }
  return files;
}

async function validateMarkdown(files) {
  let yamlBlocks = 0;
  let localLinks = 0;
  for (const file of files) {
    const contents = await readFile(file, "utf8");
    for (const match of contents.matchAll(/```ya?ml\s*\n([\s\S]*?)```/gi)) {
      yamlBlocks += 1;
      try {
        parse(match[1]);
      } catch (error) {
        throw new Error(`${path.relative(repoRoot, file)} contains invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const match of contents.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const raw = match[1].trim().replace(/^<|>$/g, "");
      if (!raw || raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
      const relative = decodeURIComponent(raw.split("#", 1)[0].split("?", 1)[0]);
      if (!relative) continue;
      const target = path.resolve(path.dirname(file), relative);
      const fromRoot = path.relative(repoRoot, target);
      assert(fromRoot !== "" && !fromRoot.startsWith("..") && !path.isAbsolute(fromRoot), `${path.relative(repoRoot, file)} links outside the repository: ${raw}`);
      await stat(target).catch(() => {
        throw new Error(`${path.relative(repoRoot, file)} has a broken local link: ${raw}`);
      });
      localLinks += 1;
    }
  }
  return { yamlBlocks, localLinks };
}

const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
assert(packageJson.name === "@arkxronts/ariadne", "Unexpected package name.");
assert(packageJson.version === "0.1.0", "Release hardening must not change the package version.");
assert(packageJson.license === "Apache-2.0", "package.json must match the shipped Apache-2.0 license.");
assert(packageJson.engines?.node === ">=20", "The supported Node engine must remain explicit.");
assert(packageJson.bin?.ariadne === "dist/cli.js", "The ariadne binary must target dist/cli.js.");
assert(Array.isArray(packageJson.files) && ["dist", "README.md", "LICENSE"].every((entry) => packageJson.files.includes(entry)), "The package files allowlist is incomplete.");
assert(packageJson.main === undefined && packageJson.exports === undefined, "Ariadne is CLI-only and must not advertise a nonexistent library entrypoint.");
assert(packageJson.author !== "", "Empty author metadata is misleading; omit it until a value is chosen.");
assert(packageJson.packageManager === "pnpm@10.34.1", "The development package-manager version must remain pinned.");
assert(packageJson.repository?.type === "git" && packageJson.repository.url === "git+https://github.com/ArkXero/Ariadne.git", "Repository metadata must identify the canonical Git repository.");
assert(packageJson.bugs?.url === "https://github.com/ArkXero/Ariadne/issues", "Issue metadata must identify the canonical issue tracker.");
assert(packageJson.homepage === "https://github.com/ArkXero/Ariadne#readme", "Homepage metadata must identify the canonical README.");
assert(packageJson.publishConfig?.access === "public", "The scoped CLI package must remain publicly installable.");
assert(["ai", "cli", "coding-agents", "evaluation", "reliability"].every((keyword) => packageJson.keywords?.includes(keyword)), "Package keywords no longer describe the CLI's supported use case.");

const license = await readFile(path.join(repoRoot, "LICENSE"), "utf8");
assert(license.includes("Apache License") && license.includes("Version 2.0"), "The shipped license is not Apache-2.0.");

const cli = await readFile(path.join(repoRoot, "dist", "cli.js"), "utf8");
assert(cli.startsWith("#!/usr/bin/env node"), "Built CLI is missing its Node shebang.");
assert(run(process.execPath, [path.join(repoRoot, "dist", "cli.js"), "--version"]).stdout.trim() === packageJson.version, "CLI and package versions disagree.");

const packed = run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"]);
const metadata = JSON.parse(packed.stdout)[0];
assert(metadata?.filename && Array.isArray(metadata.files), "npm pack did not return file metadata.");
const names = metadata.files.map((file) => file.path).sort();
for (const required of ["LICENSE", "README.md", "dist/cli.js", "package.json"]) {
  assert(names.includes(required), `Packed package is missing ${required}.`);
}
const unexpected = names.filter((name) => !["LICENSE", "README.md", "package.json"].includes(name) && !name.startsWith("dist/"));
assert(unexpected.length === 0, `Packed package contains unexpected files: ${unexpected.join(", ")}`);
const unsafe = names.filter((name) => /(^|\/)(?:\.env(?:\.|$)|\.ariadne|node_modules|coverage|screenshots?|logs?|\.DS_Store)(?:\/|$)|\.tgz$/i.test(name));
assert(unsafe.length === 0, `Packed package contains unsafe artifacts: ${unsafe.join(", ")}`);
assert(metadata.entryCount === names.length, "npm pack entry count contradicts the file list.");

const requiredDocuments = [
  "README.md",
  "TESTING.md",
  "CHANGELOG.md",
  "docs/releasing.md",
  "docs/release-test-matrix.md",
  "docs/known-limitations.md",
  "docs/supported-environments.md"
];
for (const document of requiredDocuments) await stat(path.join(repoRoot, document));
const documentation = [...requiredDocuments.slice(0, 3).map((file) => path.join(repoRoot, file)), ...await markdownFiles(path.join(repoRoot, "docs")), ...await markdownFiles(path.join(repoRoot, "examples"))];
const markdown = await validateMarkdown([...new Set(documentation)]);

process.stdout.write(`release contract ok: ${packageJson.name}@${packageJson.version}; ${names.length} packed files; ${metadata.size} bytes packed; ${metadata.unpackedSize} bytes unpacked; ${markdown.localLinks} local links; ${markdown.yamlBlocks} YAML blocks\n`);
