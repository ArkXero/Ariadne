import { InvalidArgumentError } from "commander";
import { render } from "ink";
import { AriadneTui } from "../tui/app.js";
import { AriadneTuiService } from "../tui/services.js";
import { createTerminalSession, supportsTuiColor, supportsUnicodeTerminal } from "../tui/terminal.js";
import type { TuiDataService } from "../tui/types.js";

export interface TuiCommandOptions {
  cwd: string;
  verbose?: boolean;
  color?: boolean;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  service?: TuiDataService;
  signalTarget?: Pick<NodeJS.Process, "once" | "off">;
  environment?: NodeJS.ProcessEnv;
  setExitCode?: (code: number) => void;
  renderTui?: typeof render;
}

export async function tuiCommand(options: TuiCommandOptions): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    throw new InvalidArgumentError("ariadne tui requires interactive stdin/stdout with raw-mode support.");
  }
  const environment = options.environment ?? process.env;
  const terminal = createTerminalSession(stdout);
  const signalTarget = options.signalTarget ?? process;
  const service = options.service ?? new AriadneTuiService(options.cwd);
  let signalCode: number | undefined;
  let signalFinalization: Promise<void> | undefined;
  let detachedActive = false;
  let renderFailure: unknown;
  let instance: ReturnType<typeof render> | undefined;
  const waitLimit = async (): Promise<number> => service.cancellationTimeoutMs?.().catch(() => 30_000) ?? 30_000;
  const settleOrTimeout = async (completion: Promise<unknown>, timeoutMs: number): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      completion.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })
    ]);
    if (timer) clearTimeout(timer);
  };
  let signalCount = 0;
  const stopFor = (code: number) => () => {
    signalCode ??= code;
    signalCount += 1;
    if (signalCount > 1) {
      instance?.unmount();
      return;
    }
    const active = service.registry?.current();
    if (!active || active.latestSnapshot().state === "completed") {
      instance?.unmount();
      return;
    }
    signalFinalization = (async () => {
      const timeoutMs = await waitLimit();
      await settleOrTimeout(active.requestCancellation(code === 143 ? "SIGTERM requested workflow cancellation." : "SIGINT requested workflow cancellation."), timeoutMs);
      instance?.unmount();
    })();
  };
  const onSigint = stopFor(130);
  const onSigterm = stopFor(143);
  terminal.enter();
  signalTarget.once("SIGINT", onSigint);
  signalTarget.once("SIGTERM", onSigterm);
  try {
    const color = supportsTuiColor(stdout, options.color, environment);
    const unicode = supportsUnicodeTerminal(environment);
    instance = (options.renderTui ?? render)(
      <AriadneTui
        service={service}
        color={color}
        unicode={unicode}
        verbose={options.verbose}
        onDetachActive={() => { detachedActive = true; }}
      />,
      { stdin, stdout, stderr, exitOnCtrlC: false, patchConsole: false, maxFps: 10 }
    );
    try {
      await instance.waitUntilExit();
    } catch (error) {
      renderFailure = error;
      detachedActive = Boolean(service.registry?.current() && service.registry.current()!.latestSnapshot().state !== "completed");
    }
  } finally {
    instance?.cleanup();
    terminal.restore();
  }
  if (detachedActive) await service.registry?.waitForIdle();
  if (signalFinalization) await signalFinalization;
  signalTarget.off("SIGINT", onSigint);
  signalTarget.off("SIGTERM", onSigterm);
  if (signalCode !== undefined) (options.setExitCode ?? ((code: number) => { process.exitCode = code; }))(signalCode);
  if (renderFailure) throw renderFailure;
}
