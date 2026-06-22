import { readFile } from "node:fs/promises";

const taskId = process.env.ARIADNE_TASK_ID ?? "unknown";

if (taskId === "01-pass-notes") {
  const notes = await readFile("NOTES.md", "utf8");
  if (!notes.includes("VERIFICATION_OK")) {
    console.error("NOTES.md missing VERIFICATION_OK");
    process.exit(1);
  }
}

if (taskId === "02-fail-verification") {
  const broken = await readFile("BROKEN.md", "utf8");
  if (!broken.includes("VERIFICATION_OK")) {
    console.error("BROKEN.md missing VERIFICATION_OK");
    process.exit(1);
  }
}
