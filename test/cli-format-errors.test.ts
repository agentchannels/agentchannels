import { describe, expect, it } from "vitest";

import {
  CliError,
  normalizeCliError,
  redactSecrets,
  renderCliError,
} from "../src/cli/errors.js";
import {
  MalformedConnectorCredentialsError,
  ProviderRejectedError,
} from "../src/connectors/connector.js";
import {
  PrivilegedServiceError,
  ServiceManagerError,
  UnsupportedServicePlatformError,
} from "../src/service/guards.js";
import { Persistence } from "../src/persistence/store.js";
import { redactErrorDiagnostic } from "../src/security/redaction.js";
import {
  createTerminalFormatter,
  plainTerminalFormatter,
} from "../src/cli/format.js";
import {
  installationOverview,
  renderOverview,
  type InstallationOverview,
} from "../src/cli/status.js";

describe("CLI terminal formatter", () => {
  it("uses the documented colors only for human TTY output", () => {
    const formatter = createTerminalFormatter({ isTTY: true });
    expect(formatter.colorEnabled).toBe(true);
    expect(formatter.success("connected")).toBe(
      "\u001b[32m✓\u001b[0m connected",
    );
    expect(formatter.pending("paused")).toBe("\u001b[33m!\u001b[0m paused");
    expect(formatter.error("failed")).toBe("\u001b[31mError: failed\u001b[0m");
    expect(formatter.dim("/tmp/id")).toBe("\u001b[2m/tmp/id\u001b[0m");
  });

  it.each([
    { isTTY: false },
    { isTTY: true, noColor: true },
    { isTTY: true, term: "dumb" },
    { isTTY: true, json: true },
  ])("does not color %o", (context) => {
    const formatter = createTerminalFormatter(context);
    expect(formatter.colorEnabled).toBe(false);
    expect(formatter.success("connected")).toBe("✓ connected");
    expect(formatter.error("failed")).toBe("Error: failed");
  });
});

describe("CLI errors", () => {
  it.each([
    ["USAGE_ERROR", 2],
    ["MISSING_GIT_HEAD", 3],
    ["MISSING_AGENT", 4],
    ["MALFORMED_CREDENTIALS", 5],
    ["PROVIDER_REJECTED", 6],
    ["RELAY_UNAVAILABLE", 7],
    ["SERVICE_MANAGER_FAILED", 8],
    ["INPUT_EOF", 9],
    ["CANCELLED", 130],
    ["INTERNAL_ERROR", 1],
  ] as const)("keeps %s at stable exit %i", (code, exitCode) => {
    expect(new CliError(code, "failure", ["Retry the command."])).toMatchObject(
      {
        code,
        exitCode,
      },
    );
  });

  it("uses typed connector boundary errors before fallback classification", () => {
    expect(
      normalizeCliError(
        new MalformedConnectorCredentialsError("Slack credentials are missing"),
      ),
    ).toMatchObject({ code: "MALFORMED_CREDENTIALS", exitCode: 5 });
    expect(
      normalizeCliError(
        new ProviderRejectedError("Slack rejected the credentials"),
      ),
    ).toMatchObject({ code: "PROVIDER_REJECTED", exitCode: 6 });
  });

  it("normalizes typed errors through a cause wrapper", () => {
    const service = new ServiceManagerError(
      "Could not update or start the background daemon.",
      new Error("launchctl bootstrap failed"),
    );
    const wrapped = new Error("setup failed", { cause: service });
    expect(normalizeCliError(wrapped)).toMatchObject({
      code: "SERVICE_MANAGER_FAILED",
      message: "Could not update or start the background daemon.",
      cause: wrapped,
    });
    expect(
      normalizeCliError(new UnsupportedServicePlatformError("win32")),
    ).toMatchObject({
      code: "SERVICE_MANAGER_FAILED",
      nextSteps: ["Run agentchannels daemon in the foreground."],
    });
    expect(normalizeCliError(new PrivilegedServiceError())).toMatchObject({
      code: "SERVICE_MANAGER_FAILED",
      nextSteps: [
        "Run agentchannels daemon install as the current user, without sudo.",
      ],
    });
  });

  it("does not classify arbitrary provider-named failures as expected errors", () => {
    const cause = new Error(
      'Slack SDK internal invariant failed with botToken="sdk-secret"',
    );
    const error = normalizeCliError(cause);
    expect(error.code).toBe("INTERNAL_ERROR");
    const normal = renderCliError(error, {
      json: false,
      debug: false,
      cause,
      formatter: plainTerminalFormatter,
    });
    expect(normal).not.toContain("SDK internal");
    expect(normal).not.toContain("sdk-secret");
  });

  it("renders unknown failures generically while preserving debug diagnostics", () => {
    const cause = new Error("unexpected library detail");
    const error = normalizeCliError(cause);
    expect(error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "AgentChannels hit an unexpected internal error.",
      exitCode: 1,
    });
    expect(
      renderCliError(error, { json: false, debug: false, cause }),
    ).not.toContain("library detail");
    expect(
      renderCliError(error, { json: false, debug: true, cause }),
    ).toContain("unexpected library detail");
  });

  it.each([
    ["credential JSON was malformed", "MALFORMED_CREDENTIALS", 5],
    ["Slack rejected the token", "PROVIDER_REJECTED", 6],
    ["Relay enrollment failed", "RELAY_UNAVAILABLE", 7],
    ["systemctl failed", "SERVICE_MANAGER_FAILED", 8],
    ["input stream reached EOF", "INPUT_EOF", 9],
  ] as const)("maps %s to %s", (message, code, exitCode) => {
    expect(normalizeCliError(new Error(message))).toMatchObject({
      code,
      exitCode,
    });
  });

  it("redacts provider credentials, private keys, and raw bodies", () => {
    const value = redactSecrets(
      [
        "botToken=bot-secret",
        "bearer token=bearer-secret",
        "signingSecret: signing-secret",
        'webhookSecret: "webhook-secret"',
        'clientSecret: "client-secret"',
        'enrollmentToken: "enrollment-secret"',
        'credentials: {"providerField":"credential-object-secret"}',
        '"authorization":"authorization-secret"',
        'rawBody: "private channel body"',
        "xoxb-1234567890-secret",
        "-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----",
      ].join(" "),
    );
    for (const secret of [
      "bot-secret",
      "bearer-secret",
      "signing-secret",
      "webhook-secret",
      "client-secret",
      "enrollment-secret",
      "credential-object-secret",
      "authorization-secret",
      "private channel body",
      "xoxb-1234567890-secret",
      "private material",
    ]) {
      expect(value).not.toContain(secret);
    }
    expect(value).toContain("[redacted]");
  });

  it("redacts modern token formats and request bodies", () => {
    const value = redactSecrets(
      [
        'apiKey="lin_api_secret"',
        'accessToken: "access-secret"',
        "xapp-1-secret",
        'requestBody: "raw-request-secret"',
        'rawBody: {"message":"raw-object-secret"}',
        "-----begin private key-----\nprivate material\n-----end private key-----",
      ].join(" "),
    );
    for (const secret of [
      "lin_api_secret",
      "access-secret",
      "xapp-1-secret",
      "raw-request-secret",
      "raw-object-secret",
      "private material",
    ])
      expect(value).not.toContain(secret);
  });

  it("redacts launchd environment-style API key diagnostics", () => {
    const redacted = redactSecrets(
      "CLIPROXY_API_KEY => sk-syntheticLaunchdSecret123456",
    );
    expect(redacted).toContain("CLIPROXY_API_KEY => [redacted]");
    expect(redacted).not.toContain("syntheticLaunchdSecret");
  });

  it("keeps nested operator diagnostics useful and redacted", () => {
    const inner = new Error(
      "git-lfs filter failed with botToken=xoxb-syntheticNestedSecret",
    );
    const outer = new Error("Could not create worktree", { cause: inner });
    const diagnostic = redactErrorDiagnostic(outer);
    expect(diagnostic).toContain(
      "Could not create worktree <- git-lfs filter failed",
    );
    expect(diagnostic).toContain("botToken=[redacted]");
    expect(diagnostic).not.toContain("syntheticNestedSecret");
  });

  it("renders one human resolution and no Node stack in normal mode", () => {
    const error = new CliError(
      "PROVIDER_REJECTED",
      "Slack rejected credentials",
      [
        "Run agentchannels init to retry this setup.",
        "A second step must not be shown.",
      ],
    );
    const output = renderCliError(error, {
      json: false,
      debug: false,
      formatter: plainTerminalFormatter,
    });
    expect(output).toBe(
      "Error: Slack rejected credentials\nRun agentchannels init to retry this setup.\n",
    );
    expect(output).not.toContain("Next:");
    expect(output).not.toMatch(/\n\s+at /);
  });

  it("hides raw service-manager diagnostics outside debug mode", () => {
    const cause = new Error(
      "Command failed: launchctl bootstrap\nBootstrap failed: 5: Input/output error",
    );
    const serviceFailure = new ServiceManagerError(
      "Could not update or start the background daemon.",
      cause,
    );
    const error = normalizeCliError(serviceFailure);
    const normal = renderCliError(error, {
      json: false,
      debug: false,
      cause: serviceFailure,
    });
    expect(normal).toBe(
      "Error: Could not update or start the background daemon.\nRun agentchannels daemon install --debug to retry with diagnostics.\n",
    );
    expect(normal).not.toContain("launchctl");
    expect(normal).not.toContain("Bootstrap failed");

    const debug = renderCliError(error, {
      json: false,
      debug: true,
      cause: serviceFailure,
    });
    expect(debug).toContain("launchctl bootstrap");
  });

  it("keeps JSON and debug output free of secrets and ANSI", () => {
    const cause = new Error(
      'provider failed with botToken="bot-secret" and rawBody="body-secret"',
    );
    const error = new CliError("INTERNAL_ERROR", "provider failed", [
      "Retry with botToken=resolution-secret.",
    ]);
    const json = renderCliError(error, {
      json: true,
      debug: true,
      cause,
      formatter: createTerminalFormatter({ isTTY: true }),
    });
    expect(json).not.toContain("\u001b[");
    expect(json).not.toContain("bot-secret");
    expect(json).not.toContain("body-secret");
    expect(json).not.toContain("resolution-secret");

    const debug = renderCliError(error, {
      json: false,
      debug: true,
      cause,
      formatter: plainTerminalFormatter,
    });
    expect(debug).not.toContain("bot-secret");
    expect(debug).not.toContain("body-secret");
    expect(debug).toContain("Error: provider failed");
  });

  it("includes a safely redacted cause chain only in explicit JSON debug mode", () => {
    const root = new Error('root botToken="root-secret"');
    const cause = new Error('wrapper rawBody="body-secret"', { cause: root });
    const error = normalizeCliError(cause);
    const normal = JSON.parse(
      renderCliError(error, { json: true, debug: false, cause }),
    ) as { error: Record<string, unknown> };
    expect(normal.error).not.toHaveProperty("diagnostics");
    expect(JSON.stringify(normal)).not.toContain("root-secret");
    const debug = JSON.parse(
      renderCliError(error, { json: true, debug: true, cause }),
    ) as { error: { diagnostics?: string } };
    expect(debug.error.diagnostics).toContain("root");
    expect(debug.error.diagnostics).toContain("wrapper");
    expect(debug.error.diagnostics).not.toContain("root-secret");
    expect(debug.error.diagnostics).not.toContain("body-secret");
  });

  it("renders cancellation as a standalone human message", () => {
    const output = renderCliError(
      new CliError("CANCELLED", "Cancelled.", ["Rerun init."]),
      { json: false, debug: false },
    );
    expect(output).toBe("Cancelled.\n");
  });
});

describe("installation overview rendering", () => {
  it("keeps clean installation discovery successful and points to init", () => {
    const value = installationOverview(undefined, { cwd: "/tmp/project" });
    expect(value.status).toBe("uninitialized");
    expect(value.actionRequired).toBe(true);
    expect(value.nextSteps).toEqual([
      "Run agentchannels init in a Git repository.",
    ]);
    const output = renderOverview(value);
    expect(output).toContain("No Agents configured");
    expect(output).toContain("Run agentchannels init in a Git repository.");
    expect(output).not.toContain("Next:");
  });

  it("does not add an action to a ready overview", () => {
    const value: InstallationOverview = {
      status: "ready",
      actionRequired: false,
      nextSteps: [],
      currentAgentId: null,
      relay: { status: "uninitialized" },
      agents: [],
      bindings: [],
      pendingSetups: [],
      sessions: [],
    };
    const output = renderOverview(value);
    expect(output).not.toContain("Next:");
    expect(output).not.toContain("No action required");
  });

  it("shows one action for a pending overview", () => {
    const value: InstallationOverview = {
      status: "action_required",
      actionRequired: true,
      nextSteps: ["Run agentchannels init to resume Slack setup."],
      currentAgentId: null,
      relay: { status: "configured", mode: "hosted" },
      agents: [],
      bindings: [],
      pendingSetups: [
        {
          connector: "slack",
          step: "admin_action",
          lastError: null,
        } as InstallationOverview["pendingSetups"][number],
      ],
      sessions: [],
    };
    const output = renderOverview(value);
    expect(output).toContain("slack: admin_action");
    expect(output).toContain("Run agentchannels init to resume Slack setup.");
    expect(output).not.toContain("Next:");
  });

  it("redacts persisted provider failures in both overview data and human output", () => {
    const store = new Persistence(":memory:");
    const agent = store.createAgent({ name: "demo", cwd: "/tmp/demo" });
    const setup = store.createBindingSetup({
      agentId: agent.id,
      connector: "slack",
    });
    store.updateBindingSetup(setup.id, {
      lastError: 'provider rejected botToken="persisted-secret"\nraw detail',
    });
    const value = installationOverview(store, { cwd: "/tmp/demo" });
    expect(value.status).toBe("degraded");
    expect(value.pendingSetups[0]?.lastError).toBe(
      "provider rejected botToken=[redacted]",
    );
    const output = renderOverview(value);
    expect(output).not.toContain("persisted-secret");
    expect(output).toContain("provider rejected");
    store.close();
  });

  it("requires Relay and daemon only when a completed Binding needs them", () => {
    const store = new Persistence(":memory:");
    const agent = store.createAgent({ name: "demo", cwd: "/tmp/demo" });
    store.createBinding({
      agentId: agent.id,
      connector: "slack",
      operatorUserId: "U1",
      externalInstallationId: "W1",
    });
    const daemon = {
      platform: "test",
      supported: true,
      installed: false,
      running: false,
      definitionMatches: false,
      definitionPath: "/tmp/service",
    } as const;
    const value = installationOverview(store, { cwd: "/tmp/demo" }, daemon);
    expect(value.status).toBe("action_required");
    expect(value.actionRequired).toBe(true);
    expect(value.nextSteps).toEqual([
      "Run agentchannels init to finish Relay setup.",
    ]);
    const output = renderOverview(value);
    expect(output).toContain("Relay not configured");
    expect(output).toContain("Run agentchannels init to finish Relay setup.");
    expect(output).not.toContain("Run agentchannels daemon install.");
    store.close();
  });
});
