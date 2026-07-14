# Known Limitations

## Execution and isolation

- Tasks run serially in the canonical invocation working tree. Mutations from one task remain visible to later tasks.
- Ariadne does not isolate the filesystem, network, credentials, environment, or operating-system capabilities of an agent. It is not a sandbox.
- Direct v2 process specs preserve argument boundaries, but they do not make the invoked program safe.

## Process visibility and cleanup

- Ariadne knows the configured agent and verification processes it launches. Command-like stdout/stderr is only reported evidence, not proof that another command executed.
- Ariadne does not audit syscalls, subprocess creation, network activity, terminal replay, or commands hidden inside another program.
- On POSIX, timeout/interruption cleanup targets the launched process group with TERM and then KILL and checks whether that group remains visible. A descendant that creates a different session or process group can escape.
- On Windows, `taskkill /T` and `/F` are best-effort. A successful `taskkill` exit does not prove every descendant stopped.
- A second SIGINT/SIGTERM exits immediately, so the final persistence attempt can be bypassed by deliberate escalation.

## Filesystem and Git evidence

- Git snapshots describe the canonical invocation subtree, not arbitrary files elsewhere on the machine.
- Ignored paths may be represented by Git as aggregate directory entries. Dedicated forbidden-file checks inspect configured matching paths, but Ariadne does not inventory every ignored file by default.
- Symlink evidence fingerprints the link target string without following external targets. It does not inspect changes made through an external target.
- Non-Git execution cannot provide changed-file or diff-line attribution.

## Output and secrets

- Artifact files contain bytes captured from stdout/stderr pipes; output redirected elsewhere or emitted after descriptors detach is not captured.
- Manifests keep bounded head/tail previews, so command-like text in an omitted middle section is not available as reported evidence.
- Common credential-looking command arguments are redacted best-effort. Prompts, task metadata, filenames, diffs, and process output can still contain secrets. Ariadne is not a secrets vault.

## Historical records

- Legacy v1 records remain readable, but lifecycle and attribution that were never recorded are labeled unavailable rather than reconstructed.
- Abandonment detection only identifies a dead PID on the same host; it does not prove why a run stopped or reconcile its filesystem mutations.
