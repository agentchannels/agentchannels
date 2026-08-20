import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli/program.js";
import type { ExternalActions, PromptIO } from "../src/cli/io.js";
import { ensureProductPaths, resolveProductPaths } from "../src/core/paths.js";
import { Persistence } from "../src/persistence/store.js";
import { RelayManager } from "../src/relay/manager.js";
import type { CredentialStore } from "../src/security/credentials.js";
import { InstallationIdentityService } from "../src/security/identity.js";

const roots: string[] = [];

class MemoryCredentials implements CredentialStore {
  private readonly values = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentchannels-first-run-"));
  roots.push(root);
  const repository = join(root, "repository");
  const home = join(root, "home");
  execFileSync("git", ["init", "--initial-branch", "main", repository], {
    stdio: "ignore",
  });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=AgentChannels Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ],
    { cwd: repository, stdio: "ignore" },
  );
  return { root, repository, home };
}

function enrollmentFetch() {
  const mock = vi.fn(
    async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { installationId: string };
      return new Response(
        JSON.stringify({ installationId: body.installationId }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  );
  return mock as typeof fetch & typeof mock;
}

const noPrompt: PromptIO = {
  async input(label) {
    throw new Error(`unexpected prompt: ${label}`);
  },
  async secret(label) {
    throw new Error(`unexpected secret prompt: ${label}`);
  },
  async confirm(label) {
    throw new Error(`unexpected confirmation: ${label}`);
  },
  async select(label) {
    throw new Error(`unexpected selection: ${label}`);
  },
  async multiSelect(label) {
    throw new Error(`unexpected multi-selection: ${label}`);
  },
};

const artifacts: ExternalActions = {
  async writeArtifact() {},
  async openUrl() {
    throw new Error("machine mode must not open a browser");
  },
  async copyText() {
    throw new Error("machine mode must not use the clipboard");
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("hosted and self-hosted first run", () => {
  it("uses the hosted Relay without a Relay prompt and resumes one durable setup", async () => {
    const f = fixture();
    const credentials = new MemoryCredentials();
    const relayFetch = enrollmentFetch();
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const program = createProgram({
      credentialStore: credentials,
      relayFetch,
      prompt: noPrompt,
      external: artifacts,
      interactive: false,
    });
    await program.parseAsync(
      [
        "--home",
        f.home,
        "--json",
        "init",
        "--cwd",
        f.repository,
        "--connect",
        "slack",
      ],
      { from: "user" },
    );
    expect(relayFetch).toHaveBeenCalledTimes(1);
    expect(String(relayFetch.mock.calls[0]?.[0])).toBe(
      "https://relay.agentchannels.io/v1/installations",
    );
    const result = JSON.parse(String(write.mock.calls.at(-1)?.[0])) as {
      status: string;
      setups: { actionUrl: string; artifactPath: string }[];
    };
    expect(result.status).toBe("action_required");
    expect(result.setups[0]?.actionUrl).toContain("api.slack.com/apps");
    expect(result.setups[0]?.artifactPath).toContain("onboarding");

    await createProgram({
      credentialStore: credentials,
      relayFetch,
      prompt: noPrompt,
      external: artifacts,
      interactive: false,
    }).parseAsync(["--home", f.home, "--json", "init", "--cwd", f.repository], {
      from: "user",
    });
    expect(relayFetch).toHaveBeenCalledTimes(1);
    const store = new Persistence(join(f.home, "agentchannels.db"), {
      backupDirectory: join(f.home, "backups"),
    });
    expect(store.listAgents()).toHaveLength(1);
    expect(store.listAllBindingSetups()).toHaveLength(1);
    store.close();
  });

  it("honors a preselected self-hosted Relay without changing the init flow", async () => {
    const f = fixture();
    const credentials = new MemoryCredentials();
    const relayFetch = enrollmentFetch();
    const paths = resolveProductPaths({ AGENTCHANNELS_HOME: f.home });
    ensureProductPaths(paths);
    const store = new Persistence(paths.database, {
      backupDirectory: paths.backups,
    });
    await new RelayManager({
      store,
      identity: new InstallationIdentityService(credentials),
      fetch: relayFetch,
    }).use({
      origin: "https://relay.example.com",
      enrollmentToken: "request-only-token",
    });
    store.close();
    relayFetch.mockClear();
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await createProgram({
      credentialStore: credentials,
      relayFetch,
      prompt: noPrompt,
      external: artifacts,
      interactive: false,
    }).parseAsync(
      [
        "--home",
        f.home,
        "--json",
        "init",
        "--cwd",
        f.repository,
        "--connect",
        "linear",
      ],
      { from: "user" },
    );
    expect(relayFetch).not.toHaveBeenCalled();
    const result = JSON.parse(String(write.mock.calls.at(-1)?.[0])) as {
      status: string;
      setups: { actionUrl: string }[];
    };
    expect(result.status).toBe("action_required");
    expect(result.setups[0]?.actionUrl).toContain(
      "linear.app/settings/api/applications/new",
    );
  });
});
