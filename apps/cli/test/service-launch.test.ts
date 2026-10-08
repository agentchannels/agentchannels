import { describe, expect, it } from "bun:test";

import { daemonLaunch, isCompiledBinary } from "../src/service/launch.ts";

describe("daemon launch", () => {
  it.each([
    ["/$bunfs/root/agentchannels", true],
    ["B:/~BUN/root/agentchannels.exe", true],
    ["/opt/agentchannels/src/cli.ts", false],
  ])("recognizes %s as compiled: %s", (main, compiled) => {
    expect(isCompiledBinary(main)).toBe(compiled);
  });

  it("runs an explicit entry as the executable itself", () => {
    expect(daemonLaunch("/opt/bin/agentchannels")).toEqual({
      executable: "/opt/bin/agentchannels",
      args: ["daemon"],
    });
  });

  it("runs a source checkout through the runtime with its entrypoint", () => {
    const launch = daemonLaunch();
    expect(launch.args).toEqual([Bun.main, "daemon"]);
    expect(launch.executable).not.toBe("");
  });
});
