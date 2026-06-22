#!/usr/bin/env bash
set -euo pipefail

REPO="/Users/ronitsingh/programming/Ariadne"
TASK_DIR="$REPO/.codex/tasks"
LOG_DIR="$REPO/.codex/logs"
SUMMARY_DIR="$REPO/.codex/summaries"
BASELINE="$REPO/.codex/BASELINE.md"

cd "$REPO"

mkdir -p "$LOG_DIR" "$SUMMARY_DIR"

if ! command -v codex >/dev/null 2>&1; then
  echo "codex command not found"
  exit 1
fi

if [[ ! -f "$BASELINE" ]]; then
  echo "Missing $BASELINE"
  exit 1
fi

for task_file in "$TASK_DIR"/*.md; do
  [[ -e "$task_file" ]] || {
    echo "No task files found in $TASK_DIR"
    exit 0
  }

  task_name="$(basename "$task_file" .md)"
  timestamp="$(date +"%Y%m%d-%H%M%S")"
  log_file="$LOG_DIR/${timestamp}-${task_name}.jsonl"
  summary_file="$SUMMARY_DIR/${timestamp}-${task_name}.md"

  echo ""
  echo "============================================================"
  echo "Running Codex task: $task_name"
  echo "============================================================"

  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Working tree has existing changes. Review/commit/stash before continuing."
    git status --short
    exit 1
  fi

  prompt_file="$(mktemp)"

  cat > "$prompt_file" <<EOF
You are working in the Ariadne repo.

Read this baseline first:

$(cat "$BASELINE")

Now complete this specific task:

$(cat "$task_file")

Hard requirements:
- Keep the change narrowly scoped to this task.
- Add or update tests when behavior changes.
- Run pnpm check before finishing.
- Do not leave failing tests.
- Do not modify unrelated files.
- Do not commit changes.
- End with a concise summary containing:
  1. Files changed
  2. Behavior changed
  3. Tests added/changed
  4. Exact verification command run
EOF

  set +e
  codex exec \
    --cd "$REPO" \
    --sandbox workspace-write \
    --ask-for-approval never \
    --json \
    --output-last-message "$summary_file" \
    - < "$prompt_file" | tee "$log_file"

  codex_status=${PIPESTATUS[0]}
  set -e

  rm -f "$prompt_file"

  echo ""
  echo "Codex exit status: $codex_status"
  echo "Running local verification..."
  pnpm check

  echo ""
  echo "Changed files:"
  git status --short

  echo ""
  echo "Summary written to:"
  echo "$summary_file"

  echo ""
  echo "Review this diff. Then commit/stash/revert before running the next task."
  exit 0
done
