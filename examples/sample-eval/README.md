# Ariadne Sample Eval Suite

This sample is a small local-only eval suite. It uses a deterministic Node agent so users can see pass, verification-fail, forbidden-file, and forbidden-command behavior without external services.

From the repository root:

```sh
pnpm build
cd examples/sample-eval
node ../../dist/cli.js doctor
node ../../dist/cli.js run
node ../../dist/cli.js report
```

Expected result:

- `01-pass-notes` passes.
- `02-fail-verification` fails because `verify.mjs` rejects its output.
- `03-forbidden-file` fails because the agent writes `.env`.
- `04-forbidden-command-log` fails because the agent logs a forbidden command line.

The sample intentionally writes local scratch files. They are ignored by `examples/sample-eval/.gitignore`.
