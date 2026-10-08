import { describe, expect, it } from "bun:test";

import {
  Connection,
  inMemoryRegistry,
  OUTBOX_CAPACITY,
  REPLACED,
  type Sink,
} from "../src/connection.ts";

function recordingSink(sendResult = 1) {
  const sent: string[] = [];
  const closed: { code: number; reason: string }[] = [];
  let result = sendResult;
  const sink: Sink = {
    send: (message) => {
      sent.push(message);
      return result;
    },
    close: (code, reason) => closed.push({ code, reason }),
  };
  return { sink, sent, closed, setResult: (next: number) => (result = next) };
}

const soon = () => Date.now() + 2_000;

describe("Connection", () => {
  it("resolves a delivery with the local response", async () => {
    const { sink, sent } = recordingSink();
    const connection = new Connection(sink);
    const delivery = connection.deliver("frame", "r1", soon());
    expect(sent).toEqual(["frame"]);
    connection.respond("r1", {
      type: "response",
      status: 201,
      headers: {},
      body: "ok",
    });
    expect(await delivery).toMatchObject({ type: "response", status: 201 });
    expect(connection.pendingCount).toBe(0);
  });

  it("settles every pending delivery as offline the moment it closes", async () => {
    const { sink, closed } = recordingSink();
    const connection = new Connection(sink);
    const started = Date.now();
    const first = connection.deliver("a", "r1", soon());
    const second = connection.deliver("b", "r2", soon());
    connection.close(REPLACED.code, REPLACED.reason);
    expect(await Promise.all([first, second])).toEqual([
      { type: "offline" },
      { type: "offline" },
    ]);
    expect(Date.now() - started).toBeLessThan(100);
    expect(closed).toEqual([REPLACED]);
  });

  it("settles as offline when the deadline passes without an answer", async () => {
    const connection = new Connection(recordingSink().sink);
    expect(await connection.deliver("a", "r1", Date.now() + 20)).toEqual({
      type: "offline",
    });
    expect(connection.pendingCount).toBe(0);
  });

  it("holds frames while the socket is congested and flushes them on drain", () => {
    const socket = recordingSink(-1);
    const connection = new Connection(socket.sink);
    void connection.deliver("first", "r1", soon());
    void connection.deliver("second", "r2", soon());
    expect(socket.sent).toEqual(["first"]);
    socket.setResult(1);
    connection.drained();
    expect(socket.sent).toEqual(["first", "second"]);
  });

  it("gives up on a full outbox at the deadline instead of queueing forever", async () => {
    const socket = recordingSink(-1);
    const connection = new Connection(socket.sink);
    void connection.deliver("head", "head", soon());
    for (let index = 0; index < OUTBOX_CAPACITY; index += 1)
      void connection.deliver(
        `queued-${String(index)}`,
        `q${String(index)}`,
        soon(),
      );
    const overflow = connection.deliver(
      "overflow",
      "overflow",
      Date.now() + 30,
    );
    expect(await overflow).toEqual({ type: "offline" });
    expect(socket.sent).toEqual(["head"]);
  });

  it("drops a notification rather than growing a full outbox", () => {
    const socket = recordingSink(-1);
    const connection = new Connection(socket.sink);
    void connection.deliver("head", "head", soon());
    for (let index = 0; index < OUTBOX_CAPACITY + 5; index += 1)
      connection.notify(`note-${String(index)}`);
    socket.setResult(1);
    connection.drained();
    expect(socket.sent).toHaveLength(1 + OUTBOX_CAPACITY);
  });

  it("releases pending deliveries when the socket reports it dropped a frame", async () => {
    const connection = new Connection(recordingSink(0).sink);
    expect(await connection.deliver("a", "r1", soon())).toEqual({
      type: "offline",
    });
  });
});

describe("inMemoryRegistry", () => {
  it("closes the previous connection when an installation reconnects", () => {
    const registry = inMemoryRegistry();
    const first = recordingSink();
    const second = recordingSink();
    const older = new Connection(first.sink);
    const newer = new Connection(second.sink);
    registry.attach("in_a", older);
    registry.attach("in_a", newer);
    expect(first.closed).toEqual([REPLACED]);
    expect(registry.get("in_a")).toBe(newer);
  });

  it("does not let a replaced connection unregister its successor", () => {
    const registry = inMemoryRegistry();
    const older = new Connection(recordingSink().sink);
    const newer = new Connection(recordingSink().sink);
    registry.attach("in_a", older);
    registry.attach("in_a", newer);
    registry.detach("in_a", older);
    expect(registry.get("in_a")).toBe(newer);
    registry.detach("in_a", newer);
    expect(registry.get("in_a")).toBeUndefined();
  });
});
