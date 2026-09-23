import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";

import type { ConnectorModule } from "../src/connectors/connector.ts";
import {
  connectorModules,
  connectorRegistry,
} from "../src/connectors/registry.ts";
import { isConnectorType } from "../src/model.ts";
import { connectorTypeSchema } from "@agentchannels/protocol";
import { CURRENT_SCHEMA_VERSION } from "../src/store/migrations.ts";
import { Persistence } from "../src/store/store.ts";

describe("connector registry", () => {
  it("registers every provider module through the shared contract", () => {
    const modules = connectorModules;

    expect([...modules.keys()].sort()).toEqual(["linear", "slack"]);
    for (const connector of modules.values()) {
      expect(connector.label).toEqual(expect.any(String));
      expect(connector.credentialFields.length).toBeGreaterThan(0);
      expect(connector.createOnboardingArtifact).toEqual(expect.any(Function));
      expect(connector.verifyCredentials).toEqual(expect.any(Function));
      expect(connector.searchUsers).toEqual(expect.any(Function));
    }
  });

  it("accepts a provider no layer has been told about", () => {
    const example: ConnectorModule = {
      type: "example",
      label: "Example",
      credentialFields: [{ key: "token", label: "Example Token" }],
      createOnboardingArtifact: () => ({
        filename: "example.json",
        content: "{}",
        copyToClipboard: false,
        actionUrl: "https://example.invalid/apps/new",
        instructions: ["Create the application."],
      }),
      verifyCredentials: (credentials) =>
        Promise.resolve({
          credentials,
          externalInstallationId: "example-workspace",
          externalInstallationName: "Example Workspace",
        }),
      verifyAndParse: () => ({ ok: true }),
      deliver: () => Promise.resolve(),
      searchUsers: () => Promise.resolve([]),
    };

    const registry = connectorRegistry([...connectorModules.values(), example]);
    expect([...registry.keys()].sort()).toEqual(["example", "linear", "slack"]);

    expect(isConnectorType("example")).toBe(true);
    expect(connectorTypeSchema.safeParse("example").success).toBe(true);

    const store = new Persistence(":memory:");
    try {
      const agent = store.createAgent({
        name: "Example",
        cwd: resolve("."),
        runtime: "example-runtime",
      });
      const binding = store.createBinding({
        agentId: agent.id,
        connector: "example",
        operatorUserId: "operator",
        externalInstallationId: "example-workspace",
      });
      store.createBindingSetup({ agentId: agent.id, connector: "example2" });
      store.enqueueDelivery({
        connector: "example",
        remoteConversationId: "thread",
        kind: "progress",
        body: "hello",
        metadata: { bindingId: binding.id },
      });
      expect(store.getAgent(agent.id)?.runtime).toBe("example-runtime");
      expect(store.listAllBindings()[0]?.connector).toBe("example");
      expect(store.claimDueDeliveries(1)[0]?.connector).toBe("example");
    } finally {
      store.close();
    }
  });

  it("refuses two modules that claim the same identifier", () => {
    const [first] = connectorModules.values();
    if (first === undefined) throw new Error("expected a registered connector");
    expect(() => connectorRegistry([first, first])).toThrow(
      `Duplicate connector module ${first.type}.`,
    );
  });

  it("rejects identifiers that are unsafe as a route segment", () => {
    for (const value of [
      "",
      "Slack",
      "1slack",
      "sl ack",
      "sl/ack",
      "a".repeat(33),
    ]) {
      expect(isConnectorType(value), value).toBe(false);
      expect(connectorTypeSchema.safeParse(value).success, value).toBe(false);
    }
  });

  it("keeps the schema version aligned with the open identifier migration", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(4);
  });
});
