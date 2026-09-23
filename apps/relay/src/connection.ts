export type Delivery =
  | Readonly<{
      type: "response";
      status: number;
      headers: Readonly<Record<string, string>>;
      body: string;
    }>
  | Readonly<{ type: "offline" }>;

export type Sink = Readonly<{
  send(message: string): number;
  close(code: number, reason: string): void;
}>;

const OFFLINE: Delivery = { type: "offline" };
const BACKPRESSURE = -1;
const DROPPED = 0;

export const OUTBOX_CAPACITY = 32;

export class Connection {
  private readonly sink: Sink;
  private readonly outbox: string[] = [];
  private readonly spaceWaiters = new Set<() => void>();
  private readonly pending = new Map<string, (delivery: Delivery) => void>();
  private congested = false;
  private released = false;

  constructor(sink: Sink) {
    this.sink = sink;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  deliver(
    message: string,
    requestId: string,
    deadline: number,
  ): Promise<Delivery> {
    if (this.released) return Promise.resolve(OFFLINE);
    return new Promise((resolve) => {
      const settle = (delivery: Delivery): void => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve(delivery);
      };
      const timer = setTimeout(() => settle(OFFLINE), deadline - Date.now());
      this.pending.set(requestId, settle);
      void this.enqueue(message, deadline).then((accepted) => {
        if (!accepted) settle(OFFLINE);
      });
    });
  }

  respond(requestId: string, delivery: Delivery): void {
    this.pending.get(requestId)?.(delivery);
  }

  notify(message: string): void {
    if (this.released || this.outbox.length >= OUTBOX_CAPACITY) return;
    this.outbox.push(message);
    this.flush();
  }

  drained(): void {
    this.congested = false;
    this.flush();
  }

  close(code: number, reason: string): void {
    if (this.released) return;
    this.release();
    this.sink.close(code, reason);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.outbox.length = 0;
    for (const settle of [...this.pending.values()]) settle(OFFLINE);
    this.wakeWaiters();
  }

  private async enqueue(message: string, deadline: number): Promise<boolean> {
    while (!this.released && this.outbox.length >= OUTBOX_CAPACITY)
      if (!(await this.waitForSpace(deadline))) return false;
    if (this.released) return false;
    this.outbox.push(message);
    this.flush();
    return true;
  }

  private waitForSpace(deadline: number): Promise<boolean> {
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.spaceWaiters.delete(wake);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.spaceWaiters.delete(wake);
        resolve(false);
      }, deadline - Date.now());
      this.spaceWaiters.add(wake);
    });
  }

  private flush(): void {
    while (!this.congested && !this.released) {
      const message = this.outbox.shift();
      if (message === undefined) break;
      const result = this.sink.send(message);
      if (result === BACKPRESSURE) this.congested = true;
      if (result === DROPPED) {
        this.release();
        return;
      }
    }
    if (this.outbox.length < OUTBOX_CAPACITY) this.wakeWaiters();
  }

  private wakeWaiters(): void {
    for (const wake of [...this.spaceWaiters]) wake();
  }
}

export type ConnectionRegistry = Readonly<{
  attach(installationId: string, connection: Connection): void;
  detach(installationId: string, connection: Connection): void;
  get(installationId: string): Connection | undefined;
  closeAll(): void;
}>;

export const REPLACED = {
  code: 4000,
  reason: "replaced by a newer connection",
};
export const SHUTDOWN = { code: 1001, reason: "relay shutting down" };

export function inMemoryRegistry(): ConnectionRegistry {
  const connections = new Map<string, Connection>();
  return {
    attach(installationId, connection) {
      const previous = connections.get(installationId);
      connections.set(installationId, connection);
      previous?.close(REPLACED.code, REPLACED.reason);
    },
    detach(installationId, connection) {
      if (connections.get(installationId) === connection)
        connections.delete(installationId);
    },
    get: (installationId) => connections.get(installationId),
    closeAll() {
      for (const connection of connections.values())
        connection.close(SHUTDOWN.code, SHUTDOWN.reason);
      connections.clear();
    },
  };
}
