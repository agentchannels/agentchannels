import type { DeliveryKind, DeliveryMessage } from "../model.ts";
import { type JsonObject, objectValue, stringValue } from "./http.ts";
import {
  markdownToMrkdwn,
  summarizeToMrkdwn,
  summarizeToPlainText,
} from "./mrkdwn.ts";

export const SLACK_LIMITS = {
  sectionText: 3000,
  blocksPerMessage: 50,
  actionsElements: 25,
  contextElements: 10,
  blockId: 255,
  actionId: 255,
  buttonText: 75,
  buttonValue: 2000,
  selectOptions: 100,
  selectOptionText: 75,
  selectOptionValue: 150,
  placeholderText: 150,
  notificationText: 4000,
  notificationExcerpt: 200,
} as const;

declare const DISPLAY: unique symbol;
export type DisplayText = string & { readonly [DISPLAY]: true };

export type SlackBlock = Readonly<Record<string, unknown>>;

export type SlackPostMessageBody = Readonly<{
  channel: string;
  text: DisplayText;
  thread_ts?: string;
  blocks?: readonly SlackBlock[];
  unfurl_links: false;
  unfurl_media: false;
}>;

type Choice = Readonly<{ label: string; value: string }>;

const ELLIPSIS = "…";
const FENCE = "```";
const FENCE_REPAIR = 8;
const STOP_ACTION_ID = "agentchannels_stop";
const INTERACTION_ACTION_ID = "agentchannels_interaction";

const EMPTY_BODY = "_(no content)_";

const INTERACTION_KINDS: readonly DeliveryKind[] = [
  "question",
  "permission",
  "plan",
];

function isCombining(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xfe20 && code <= 0xfe2f) ||
    code === 0x200d
  );
}

function isSafeBoundary(value: string, index: number): boolean {
  if (index <= 0 || index >= value.length) return true;
  const before = value.charCodeAt(index - 1);
  if (before >= 0xd800 && before <= 0xdbff) return false;
  if (before === 0x200d) return false;
  const at = value.codePointAt(index);
  return at === undefined || !isCombining(at);
}

function cutSafely(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let end = limit;
  while (end > 0 && !isSafeBoundary(value, end)) end -= 1;
  return value.slice(0, end);
}

function replaceLoneSurrogates(value: string): string {
  return value.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "�",
  );
}

function clamp(value: string, limit: number): DisplayText {
  const safe = replaceLoneSurrogates(value);
  if (safe.length <= limit) return safe as DisplayText;
  return `${cutSafely(safe, limit - ELLIPSIS.length)}${ELLIPSIS}` as DisplayText;
}

function identifier(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

function plainText(
  value: string,
  limit: number,
): {
  type: "plain_text";
  text: DisplayText;
} {
  return { type: "plain_text", text: clamp(value, limit) };
}

function mrkdwnText(
  value: string,
  limit: number,
): {
  type: "mrkdwn";
  text: DisplayText;
} {
  return { type: "mrkdwn", text: clamp(value, limit) };
}

export function interactionEnvelope(
  interactionId: string,
  questionIndex: number | undefined,
  response: string,
): string {
  const index = questionIndex === undefined ? "" : String(questionIndex);
  return `${interactionId}:${index}:${response}`;
}

export function decodeInteractionEnvelope(value: string):
  | Readonly<{
      interactionId: string;
      questionIndex: number | undefined;
      response: string;
    }>
  | undefined {
  if (value.startsWith("{")) {
    try {
      const parsed = objectValue(JSON.parse(value));
      const interactionId = stringValue(parsed?.interactionId);
      if (interactionId === undefined) return undefined;
      const index = parsed?.questionIndex;
      return {
        interactionId,
        questionIndex: typeof index === "number" ? index : undefined,
        response: stringValue(parsed?.response) ?? "",
      };
    } catch {
      return undefined;
    }
  }
  const first = value.indexOf(":");
  if (first <= 0) return undefined;
  const second = value.indexOf(":", first + 1);
  if (second < 0) return undefined;
  const index = value.slice(first + 1, second);
  return {
    interactionId: value.slice(0, first),
    questionIndex: index === "" ? undefined : Number(index),
    response: value.slice(second + 1),
  };
}

function countFences(value: string): number {
  return value.split("\n").filter((line) => line.trim() === FENCE).length;
}

function cutChunk(value: string, budget: number): string {
  if (value.length <= budget) return value;
  const window = value.slice(0, budget);
  for (const separator of ["\n\n", "\n", " "]) {
    const at = window.lastIndexOf(separator);
    if (at > 0) return value.slice(0, at + separator.length);
  }
  return cutSafely(value, budget);
}

function splitIntoChunks(
  text: string,
  maxChunks: number,
): { chunks: string[]; omitted: number } {
  const budget = SLACK_LIMITS.sectionText - FENCE_REPAIR;
  const chunks: string[] = [];
  let rest = text;
  let inFence: boolean = false;

  while (rest !== "" && chunks.length < maxChunks) {
    const raw = cutChunk(rest, budget);
    if (raw === "") break;
    rest = rest.slice(raw.length);
    const openAtStart: boolean = inFence;
    inFence = openAtStart !== (countFences(raw) % 2 === 1);
    const piece = `${openAtStart ? `${FENCE}\n` : ""}${raw}${inFence ? `\n${FENCE}` : ""}`;
    if (piece.trim() !== "") chunks.push(piece);
  }

  return { chunks, omitted: rest.length };
}

function section(text: string): SlackBlock {
  return { type: "section", text: mrkdwnText(text, SLACK_LIMITS.sectionText) };
}

function noticeSection(text: string): SlackBlock {
  return section(markdownToMrkdwn(text));
}

function bodySections(body: string, maxBlocks: number): SlackBlock[] {
  const converted = markdownToMrkdwn(body);
  const source =
    converted.trim() === "" ? markdownToMrkdwn(EMPTY_BODY) : converted;
  const whole = splitIntoChunks(source, maxBlocks);
  if (whole.omitted === 0)
    return whole.chunks.length === 0
      ? [section(markdownToMrkdwn(EMPTY_BODY))]
      : whole.chunks.map(section);

  const trimmed = splitIntoChunks(source, Math.max(1, maxBlocks - 1));
  return [
    ...trimmed.chunks.map(section),
    section(
      markdownToMrkdwn(`_… ${String(trimmed.omitted)} characters omitted._`),
    ),
  ];
}

function choices(raw: unknown): Choice[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry, index): Choice[] => {
    const option = objectValue(entry);
    const label =
      stringValue(option?.label) ??
      stringValue(option?.value) ??
      `Option ${String(index + 1)}`;
    return [{ label, value: stringValue(option?.value) ?? label }];
  });
}

function interactionButton(
  choice: Choice,
  envelope: string,
  actionId: string,
): SlackBlock | undefined {
  if (envelope.length > SLACK_LIMITS.buttonValue) return undefined;
  return {
    type: "button",
    text: plainText(choice.label, SLACK_LIMITS.buttonText),
    action_id: identifier(actionId, SLACK_LIMITS.actionId),
    value: envelope,
  };
}

function actionsBlocks(
  elements: readonly SlackBlock[],
  blockIdPrefix: string,
): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  for (
    let offset = 0;
    offset < elements.length;
    offset += SLACK_LIMITS.actionsElements
  ) {
    blocks.push({
      type: "actions",
      block_id: identifier(
        `${blockIdPrefix}:${String(blocks.length)}`,
        SLACK_LIMITS.blockId,
      ),
      elements: elements.slice(offset, offset + SLACK_LIMITS.actionsElements),
    });
  }
  return blocks;
}

function selectBlock(
  options: readonly Choice[],
  envelopes: readonly string[],
  interactionId: string,
  questionIndex: number,
): SlackBlock {
  return {
    type: "actions",
    block_id: identifier(
      `${interactionId}:${String(questionIndex)}:select`,
      SLACK_LIMITS.blockId,
    ),
    elements: [
      {
        type: "multi_static_select",
        action_id: identifier(
          `${INTERACTION_ACTION_ID}:${String(questionIndex)}`,
          SLACK_LIMITS.actionId,
        ),
        placeholder: plainText(
          "Select all that apply",
          SLACK_LIMITS.placeholderText,
        ),
        options: options.map((choice, index) => ({
          text: plainText(choice.label, SLACK_LIMITS.selectOptionText),
          value: envelopes[index] ?? "",
        })),
      },
    ],
  };
}

function buttonLadder(
  options: readonly Choice[],
  interactionId: string,
  questionIndex: number | undefined,
): { blocks: SlackBlock[]; unreachable: string[] } {
  const unreachable: string[] = [];
  const elements = options.flatMap((choice, index): SlackBlock[] => {
    const button = interactionButton(
      choice,
      interactionEnvelope(interactionId, questionIndex, choice.value),
      `${INTERACTION_ACTION_ID}:${String(questionIndex ?? 0)}:${String(index)}`,
    );
    if (button === undefined) {
      unreachable.push(choice.label);
      return [];
    }
    return [button];
  });
  const prefix = `${interactionId}:${String(questionIndex ?? 0)}`;
  return { blocks: actionsBlocks(elements, prefix), unreachable };
}

function questionBlocks(
  question: JsonObject,
  questionIndex: number,
  interactionId: string,
): SlackBlock[] {
  const title =
    stringValue(question.question) ?? `Question ${String(questionIndex + 1)}`;
  const options = choices(question.options);
  const descriptions = (Array.isArray(question.options) ? question.options : [])
    .map((entry) => {
      const option = objectValue(entry);
      const label = stringValue(option?.label) ?? "Option";
      const description = stringValue(option?.description);
      return description === undefined
        ? `- ${label}`
        : `- **${label}** — ${description}`;
    })
    .join("\n");

  if (options.length === 0)
    return [
      noticeSection(`**${title}**\n\nReply in this thread with your answer.`),
    ];

  const envelopes = options.map((choice) =>
    interactionEnvelope(interactionId, questionIndex, choice.value),
  );
  const fitsSelect =
    question.multiSelect === true &&
    options.length <= SLACK_LIMITS.selectOptions &&
    envelopes.every(
      (envelope) => envelope.length <= SLACK_LIMITS.selectOptionValue,
    );

  if (fitsSelect)
    return [
      noticeSection(`**${title}**\n${descriptions}`),
      selectBlock(options, envelopes, interactionId, questionIndex),
    ];

  const { blocks, unreachable } = buttonLadder(
    options,
    interactionId,
    questionIndex,
  );
  const notes = [
    `**${title}**`,
    descriptions,
    question.multiSelect === true
      ? "Pick one, or reply in this thread with a comma-separated list."
      : "",
    unreachable.length === 0
      ? ""
      : `These options have no button. Reply in this thread with the exact text:\n${unreachable.map((label) => `- ${label}`).join("\n")}`,
  ].filter((part) => part !== "");

  return [noticeSection(notes.join("\n\n")), ...blocks];
}

function stopBlock(): SlackBlock {
  return {
    type: "actions",
    block_id: STOP_ACTION_ID,
    elements: [
      {
        type: "button",
        text: plainText("Stop", SLACK_LIMITS.buttonText),
        style: "danger",
        action_id: STOP_ACTION_ID,
        value: "stop",
      },
    ],
  };
}

function controlBlocks(
  message: DeliveryMessage,
  metadata: JsonObject,
): SlackBlock[] {
  if (!INTERACTION_KINDS.includes(message.kind)) return [];
  const interactionId = stringValue(metadata.interactionId) ?? "interaction";
  const questions = Array.isArray(metadata.questions) ? metadata.questions : [];

  if (questions.length > 0)
    return questions.flatMap((entry, index) =>
      questionBlocks(objectValue(entry) ?? {}, index, interactionId),
    );

  const options = choices(metadata.options);
  if (options.length === 0) return [];
  const { blocks, unreachable } = buttonLadder(
    options,
    interactionId,
    undefined,
  );
  if (unreachable.length === 0) return blocks;
  return [
    ...blocks,
    noticeSection(
      `These options have no button. Reply in this thread with the exact text:\n${unreachable.map((label) => `- ${label}`).join("\n")}`,
    ),
  ];
}

function actionBlocks(
  message: DeliveryMessage,
  metadata: JsonObject,
): SlackBlock[] {
  const action = stringValue(metadata.action) ?? "Tool";
  return [
    {
      type: "context",
      elements: [
        mrkdwnText(
          `\`${action}\` ${markdownToMrkdwn(message.body)}`,
          SLACK_LIMITS.sectionText,
        ),
      ],
    },
  ];
}

function assemble(
  body: readonly SlackBlock[],
  controls: readonly SlackBlock[],
  trailer: readonly SlackBlock[],
): SlackBlock[] {
  const reserved = trailer.length + 1;
  const controlBudget = Math.max(
    0,
    SLACK_LIMITS.blocksPerMessage - reserved - 1,
  );
  const keptControls = controls.slice(0, controlBudget);
  const dropped = controls.length - keptControls.length;
  const notice =
    dropped === 0
      ? []
      : [
          noticeSection(
            `${String(dropped)} more control(s) are not shown. Reply in this thread with the exact option text.`,
          ),
        ];
  const bodyBudget = Math.max(
    1,
    SLACK_LIMITS.blocksPerMessage -
      keptControls.length -
      notice.length -
      trailer.length,
  );
  return [
    ...body.slice(0, bodyBudget),
    ...keptControls,
    ...notice,
    ...trailer,
  ].slice(0, SLACK_LIMITS.blocksPerMessage);
}

export function renderSlackMessage(
  message: DeliveryMessage,
): SlackPostMessageBody {
  const metadata = objectValue(message.metadata) ?? {};
  const [channel, ...threadParts] = message.remoteConversationId.split(":");
  const threadTs =
    stringValue(metadata.threadTs) ??
    stringValue(metadata.thread_ts) ??
    (threadParts.length > 0 ? threadParts.join(":") : undefined);

  const isAction = message.kind === "action";
  const trailer = INTERACTION_KINDS.includes(message.kind) ? [stopBlock()] : [];
  const controls = controlBlocks(message, metadata);
  const bodyBudget = Math.max(
    1,
    SLACK_LIMITS.blocksPerMessage - controls.length - trailer.length - 1,
  );
  const body = isAction
    ? actionBlocks(message, metadata)
    : bodySections(message.body, bodyBudget);

  const summary = summarizeToMrkdwn(message.body);
  const notification = isAction
    ? `${stringValue(metadata.action) ?? "Tool"} ${summary}`
    : summary;

  return {
    channel: channel ?? message.remoteConversationId,
    text: clamp(
      notification.trim() === ""
        ? summarizeToPlainText(EMPTY_BODY)
        : notification,
      SLACK_LIMITS.notificationExcerpt,
    ),
    ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
    blocks: assemble(body, controls, trailer),
    unfurl_links: false,
    unfurl_media: false,
  };
}
