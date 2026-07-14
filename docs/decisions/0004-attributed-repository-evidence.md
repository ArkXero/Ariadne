# ADR 0004: Attributed Repository Evidence

Status: accepted

Ariadne compares baseline, post-agent, and post-verification snapshots. Policies evaluate only task-caused unions; unchanged preexisting dirt is reported separately. Git porcelain-v2 provides tracked evidence, while dedicated lstat-based forbidden snapshots cover ignored files and symlink targets without following external targets.
