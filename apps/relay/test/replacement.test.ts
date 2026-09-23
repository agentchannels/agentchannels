import { afterEach, expect, it } from "bun:test";

import {
  authenticated,
  cleanupDirectories,
  createInstallation,
  enroll,
  startRelay,
} from "./harness.ts";

afterEach(cleanupDirectories);

it("closes the replaced socket so one installation has one live connection", async () => {
  const relay = await startRelay();
  try {
    const installation = createInstallation();
    await enroll(relay, installation);
    const first = await authenticated(relay, installation);
    const second = await authenticated(relay, installation);
    await first.closed;
    expect(first.socket.readyState).toBe(WebSocket.CLOSED);
    expect(second.socket.readyState).toBe(WebSocket.OPEN);
    second.close();
  } finally {
    await relay.stop();
  }
});
