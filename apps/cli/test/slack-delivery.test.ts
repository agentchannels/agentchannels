import { describe, expect, it, vi } from "bun:test";

import { SlackConnector } from "../src/connectors/slack.ts";
import type { DeliveryMessage } from "../src/model.ts";

const CREDENTIALS = { botToken: "xoxb-token" };

function okFetcher(): {
  fetcher: ReturnType<typeof vi.fn>;
  sent: () => Record<string, unknown>;
} {
  let captured: RequestInit | undefined;
  const fetcher = vi.fn(
    (_input: string | URL, init?: RequestInit): Promise<Response> => {
      captured = init;
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    },
  );
  return {
    fetcher,
    sent: () => {
      if (typeof captured?.body !== "string")
        throw new Error("expected a JSON request body");
      return JSON.parse(captured.body) as Record<string, unknown>;
    },
  };
}

function message(overrides: Partial<DeliveryMessage>): DeliveryMessage {
  return {
    kind: "final",
    remoteConversationId: "C123",
    body: "done",
    ...overrides,
  };
}

describe("SlackConnector.deliver", () => {
  it("posts a rendered payload to chat.postMessage", async () => {
    const { fetcher, sent } = okFetcher();
    await new SlackConnector({ fetch: fetcher }).deliver(
      message({ body: "**done**" }),
      CREDENTIALS,
    );
    expect(fetcher).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({ method: "POST" }),
    );
    expect(sent()).toMatchObject({
      channel: "C123",
      unfurl_links: false,
      unfurl_media: false,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "*done*" } }],
    });
  });

  it.each([
    ["the conversation id", "C123:1700.5", {}, "1700.5"],
    ["metadata", "C123", { threadTs: "9.9" }, "9.9"],
  ])(
    "takes the thread timestamp from %s",
    async (_name, conversation, metadata, expected) => {
      const { fetcher, sent } = okFetcher();
      await new SlackConnector({ fetch: fetcher }).deliver(
        message({ remoteConversationId: conversation, metadata }),
        CREDENTIALS,
      );
      expect(sent()).toMatchObject({ channel: "C123", thread_ts: expected });
    },
  );

  it("skips the opening half of a tool call", async () => {
    const { fetcher } = okFetcher();
    await new SlackConnector({ fetch: fetcher }).deliver(
      message({
        kind: "action",
        body: "ls",
        metadata: { action: "Bash", ephemeral: true },
      }),
      CREDENTIALS,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("posts the finished half of a tool call", async () => {
    const { fetcher, sent } = okFetcher();
    await new SlackConnector({ fetch: fetcher }).deliver(
      message({ kind: "action", body: "ls", metadata: { action: "Bash" } }),
      CREDENTIALS,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sent()).toMatchObject({ blocks: [{ type: "context" }] });
  });

  it("ignores a caller supplied block override", async () => {
    const { fetcher, sent } = okFetcher();
    await new SlackConnector({ fetch: fetcher }).deliver(
      message({
        metadata: {
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "raw" } }],
          attachments: [{ text: "raw" }],
        },
      }),
      CREDENTIALS,
    );
    const body = sent();
    expect(body).not.toHaveProperty("attachments");
    expect(body.blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "done" } },
    ]);
  });

  it("reports a rejected payload as a provider failure", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: false, error: "invalid_blocks" }), {
          status: 200,
        }),
      ),
    );
    await expect(
      new SlackConnector({ fetch: fetcher }).deliver(message({}), CREDENTIALS),
    ).rejects.toThrow("invalid_blocks");
  });

  it("refuses to deliver without a bot token", async () => {
    const { fetcher } = okFetcher();
    await expect(
      new SlackConnector({ fetch: fetcher }).deliver(message({}), {}),
    ).rejects.toThrow("Slack Bot Token");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
