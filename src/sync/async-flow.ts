/** Serializes bootstrap, settings and deep-link enrollment for one local Vault. */
export class SingleFlight {
  private active?: { key: string; promise: Promise<void> };
  get busy(): boolean { return this.active !== undefined; }
  run(key: string, operation: () => Promise<void>): Promise<void> {
    if (this.active) return this.active.key === key ? this.active.promise : Promise.reject(new Error('另一个连接正在处理中，请等待完成后重试'));
    // Establish the gate before user code can yield or reenter the flow.
    const promise = Promise.resolve().then(operation).finally(() => { if (this.active?.promise === promise) this.active = undefined; });
    this.active = { key, promise }; return promise;
  }
}

export class DeadlineError extends Error {
  constructor(message: string) { super(message); this.name = 'DeadlineError'; }
}

/** Bounds waiting without claiming that the native request was aborted.
 * Late resolution/rejection is consumed by Promise.race and cannot resume the
 * caller's timed-out await; callers must keep mutations after that await. */
export function withDeadline<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeadlineError(message)), timeoutMs); });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}
