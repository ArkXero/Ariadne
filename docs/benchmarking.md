# Professional Benchmarking

Professional benchmarking is an advanced, CLI-only workflow for evaluators and developers comparing coding models. It is intentionally absent from basic Ariadne onboarding and from the TUI. Ordinary `ariadne run` never invokes a judge or incurs judge-model cost.

## Command and ownership

```sh
ariadne benchmark <task-id>
ariadne benchmark <task-id> --json
```

The first release accepts exactly one selected benchmark task. Its declared dependency closure still uses Ariadne's existing planner, retries, shared/worktree isolation, preparation, verification, trace capture, and policy scoring. The final selected-task attempt is judged once after execution. Preparation, interruption, internal failure, and missing candidate evidence are unscored because Ariadne cannot guarantee usable evidence.

Local `ariadne.yml` owns the candidate and judge processes. Model labels are user-declared provenance strings; Ariadne records them but does not query a provider or claim to verify them.

```yaml
version: 5

agent:
  command:
    kind: exec
    file: codex
    args: [exec, --sandbox, workspace-write, "-"]
  timeout_ms: 600000
  model_label: gpt-5.6-sol

benchmarking:
  judge:
    command:
      kind: exec
      file: claude
      args: [--print]
    model_label: claude-fable
    timeout_ms: 600000
  blind_candidate_identity: true
```

Judge configuration and the candidate model label are validated before the candidate process starts. The judge is launched as a fresh Ariadne-owned process after candidate execution and receives one JSON packet through stdin.

## Portable task contract

The task owns benchmark semantics so the task/rubric can travel without owning local model commands:

```yaml
id: cli-quality
name: TypeScript CLI quality
prompt: Improve the CLI implementation and keep its public behavior stable.

benchmark:
  version: 1
  id: typescript-cli-quality
  rubric:
    0: No usable implementation.
    10: Minimal evidence with fundamental breakage.
    20: A partial attempt with severe correctness gaps.
    30: Some relevant behavior works, but core requirements fail.
    40: Material progress with major missing or unsafe behavior.
    50: Half-complete implementation with mixed verification evidence.
    60: Mostly correct implementation with important quality gaps.
    70: Solid implementation with limited correctness or maintainability gaps.
    80: Strong, well-tested implementation with minor gaps.
    90: Production-quality implementation with only negligible weaknesses.
    100: Complete, robust, maintainable implementation with compelling evidence.
  context_files:
    - README.md
    - AGENTS.md
  failure_policy:
    agent_failed: zero
    verification_failed: zero
    timeout: {cap: 20}
    policy_failed: disqualify
```

All eleven anchors (`0, 10, …, 100`) are required, non-empty, and exclusive; unknown or missing anchors fail task loading. Every failure-policy outcome is required. Actions are `zero`, `keep`, `disqualify`, or `{cap: <0..100>}`. A disqualification has no effective numeric score. User-authored rubric wording and failure policy are authoritative and override any Ariadne recommendation.

## Judge packet and trust boundary

The packet contains:

- the original task prompt and complete rubric;
- a bounded final text diff;
- complete contents of included changed text files;
- complete contents of explicit `context_files`;
- verification status/output previews and structured policy evidence;
- benchmark, context, and packet SHA-256 fingerprints.

The packet excludes agent conversation/reasoning, intermediate attempts, self-assessment, and—when blind judging is enabled—the candidate model label. It also excludes configured forbidden paths, high-confidence secret-like paths, binary files, files over 256 KiB, content beyond the 1 MiB packet file budget, diffs over 512 KiB, symlinks, non-files, missing files, and paths that escape the project root. Omissions and reasons are recorded.

Candidate code, diffs, filenames, logs, and comments are explicitly labeled as quoted untrusted evidence. Instructions embedded in them do not change the judging protocol. Ariadne's process isolation is still not an operating-system sandbox; a locally configured judge command has the permissions of its user account.

## Strict response protocol

The judge must write exactly one JSON object to stdout:

```json
{
  "score": 67,
  "lower_anchor": 60,
  "upper_anchor": 70,
  "reason": "The implementation is solid but misses two edge cases.",
  "evidence": ["The parser tests cover valid and malformed input."]
}
```

Scores are integers from 0 through 100. A score at an anchor must repeat that anchor as both bounds; a between-anchor score must name its immediately adjacent lower and upper anchors. Extra keys, Markdown fences, empty explanations/evidence, malformed JSON, contradictory intervals, spawn failure, nonzero exit, timeout, and oversized output are explicit benchmark failures.

## Results, policy, and exit behavior

Execution and policy remain separate from benchmark scoring:

```text
Execution outcome:   verification_failed
Policy score:        100
Benchmark raw score: 74
Failure policy:      zero
Effective score:     0
Qualification:       qualified
Candidate model:     gpt-5.6-sol
Judge model:         claude-fable
```

Run record v5 and batch record v3 preserve the raw score, effective score or disqualification, qualification, labels, fingerprints, judge explanation/evidence, packet omissions, and judge process artifacts. Terminal, JSON, and HTML distinguish policy score from benchmark scores.

Existing execution exits retain priority: agent `10`, timeout `11`, verification `12`, policy `13`, preparation `14`, interruption `130/143`, and internal/persistence `70`. Judge/protocol failure exits `16` only when candidate execution would otherwise exit `0`; it never rewrites the execution outcome.

## Rubric practice

- Describe observable implementation quality and evidence at every anchor, not model style or reputation.
- Make neighboring anchors meaningfully distinct and keep `50` a genuine midpoint rather than a vague failure bucket.
- State safety, correctness, testing, compatibility, and maintainability expectations where they matter.
- Keep task requirements out of hidden judge prompts; portable semantics belong in the task and rubric.
- Review raw and effective scores together. Failure policy is a qualification/scoring rule, not a replacement for execution evidence.
- Use blind candidate identity when model-name knowledge could bias scoring, and retain labels outside the packet for provenance.

## Future public benchmark format

The versioned task contract, provenance labels, fingerprints, strict response, and separated raw/effective scoring are intended as foundations for shareable benchmark bundles. This release does not publish, download, sign, rank, host, or certify benchmarks. A future public format can define bundle manifests, fixture acquisition, licensing, reproducibility metadata, and result exchange without changing the local ownership rule: portable tasks own semantics, while each evaluator's local configuration owns model execution.
