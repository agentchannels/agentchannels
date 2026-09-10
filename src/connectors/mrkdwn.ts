const BULLETS = ["•", "◦", "▪"] as const;
const INDENT = "    ";
const RULE = "──────────";
const VAULT = "\ue000";

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const TABLE_DIVIDER = /^[ \t]*\|?[ \t:|-]*-[ \t:|-]*\|[ \t:|-]*$/;
const BLOCKQUOTE = /^ {0,3}>+[ \t]?(.*)$/;
const BULLET = /^([ \t]*)[-*+][ \t]+(.*)$/;
const ORDERED = /^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/;

const INLINE_CODE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;
const FENCED_BLOCK = /```[\s\S]*?```/g;

const AUTOLINK = /&lt;((?:https?:\/\/|mailto:)[^\s]*?)&gt;/g;
const INLINE_LINK =
  /!?\[([^\]]*)\]\([ \t]*([^\s)]+?)(?:[ \t]+"[^"]*")?[ \t]*\)/g;
const BARE_URL = /(^|[\s(])((?:https?:\/\/|mailto:)[^\s<>|]*[^\s<>|.,;:!?)])/g;

const BOLD_ITALIC = /\*\*\*(\S(?:[\s\S]*?\S)?)\*\*\*/g;
const BOLD_STAR = /\*\*(\S(?:[^*]*\S)?)\*\*/g;
const BOLD_UNDERSCORE = /__(\S(?:[^_]*\S)?)__/g;
const ITALIC_STAR = /(^|[^*\w])\*(\S(?:[^*]*\S)?)\*(?![*\w])/g;
const STRIKETHROUGH = /~~([^~]+)~~/g;

type Line =
  | { kind: "paragraph"; content: string }
  | { kind: "heading"; content: string }
  | { kind: "quote"; content: string }
  | { kind: "bullet"; depth: number; content: string }
  | { kind: "ordered"; depth: number; marker: string; content: string }
  | { kind: "rule" }
  | { kind: "tableDivider" };

function escapeEntities(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function listDepth(indent: string): number {
  return Math.min(
    BULLETS.length - 1,
    Math.floor(indent.replaceAll("\t", "  ").length / 2),
  );
}

function classify(raw: string): Line {
  const heading = HEADING.exec(raw);
  if (heading) return { kind: "heading", content: heading[1] ?? "" };
  if (THEMATIC_BREAK.test(raw)) return { kind: "rule" };
  if (raw.includes("|") && TABLE_DIVIDER.test(raw))
    return { kind: "tableDivider" };
  const quote = BLOCKQUOTE.exec(raw);
  if (quote) return { kind: "quote", content: quote[1] ?? "" };
  const ordered = ORDERED.exec(raw);
  if (ordered)
    return {
      kind: "ordered",
      depth: listDepth(ordered[1] ?? ""),
      marker: ordered[2] ?? "1",
      content: ordered[3] ?? "",
    };
  const bullet = BULLET.exec(raw);
  if (bullet)
    return {
      kind: "bullet",
      depth: listDepth(bullet[1] ?? ""),
      content: bullet[2] ?? "",
    };
  return { kind: "paragraph", content: raw };
}

function transformProse(
  value: string,
  stash: (rendered: string) => string,
): string {
  let text = escapeEntities(value);
  text = text.replace(AUTOLINK, (_match, url: string) => stash(`<${url}>`));
  text = text.replace(INLINE_LINK, (_match, label: string, url: string) =>
    stash(label.trim() === "" ? `<${url}>` : `<${url}|${label}>`),
  );
  text = text.replace(
    BARE_URL,
    (_match, lead: string, url: string) => `${lead}${stash(`<${url}>`)}`,
  );
  text = text.replace(BOLD_ITALIC, (_match, inner: string) =>
    stash(`*_${inner}_*`),
  );
  text = text.replace(BOLD_STAR, (_match, inner: string) =>
    stash(`*${inner}*`),
  );
  text = text.replace(BOLD_UNDERSCORE, (_match, inner: string) =>
    stash(`*${inner}*`),
  );
  text = text.replace(
    ITALIC_STAR,
    (_match, lead: string, inner: string) => `${lead}${stash(`_${inner}_`)}`,
  );
  return text.replace(STRIKETHROUGH, "~$1~");
}

function transformInline(content: string): string {
  const links: string[] = [];
  const stash = (link: string): string =>
    `${VAULT}${String(links.push(link) - 1)}${VAULT}`;

  const unvault = (value: string): string =>
    value.replace(/\ue000(\d+)\ue000/g, (_match, slot: string) =>
      unvault(links[Number(slot)] ?? ""),
    );

  let result = "";
  let index = 0;
  INLINE_CODE.lastIndex = 0;
  for (
    let match = INLINE_CODE.exec(content);
    match !== null;
    match = INLINE_CODE.exec(content)
  ) {
    result += transformProse(content.slice(index, match.index), stash);
    result += `\`${escapeEntities(match[2] ?? "")}\``;
    index = match.index + match[0].length;
  }
  result += transformProse(content.slice(index), stash);

  return unvault(result);
}

function renderLine(line: Line): string | undefined {
  if (line.kind === "tableDivider") return undefined;
  if (line.kind === "rule") return RULE;
  const content = transformInline(line.content);
  if (line.kind === "heading") return content === "" ? "" : `*${content}*`;
  if (line.kind === "quote") return `> ${content}`;
  if (line.kind === "bullet")
    return `${INDENT.repeat(line.depth)}${BULLETS[line.depth] ?? BULLETS[0]} ${content}`;
  if (line.kind === "ordered")
    return `${INDENT.repeat(line.depth)}${line.marker}. ${content}`;
  return content;
}

export function markdownToMrkdwn(markdown: string): string {
  const source = markdown.replaceAll(VAULT, "").replace(/\r\n?/g, "\n");
  const rendered: string[] = [];
  let fence: string | undefined;

  for (const raw of source.split("\n")) {
    if (fence !== undefined) {
      if (raw.trimStart().startsWith(fence)) {
        rendered.push("```");
        fence = undefined;
      } else {
        rendered.push(escapeEntities(raw));
      }
      continue;
    }
    const opening = FENCE.exec(raw);
    if (opening) {
      fence = (opening[1] ?? "```").slice(0, 1).repeat(3);
      rendered.push("```");
      continue;
    }
    const line = renderLine(classify(raw));
    if (line !== undefined) rendered.push(line);
  }

  if (fence !== undefined) rendered.push("```");
  return rendered.join("\n");
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function summarizeToMrkdwn(markdown: string): string {
  return collapseWhitespace(markdownToMrkdwn(markdown));
}

export function summarizeToPlainText(markdown: string): string {
  const stripped = markdown
    .replace(FENCED_BLOCK, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(INLINE_LINK, "$1")
    .replace(/^ {0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^ {0,3}>+[ \t]?/gm, "")
    .replace(/^([ \t]*)[-*+][ \t]+/gm, "$1")
    .replace(/\*\*\*|\*\*|__|~~/g, "")
    .replace(ITALIC_STAR, "$1$2");
  return collapseWhitespace(stripped);
}
