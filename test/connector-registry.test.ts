import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { loadConnectorModules } from "../src/connectors/connector.ts";
import { isConnectorType } from "../src/model.ts";
import { connectorTypeSchema } from "../src/relay/protocol.ts";
import { CURRENT_SCHEMA_VERSION } from "../src/store/migrations.ts";
import { Persistence } from "../src/store/store.ts";

describe("connector registry", () => {
  it("discovers provider modules through the shared contract", async () => {
    const modules = await loadConnectorModules();

    expect([...modules.keys()].sort()).toEqual(["linear", "slack"]);
    for (const connector of modules.values()) {
      expect(connector.label).toEqual(expect.any(String));
      expect(connector.credentialFields.length).toBeGreaterThan(0);
      expect(connector.createOnboardingArtifact).toEqual(expect.any(Function));
      expect(connector.verifyCredentials).toEqual(expect.any(Function));
      expect(connector.searchUsers).toEqual(expect.any(Function));
    }
  });

  /**
   * The acceptance criterion for connector extensibility.
   *
   * A provider used to be enumerated in the core type union, three SQLite CHECK
   * constraints, the wire protocol schema, and the Relay - so adding one meant a
   * coordinated release of two components. Every layer below must now accept an
   * identifier it has never seen, from a single new file.
   */
  it("accepts a provider no layer has been told about", async () => {
    // Written into the real connector directory, because "one new file in the
    // repository" is precisely the property under test.
    const added = resolve("src/connectors/zz-acceptance-fixture.ts");
    writeFileSync(
      added,
      `import type { ConnectorModule } from "./connector.ts";

const example = {
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
  verifyCredentials: (credentials: Readonly<Record<string, string>>) =>
    Promise.resolve({
      credentials,
      externalInstallationId: "example-workspace",
      externalInstallationName: "Example Workspace",
    }),
  verifyAndParse: () => ({ ok: true as const }),
  deliver: () => Promise.resolve(),
  searchUsers: () => Promise.resolve([]),
} satisfies ConnectorModule;

export default example;
`,
    );

    try {
      const modules = await loadConnectorModules();
      expect([...modules.keys()].sort()).toEqual([
        "example",
        "linear",
        "slack",
      ]);
    } finally {
      rmSync(added, { force: true });
    }

    // The identifier passes the shared shape check and the wire schema.
    expect(isConnectorType("example")).toBe(true);
    expect(connectorTypeSchema.safeParse("example").success).toBe(true);

    // SQLite accepts a Binding, a setup, and a delivery for it, with no migration.
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
