/**
 * Tests for the `ach serve --channel <channel>` flag routing.
 *
 * Verifies that:
 *   - `ach serve`                   → SlackAdapter is instantiated
 *   - `ach serve --channel slack`   → SlackAdapter is instantiated
 *   - `ach serve --channel discord` → DiscordAdapter is instantiated
 *   - `ach serve discord`           → DiscordAdapter is instantiated (subcommand BC)
 *
 * All external dependencies are mocked — no live Slack or Discord API calls.
 * Constructor mocks use regular functions (not arrow functions) so `new` works.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

// ─── Module mocks (hoisted before imports by vitest) ────────────────────────
//
// NOTE: Constructor mocks MUST use `function` keyword or a `class`, NOT arrow
// functions.  Arrow functions lack [[Construct]] and throw "is not a
// constructor" when called via `new`.

vi.mock("../../src/channels/slack/index.js", () => ({
  // eslint-disable-next-line prefer-arrow-callback
  SlackAdapter: vi.fn(function SlackAdapter(this: any) {
    this.name = "slack";
    this.connect = vi.fn().mockResolvedValue(undefined);
    this.disconnect = vi.fn().mockResolvedValue(undefined);
    this.onMessage = vi.fn();
    this.sendMessage = vi.fn().mockResolvedValue(undefined);
    this.startStream = vi.fn().mockResolvedValue(undefined);
    this.setStatus = vi.fn().mockResolvedValue(undefined);
    this.clearStatus = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock("../../src/channels/discord/index.js", () => ({
  // eslint-disable-next-line prefer-arrow-callback
  DiscordAdapter: vi.fn(function DiscordAdapter(this: any) {
    this.name = "discord";
    this.connect = vi.fn().mockResolvedValue(undefined);
    this.disconnect = vi.fn().mockResolvedValue(undefined);
    this.onMessage = vi.fn();
    this.sendMessage = vi.fn().mockResolvedValue(undefined);
    this.startStream = vi.fn().mockResolvedValue(undefined);
    this.setStatus = vi.fn().mockResolvedValue(undefined);
    this.clearStatus = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock("../../src/core/config.js", () => ({
  resolveConfig: vi.fn().mockReturnValue({
    anthropicApiKey: "test-anthropic-key",
    agentId: "agent-test",
    environmentId: "env-test",
    slackBotToken: "xoxb-test",
    slackAppToken: "xapp-test",
    slackSigningSecret: undefined,
    vaultIds: undefined,
  }),
  resolveDiscordConfig: vi.fn().mockReturnValue({
    anthropicApiKey: "test-anthropic-key",
    agentId: "agent-test",
    environmentId: "env-test",
    discordBotToken: "Bot test-discord-token",
    vaultIds: undefined,
  }),
}));

vi.mock("../../src/core/agent-client.js", () => ({
  // eslint-disable-next-line prefer-arrow-callback
  AgentClient: vi.fn(function AgentClient() {}),
}));

vi.mock("../../src/core/session-manager.js", () => ({
  // eslint-disable-next-line prefer-arrow-callback
  SessionManager: vi.fn(function SessionManager() {}),
}));

vi.mock("../../src/core/streaming-bridge.js", () => ({
  // eslint-disable-next-line prefer-arrow-callback
  StreamingBridge: vi.fn(function StreamingBridge(this: any) {
    this.onPhaseChange = vi.fn();
    this.handleMessage = vi.fn().mockResolvedValue({
      success: true,
      totalChars: 5,
      updateCount: 1,
    });
    this.abortAll = vi.fn().mockReturnValue(0);
  }),
}));

// ─── Imports (receive mocked versions due to hoisting) ───────────────────────

import { registerServeCommand } from "../../src/commands/serve.js";
import { SlackAdapter } from "../../src/channels/slack/index.js";
import { DiscordAdapter } from "../../src/channels/discord/index.js";
import { resolveConfig, resolveDiscordConfig } from "../../src/core/config.js";

// ─── Helper ─────────────────────────────────────────────────────────────────

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride(); // prevent process.exit() during tests
  registerServeCommand(program);
  return program;
}

/** Get the adapter instance created by the last `new SlackAdapter()` call. */
function lastSlackInstance(): any {
  return vi.mocked(SlackAdapter).mock.instances[0];
}

/** Get the adapter instance created by the last `new DiscordAdapter()` call. */
function lastDiscordInstance(): any {
  return vi.mocked(DiscordAdapter).mock.instances[0];
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("serve --channel flag routing", () => {
  let processOnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Prevent signal handler accumulation across tests (coordinator review warning)
    processOnSpy = vi.spyOn(process, "on").mockReturnValue(process as NodeJS.Process);
  });

  afterEach(() => {
    processOnSpy.mockRestore();
  });

  // ── Default (no --channel) uses Slack ──────────────────────────────────

  it("instantiates SlackAdapter by default when --channel is omitted", async () => {
    await makeProgram().parseAsync(["serve"], { from: "user" });

    expect(SlackAdapter).toHaveBeenCalledTimes(1);
    expect(DiscordAdapter).not.toHaveBeenCalled();
  });

  it("calls resolveConfig (Slack) by default", async () => {
    await makeProgram().parseAsync(["serve"], { from: "user" });

    expect(resolveConfig).toHaveBeenCalledTimes(1);
    expect(resolveDiscordConfig).not.toHaveBeenCalled();
  });

  // ── Explicit --channel slack uses Slack ────────────────────────────────

  it("instantiates SlackAdapter when --channel slack is passed explicitly", async () => {
    await makeProgram().parseAsync(["serve", "--channel", "slack"], { from: "user" });

    expect(SlackAdapter).toHaveBeenCalledTimes(1);
    expect(DiscordAdapter).not.toHaveBeenCalled();
  });

  it("is case-insensitive: --channel SLACK still routes to SlackAdapter", async () => {
    await makeProgram().parseAsync(["serve", "--channel", "SLACK"], { from: "user" });

    expect(SlackAdapter).toHaveBeenCalledTimes(1);
    expect(DiscordAdapter).not.toHaveBeenCalled();
  });

  // ── --channel discord uses Discord ─────────────────────────────────────

  it("instantiates DiscordAdapter when --channel discord is passed", async () => {
    await makeProgram().parseAsync(["serve", "--channel", "discord"], { from: "user" });

    expect(DiscordAdapter).toHaveBeenCalledTimes(1);
    expect(SlackAdapter).not.toHaveBeenCalled();
  });

  it("calls resolveDiscordConfig when --channel discord is passed", async () => {
    await makeProgram().parseAsync(["serve", "--channel", "discord"], { from: "user" });

    expect(resolveDiscordConfig).toHaveBeenCalledTimes(1);
    expect(resolveConfig).not.toHaveBeenCalled();
  });

  it("is case-insensitive: --channel Discord routes to DiscordAdapter", async () => {
    await makeProgram().parseAsync(["serve", "--channel", "Discord"], { from: "user" });

    expect(DiscordAdapter).toHaveBeenCalledTimes(1);
    expect(SlackAdapter).not.toHaveBeenCalled();
  });

  // ── Token flags are forwarded as overrides ─────────────────────────────

  it("passes --discord-bot-token override to resolveDiscordConfig", async () => {
    await makeProgram().parseAsync(
      ["serve", "--channel", "discord", "--discord-bot-token", "Bot my-explicit-token"],
      { from: "user" },
    );

    expect(resolveDiscordConfig).toHaveBeenCalledWith(
      expect.objectContaining({ discordBotToken: "Bot my-explicit-token" }),
    );
  });

  it("passes --slack-bot-token override to resolveConfig", async () => {
    await makeProgram().parseAsync(
      ["serve", "--slack-bot-token", "xoxb-override"],
      { from: "user" },
    );

    expect(resolveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ slackBotToken: "xoxb-override" }),
    );
  });

  // ── connect() is called on the chosen adapter ──────────────────────────

  it("calls connect() on the SlackAdapter instance (default)", async () => {
    await makeProgram().parseAsync(["serve"], { from: "user" });

    expect(lastSlackInstance().connect).toHaveBeenCalledTimes(1);
  });

  it("calls connect() on the DiscordAdapter instance when --channel discord", async () => {
    await makeProgram().parseAsync(["serve", "--channel", "discord"], { from: "user" });

    expect(lastDiscordInstance().connect).toHaveBeenCalledTimes(1);
  });

  // ── Backward-compatible `ach serve discord` subcommand ─────────────────

  it("subcommand `serve discord` still instantiates DiscordAdapter (backward compat)", async () => {
    await makeProgram().parseAsync(["serve", "discord"], { from: "user" });

    expect(DiscordAdapter).toHaveBeenCalledTimes(1);
    expect(SlackAdapter).not.toHaveBeenCalled();
  });

  it("subcommand `serve discord` calls resolveDiscordConfig", async () => {
    await makeProgram().parseAsync(["serve", "discord"], { from: "user" });

    expect(resolveDiscordConfig).toHaveBeenCalledTimes(1);
    expect(resolveConfig).not.toHaveBeenCalled();
  });

  it("subcommand `serve discord` calls connect() on the DiscordAdapter instance", async () => {
    await makeProgram().parseAsync(["serve", "discord"], { from: "user" });

    expect(lastDiscordInstance().connect).toHaveBeenCalledTimes(1);
  });
});
