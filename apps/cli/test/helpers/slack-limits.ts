import { expect } from "bun:test";

import {
  SLACK_LIMITS,
  type SlackBlock,
  type SlackPostMessageBody,
} from "../../src/connectors/slack-blocks.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const parsed = record(entry);
        return parsed === undefined ? [] : [parsed];
      })
    : [];
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function checkText(
  node: Record<string, unknown>,
  limit: number,
  label: string,
): void {
  const text = node.text;
  expect(typeof text, `${label} text is a string`).toBe("string");
  const value = String(text);
  expect(value.length, `${label} is not empty`).toBeGreaterThan(0);
  expect(
    value.length,
    `${label} is within ${String(limit)}`,
  ).toBeLessThanOrEqual(limit);
  expect(hasLoneSurrogate(value), `${label} has no lone surrogate`).toBe(false);
}

function checkOption(option: Record<string, unknown>, label: string): void {
  const text = record(option.text);
  expect(text, `${label} has a text object`).toBeDefined();
  if (text !== undefined)
    checkText(text, SLACK_LIMITS.selectOptionText, `${label} text`);
  const value = String(option.value ?? "");
  expect(
    value.length,
    `${label} value is within ${String(SLACK_LIMITS.selectOptionValue)}`,
  ).toBeLessThanOrEqual(SLACK_LIMITS.selectOptionValue);
}

function checkElement(
  element: Record<string, unknown>,
  label: string,
  actionIds: string[],
): void {
  const actionId = element.action_id;
  if (typeof actionId === "string") {
    expect(actionId.length, `${label} action_id length`).toBeLessThanOrEqual(
      SLACK_LIMITS.actionId,
    );
    actionIds.push(actionId);
  }

  if (element.type === "button") {
    const text = record(element.text);
    expect(text, `${label} has button text`).toBeDefined();
    if (text !== undefined)
      checkText(text, SLACK_LIMITS.buttonText, `${label} text`);
    expect(
      String(element.value ?? "").length,
      `${label} value length`,
    ).toBeLessThanOrEqual(SLACK_LIMITS.buttonValue);
    return;
  }

  if (
    element.type === "multi_static_select" ||
    element.type === "static_select"
  ) {
    const options = records(element.options);
    expect(options.length, `${label} option count`).toBeLessThanOrEqual(
      SLACK_LIMITS.selectOptions,
    );
    for (const [index, option] of options.entries())
      checkOption(option, `${label} option ${String(index)}`);
    const placeholder = record(element.placeholder);
    if (placeholder !== undefined)
      checkText(
        placeholder,
        SLACK_LIMITS.placeholderText,
        `${label} placeholder`,
      );
    return;
  }

  if (element.type === "mrkdwn" || element.type === "plain_text")
    checkText(element, SLACK_LIMITS.sectionText, label);
}

function checkBlock(
  block: SlackBlock,
  index: number,
  blockIds: string[],
): void {
  const label = `block ${String(index)} (${String(block.type)})`;
  const blockId = block.block_id;
  if (typeof blockId === "string") {
    expect(blockId.length, `${label} block_id length`).toBeLessThanOrEqual(
      SLACK_LIMITS.blockId,
    );
    blockIds.push(blockId);
  }

  if (block.type === "section") {
    const text = record(block.text);
    expect(text, `${label} has a text object`).toBeDefined();
    if (text !== undefined)
      checkText(text, SLACK_LIMITS.sectionText, `${label} text`);
    return;
  }

  const elements = records(block.elements);
  const cap =
    block.type === "context"
      ? SLACK_LIMITS.contextElements
      : SLACK_LIMITS.actionsElements;
  expect(elements.length, `${label} element count`).toBeLessThanOrEqual(cap);

  const actionIds: string[] = [];
  for (const [position, element] of elements.entries())
    checkElement(element, `${label} element ${String(position)}`, actionIds);
  expect(new Set(actionIds).size, `${label} action ids are unique`).toBe(
    actionIds.length,
  );
}

export function assertSlackPayloadWithinLimits(
  payload: SlackPostMessageBody,
): void {
  expect(payload.channel.length, "channel is set").toBeGreaterThan(0);
  expect(payload.text.length, "notification text is not empty").toBeGreaterThan(
    0,
  );
  expect(
    payload.text.length,
    "notification text is within guidance",
  ).toBeLessThanOrEqual(SLACK_LIMITS.notificationText);
  expect(
    hasLoneSurrogate(payload.text),
    "notification has no lone surrogate",
  ).toBe(false);

  const blocks = payload.blocks ?? [];
  expect(blocks.length, "block count").toBeLessThanOrEqual(
    SLACK_LIMITS.blocksPerMessage,
  );

  const blockIds: string[] = [];
  for (const [index, block] of blocks.entries())
    checkBlock(block, index, blockIds);
  expect(new Set(blockIds).size, "block ids are unique").toBe(blockIds.length);
}

export function payloadValues(payload: SlackPostMessageBody): string[] {
  const values: string[] = [];
  for (const block of payload.blocks ?? []) {
    for (const element of records(block.elements)) {
      if (typeof element.value === "string") values.push(element.value);
      for (const option of records(element.options))
        if (typeof option.value === "string") values.push(option.value);
    }
  }
  return values;
}
