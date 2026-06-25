import { writeFile } from "node:fs/promises";

async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

const prompt = await readStdin();
const taskId = process.env.ARIADNE_TASK_ID ?? "unknown";

if (taskId === "01-pass-notes") {
  await writeFile("NOTES.md", `VERIFICATION_OK\n\n${prompt}`);
} else if (taskId === "02-fail-verification") {
  await writeFile("BROKEN.md", `Missing required marker.\n\n${prompt}`);
} else if (taskId === "03-forbidden-file") {
  await writeFile(".env", "SAMPLE_ONLY=not-a-secret\n");
} else if (taskId === "04-forbidden-command-log") {
  console.log("rm -rf dist");
  await writeFile("COMMAND_LOG.md", "Logged forbidden command text without executing it.\n");
} else {
  await writeFile("NOTES.md", prompt);
}
