import { describe, expect, it } from "bun:test";

import type { DeliveryMessage } from "../src/model.ts";
import {
  decodeInteractionEnvelope,
  interactionEnvelope,
  renderSlackMessage,
  SLACK_LIMITS,
} from "../src/connectors/slack-blocks.ts";

const INTERACTION_ID = `ix_${"a".repeat(32)}`;

function message(overrides: Partial<DeliveryMessage>): DeliveryMessage {
  return {
    kind: "final",
    remoteConversationId: "C123",
    body: "done",
    ...overrides,
  };
}

function blocksOfType(
  payload: ReturnType<typeof renderSlackMessage>,
  type: string,
): Record<string, unknown>[] {
  return (payload.blocks ?? []).filter(
    (block) => block.type === type,
  ) as Record<string, unknown>[];
}

function sectionTexts(
  payload: ReturnType<typeof renderSlackMessage>,
): string[] {
  return blocksOfType(payload, "section").map(
    (block) => (block.text as { text: string }).text,
  );
}

function elementsOf(
  block: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  return Array.isArray(block?.elements)
    ? (block.elements as Record<string, unknown>[])
    : [];
}

function firstElement(
  payload: ReturnType<typeof renderSlackMessage>,
  type: string,
): Record<string, unknown> {
  return elementsOf(blocksOfType(payload, type)[0])[0] ?? {};
}

function textOf(node: Record<string, unknown>): string {
  const text = node.text;
  if (typeof text === "string") return text;
  return typeof text === "object" && text !== null && "text" in text
    ? String((text as { text: unknown }).text)
    : "";
}

function optionValuesOf(node: Record<string, unknown>): string[] {
  return Array.isArray(node.options)
    ? (node.options as { value: string }[]).map((option) => option.value)
    : [];
}

function questionMessage(
  options: readonly Record<string, unknown>[],
  multiSelect = false,
): DeliveryMessage {
  return message({
    kind: "question",
    body: "pick one",
    metadata: {
      interactionId: INTERACTION_ID,
      questions: [{ question: "Which?", options, multiSelect }],
    },
  });
}

describe("renderSlackMessage body", () => {
  it("splits a long unbroken line across sections within the section limit", () => {
    const payload = renderSlackMessage(message({ body: "z".repeat(9000) }));
    const texts = sectionTexts(payload);
    expect(texts.length).toBeGreaterThan(1);
    for (const text of texts)
      expect(text.length).toBeLessThanOrEqual(SLACK_LIMITS.sectionText);
    expect(texts.join("")).toBe("z".repeat(9000));
  });

  it("keeps every section's fences balanced when a code block is split", () => {
    const payload = renderSlackMessage(
      message({ body: `\`\`\`js\n${"x".repeat(9000)}\n\`\`\`` }),
    );
    const texts = sectionTexts(payload);
    expect(texts.length).toBeGreaterThan(1);
    for (const text of texts)
      expect((text.match(/^```$/gm) ?? []).length % 2).toBe(0);
  });

  it("marks omitted text in its own section rather than losing the marker", () => {
    const payload = renderSlackMessage(message({ body: "z".repeat(400_000) }));
    const texts = sectionTexts(payload);
    expect(payload.blocks?.length).toBeLessThanOrEqual(
      SLACK_LIMITS.blocksPerMessage,
    );
    expect(texts.at(-1)).toMatch(/characters omitted/);
    for (const text of texts)
      expect(text.length).toBeLessThanOrEqual(SLACK_LIMITS.sectionText);
  });

  it("adds no omission marker when the body fits", () => {
    const payload = renderSlackMessage(message({ body: "z".repeat(2000) }));
    expect(sectionTexts(payload)).toHaveLength(1);
    expect(sectionTexts(payload)[0]).not.toMatch(/omitted/);
  });

  it.each([
    ["empty", ""],
    ["blank", "   \n  "],
  ])("renders a valid payload for a %s body", (_name, body) => {
    const payload = renderSlackMessage(message({ body }));
    expect(payload.text.length).toBeGreaterThan(0);
    for (const text of sectionTexts(payload))
      expect(text.length).toBeGreaterThan(0);
  });

  it("converts markdown in the body", () => {
    const payload = renderSlackMessage(message({ body: "**bold** and <tag>" }));
    expect(sectionTexts(payload)[0]).toBe("*bold* and &lt;tag&gt;");
  });
});

describe("renderSlackMessage envelope", () => {
  it("keeps a long option label byte identical in the button value", () => {
    const label = "L".repeat(200);
    const payload = renderSlackMessage(questionMessage([{ label }]));
    const button = firstElement(payload, "actions");
    expect(textOf(button)).toHaveLength(SLACK_LIMITS.buttonText);
    expect(decodeInteractionEnvelope(String(button.value))?.response).toBe(
      label,
    );
  });

  it("round trips through the compact encoding", () => {
    const envelope = interactionEnvelope(INTERACTION_ID, 2, "a:b:c");
    expect(decodeInteractionEnvelope(envelope)).toEqual({
      interactionId: INTERACTION_ID,
      questionIndex: 2,
      response: "a:b:c",
    });
  });

  it("still decodes the legacy json encoding", () => {
    const legacy = JSON.stringify({
      interactionId: INTERACTION_ID,
      questionIndex: 1,
      response: "proceed",
    });
    expect(decodeInteractionEnvelope(legacy)).toEqual({
      interactionId: INTERACTION_ID,
      questionIndex: 1,
      response: "proceed",
    });
  });

  it("omits the question index for a plan or permission choice", () => {
    expect(
      decodeInteractionEnvelope(
        interactionEnvelope(INTERACTION_ID, undefined, "proceed"),
      ),
    ).toEqual({
      interactionId: INTERACTION_ID,
      questionIndex: undefined,
      response: "proceed",
    });
  });
});

describe("renderSlackMessage controls", () => {
  it("chunks options into actions blocks within the element limit", () => {
    const options = Array.from({ length: 40 }, (_unused, index) => ({
      label: `option ${String(index)}`,
    }));
    const payload = renderSlackMessage(questionMessage(options));
    const actions = blocksOfType(payload, "actions");
    expect(
      actions.slice(0, 2).map((block) => elementsOf(block).length),
    ).toEqual([25, 15]);
  });

  it("gives every block a unique id", () => {
    const payload = renderSlackMessage(
      message({
        kind: "question",
        body: "pick",
        metadata: {
          interactionId: INTERACTION_ID,
          questions: [
            { question: "First?", options: [{ label: "a" }] },
            { question: "Second?", options: [{ label: "b" }] },
          ],
        },
      }),
    );
    const ids = (payload.blocks ?? [])
      .map((block) => block.block_id)
      .filter((id): id is string => typeof id === "string");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses a native multi select when every option value fits", () => {
    const payload = renderSlackMessage(
      questionMessage([{ label: "x".repeat(75) }, { label: "other" }], true),
    );
    const element = firstElement(payload, "actions");
    expect(element.type).toBe("multi_static_select");
    for (const value of optionValuesOf(element))
      expect(value.length).toBeLessThanOrEqual(SLACK_LIMITS.selectOptionValue);
  });

  it("falls back to buttons and says so when an option value is too long", () => {
    const payload = renderSlackMessage(
      questionMessage([{ label: "y".repeat(160) }, { label: "other" }], true),
    );
    const element = firstElement(payload, "actions");
    expect(element.type).toBe("button");
    expect(sectionTexts(payload).join("\n")).toMatch(/comma-separated/);
  });

  it("falls back to buttons when there are more options than a select allows", () => {
    const options = Array.from({ length: 120 }, (_unused, index) => ({
      label: `option ${String(index)}`,
    }));
    const payload = renderSlackMessage(questionMessage(options, true));
    const element = firstElement(payload, "actions");
    expect(element.type).toBe("button");
  });

  it("keeps the stop button action id stable", () => {
    const payload = renderSlackMessage(
      message({
        kind: "plan",
        body: "the plan",
        metadata: {
          interactionId: INTERACTION_ID,
          options: [{ label: "Approve", value: "proceed" }],
        },
      }),
    );
    const stop = blocksOfType(payload, "actions").at(-1);
    expect(elementsOf(stop)[0]?.action_id).toBe("agentchannels_stop");
  });

  it("adds no stop button to a plain message", () => {
    const payload = renderSlackMessage(message({ body: "done" }));
    expect(blocksOfType(payload, "actions")).toHaveLength(0);
  });
});

describe("renderSlackMessage envelope routing", () => {
  it.each([
    ["bare channel", "C123", "C123", undefined],
    ["channel and thread", "C123:1700.5", "C123", "1700.5"],
  ])("routes a %s conversation", (_name, conversation, channel, thread) => {
    const payload = renderSlackMessage(
      message({ remoteConversationId: conversation }),
    );
    expect(payload.channel).toBe(channel);
    expect(payload.thread_ts).toBe(thread);
  });

  it("prefers a thread timestamp from metadata", () => {
    const payload = renderSlackMessage(
      message({ remoteConversationId: "C123", metadata: { threadTs: "9.9" } }),
    );
    expect(payload.thread_ts).toBe("9.9");
  });

  it("disables link unfurling", () => {
    const payload = renderSlackMessage(message({}));
    expect(payload.unfurl_links).toBe(false);
    expect(payload.unfurl_media).toBe(false);
  });

  it("uses a short excerpt as the notification text, not the body", () => {
    const body = "para ".repeat(2000);
    const payload = renderSlackMessage(message({ body }));
    expect(payload.text.length).toBeLessThanOrEqual(
      SLACK_LIMITS.notificationExcerpt,
    );
    expect(payload.text).not.toBe(body);
  });

  it("renders a tool call as a single context block", () => {
    const payload = renderSlackMessage(
      message({
        kind: "action",
        body: "git log --format=<%h>",
        metadata: { action: "Bash" },
      }),
    );
    const context = blocksOfType(payload, "context");
    expect(context).toHaveLength(1);
    expect(textOf(elementsOf(context[0])[0] ?? {})).toBe(
      "`Bash` git log --format=&lt;%h&gt;",
    );
  });
});
