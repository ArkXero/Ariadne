export async function withWorkflowSignals<T>(run: (signal: AbortSignal) => Promise<T>): Promise<{ value: T; signal?: NodeJS.Signals }> {
  const controller = new AbortController();
  let received: NodeJS.Signals | undefined;
  let count = 0;
  const handler = (signal: NodeJS.Signals) => {
    received = signal;
    count += 1;
    if (count === 1) controller.abort(signal);
    else process.exit(signal === "SIGTERM" ? 143 : 130);
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  try {
    const value = await run(controller.signal);
    return { value, ...(received ? { signal: received } : {}) };
  } finally {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  }
}

