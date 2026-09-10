const LONE_SURROGATE = String.fromCharCode(0xd800);
const ZWJ_FAMILY = "👩‍👩‍👧‍👦";

function planDocument(): string {
  const sections = Array.from(
    { length: 12 },
    (_unused, index) => `## Step ${String(index + 1)}

Prose about step ${String(index + 1)} with **bold**, *italic*, a [link](https://x.test/a?b=1&c=2) and \`inline <code>\`.

- top level
  - nested with a longer label that runs on
    - deeper still
1. ordered one
2. ordered two

\`\`\`ts
const value: Array<string> = ["a" as const];
if (a < b && c > d) run(2 > 1);
\`\`\`
`,
  );
  return `# Plan

| Column | Meaning |
|---|---|
| one | first |
| two | second |

${sections.join("\n")}`;
}

function entitySoup(): string {
  const unit =
    "`&<>&amp;&lt;<@U123><!here><https://x.test|y>[a](b)` & <tag> 2>&1 ";
  return unit.repeat(Math.ceil(5000 / unit.length));
}

export type CorpusEntry = Readonly<{ name: string; body: string }>;

export const PATHOLOGICAL_BODIES: readonly CorpusEntry[] = [
  { name: "empty", body: "" },
  { name: "blank", body: "   \n  " },
  { name: "plain", body: "done" },
  { name: "plan document", body: planDocument() },
  { name: "unbroken line", body: "z".repeat(9000) },
  { name: "entity soup", body: entitySoup() },
  { name: "long fence", body: `\`\`\`js\n${"x".repeat(9000)}\n\`\`\`` },
  { name: "unterminated fence", body: "```js\nconst a = 1;" },
  { name: "fence inside fence", body: "````\n```\ninner\n```\n````" },
  { name: "table", body: "| a | b |\n|---|---|\n| 1 | 2 |" },
  { name: "crlf", body: "a\r\nb\rc\td" },
  { name: "typographic quotes", body: "It “stopped” unexpectedly…" },
  { name: "zwj emoji", body: `${ZWJ_FAMILY.repeat(1200)} done` },
  { name: "lone surrogate", body: `before${LONE_SURROGATE}after` },
  {
    name: "permission body",
    body: `**Claude wants to use Bash**\n\n\`\`\`sh\n${"echo <a> & b | c\n".repeat(90)}\`\`\`\n\nAllowing this every time stores \`Bash(echo:*)\` for this Agent.`,
  },
];

export const PATHOLOGICAL_OPTION_SETS: readonly Readonly<{
  name: string;
  options: readonly Record<string, unknown>[];
  multiSelect: boolean;
}>[] = [
  {
    name: "short choices",
    options: [
      { label: "Approve this plan and start the work", value: "proceed" },
      { label: "Send the plan back with changes", value: "revise" },
    ],
    multiSelect: false,
  },
  {
    name: "long labels",
    options: Array.from({ length: 40 }, (_unused, index) => ({
      label: `${String(index)} ${"L".repeat(200)}`,
    })),
    multiSelect: false,
  },
  {
    name: "over the select cap",
    options: Array.from({ length: 120 }, (_unused, index) => ({
      label: `option ${String(index)}`,
    })),
    multiSelect: true,
  },
  {
    name: "entity labels",
    options: [
      { label: "keep <a> & <b>" },
      { label: `emoji ${ZWJ_FAMILY} choice` },
      { label: `surrogate ${LONE_SURROGATE} choice` },
    ],
    multiSelect: true,
  },
];
