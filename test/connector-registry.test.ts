import { describe, expect, it } from "vitest";

import { loadConnectorModules } from "../src/connectors/connector.js";

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
});
