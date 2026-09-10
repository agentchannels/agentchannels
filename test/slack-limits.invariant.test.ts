import { describe, expect, it } from "vitest";

import {
  decodeInteractionEnvelope,
  renderSlackMessage,
} from "../src/connectors/slack-blocks.ts";
import { markdownToMrkdwn } from "../src/connectors/mrkdwn.ts";
import type { DeliveryKind, DeliveryMessage } from "../src/model.ts";
import { deliveryMessage } from "./helpers/fixtures.ts";
import {
  PATHOLOGICAL_BODIES,
  PATHOLOGICAL_OPTION_SETS,
} from "./helpers/slack-corpus.ts";
import {
  assertSlackPayloadWithinLimits,
  payloadValues,
} from "./helpers/slack-limits.ts";

const INTERACTION_ID = `ix_${"f".repeat(32)}`;

const KINDS: readonly DeliveryKind[] = [
  "progress",
  "action",
  "final",
  "question",
  "permission",
  "plan",
  "stopped",
  "error",
];

const PLAIN_KINDS: readonly DeliveryKind[] = [
  "progress",
  "final",
  "stopped",
  "error",
];

function metadataFor(
  kind: DeliveryKind,
  options: readonly Record<string, unknown>[],
  multiSelect: boolean,
): Record<string, unknown> {
  if (kind === "action") return { action: "Bash", result: "ok" };
  if (kind === "question")
    return {
      interactionId: INTERACTION_ID,
      questions: [
        { question: "Which one?", options, multiSelect },
        { question: "And then?", options: options.slice(0, 3), multiSelect },
      ],
    };
  if (kind === "permission" || kind === "plan")
    return { interactionId: INTERACTION_ID, options };
  return {};
}

function expectedResponses(
  options: readonly Record<string, unknown>[],
): Set<string> {
  return new Set(
    options.map((option) =>
      typeof option.value === "string"
        ? option.value
        : typeof option.label === "string"
          ? option.label
          : "",
    ),
  );
}

const CASES: readonly Readonly<{
  name: string;
  message: DeliveryMessage;
  options: readonly Record<string, unknown>[];
}>[] = KINDS.flatMap((kind) =>
  PATHOLOGICAL_BODIES.flatMap((entry) =>
    PATHOLOGICAL_OPTION_SETS.map((set) => ({
      name: `${kind} / ${entry.name} / ${set.name}`,
      options: set.options,
      message: deliveryMessage({
        kind,
        body: entry.body,
        metadata: metadataFor(kind, set.options, set.multiSelect),
      }),
    })),
  ),
);

function stripScaffolding(value: string): string {
  return value
    .replace(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      "�",
    )
    .replaceAll("`", "")
    .replace(/\s/g, "");
}

describe("slack payload invariants", () => {
  it("covers every delivery kind", () => {
    expect(new Set(CASES.map((entry) => entry.message.kind)).size).toBe(
      KINDS.length,
    );
  });

  it.each(CASES.map((entry) => [entry.name, entry] as const))(
    "produces a payload within every documented Slack limit: %s",
    (_name, entry) => {
      assertSlackPayloadWithinLimits(renderSlackMessage(entry.message));
    },
  );

  it.each(CASES.map((entry) => [entry.name, entry] as const))(
    "copies every interactive value back byte for byte: %s",
    (_name, entry) => {
      const payload = renderSlackMessage(entry.message);
      const expected = expectedResponses(entry.options);
      for (const value of payloadValues(payload)) {
        if (value === "stop") continue;
        const decoded = decodeInteractionEnvelope(value);
        expect(decoded, `decodable value ${value}`).toBeDefined();
        expect(decoded?.interactionId).toBe(INTERACTION_ID);
        expect(expected.has(decoded?.response ?? "")).toBe(true);
      }
    },
  );

  it.each(
    CASES.filter((entry) => PLAIN_KINDS.includes(entry.message.kind)).map(
      (entry) => [entry.name, entry] as const,
    ),
  )(
    "loses no body text except through an explicit marker: %s",
    (_name, entry) => {
      const payload = renderSlackMessage(entry.message);
      const sections = (payload.blocks ?? [])
        .filter((block) => block.type === "section")
        .map((block) => (block.text as { text: string }).text);
      if (sections.some((text) => text.includes("characters omitted"))) return;
      const converted = markdownToMrkdwn(entry.message.body);
      if (converted.trim() === "") return;
      expect(stripScaffolding(sections.join(""))).toBe(
        stripScaffolding(converted),
      );
    },
  );
});
