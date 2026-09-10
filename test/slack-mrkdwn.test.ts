import { describe, expect, it } from "vitest";

import {
  markdownToMrkdwn,
  summarizeToMrkdwn,
  summarizeToPlainText,
} from "../src/connectors/mrkdwn.ts";

describe("markdownToMrkdwn", () => {
  it.each([
    ["bold", "**bold**", "*bold*"],
    ["underscore bold", "__bold__", "*bold*"],
    ["italic", "*italic*", "_italic_"],
    ["underscore italic", "_italic_", "_italic_"],
    ["bold italic", "***both***", "*_both_*"],
    ["strikethrough", "~~gone~~", "~gone~"],
    ["two bold runs", "**a** and **b**", "*a* and *b*"],
    ["mixed", "**b** and *i*", "*b* and _i_"],
    ["lone asterisks", "a * b * c", "a * b * c"],
    ["snake case", "snake_case_name", "snake_case_name"],
  ])("converts %s", (_name, input, expected) => {
    expect(markdownToMrkdwn(input)).toBe(expected);
  });

  it.each([
    ["h1", "# Title", "*Title*"],
    ["h6", "###### Title", "*Title*"],
    ["closed atx", "## Title ##", "*Title*"],
    ["thematic break", "---", "──────────"],
    ["asterisk break", "***", "──────────"],
  ])("converts %s", (_name, input, expected) => {
    expect(markdownToMrkdwn(input)).toBe(expected);
  });

  it("renders nested bullets with depth markers", () => {
    expect(markdownToMrkdwn("- one\n  - two\n    - three")).toBe(
      "• one\n    ◦ two\n        ▪ three",
    );
  });

  it("keeps ordered list markers", () => {
    expect(markdownToMrkdwn("1. first\n2. second")).toBe("1. first\n2. second");
  });

  it("collapses nested blockquotes to one level", () => {
    expect(markdownToMrkdwn("> quoted\n>> deeper")).toBe("> quoted\n> deeper");
  });

  it("drops the divider row of a table and keeps the rest", () => {
    expect(markdownToMrkdwn("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(
      "| a | b |\n| 1 | 2 |",
    );
  });
});

describe("markdownToMrkdwn escaping", () => {
  it.each([
    ["ampersand", "a & b", "a &amp; b"],
    ["angle brackets", "Array<string>", "Array&lt;string&gt;"],
    ["shell redirect", "run 2>&1", "run 2&gt;&amp;1"],
    ["existing entity", "&amp;", "&amp;amp;"],
  ])("escapes %s", (_name, input, expected) => {
    expect(markdownToMrkdwn(input)).toBe(expected);
  });

  it("escapes control characters inside a fenced block", () => {
    expect(markdownToMrkdwn('```sh\ngrep "x" a.txt 2>&1\n```')).toBe(
      '```\ngrep "x" a.txt 2&gt;&amp;1\n```',
    );
  });

  it("escapes control characters inside an inline code span", () => {
    expect(markdownToMrkdwn("use `Map<K, V>` here")).toBe(
      "use `Map&lt;K, V&gt;` here",
    );
  });
});

describe("markdownToMrkdwn code spans", () => {
  it("leaves markdown inside an inline code span alone", () => {
    expect(markdownToMrkdwn("`**not bold**` stays")).toBe(
      "`**not bold**` stays",
    );
  });

  it("drops the language tag from a fence", () => {
    expect(markdownToMrkdwn("```js\nconst a = 1;\n```")).toBe(
      "```\nconst a = 1;\n```",
    );
  });

  it("normalizes a tilde fence", () => {
    expect(markdownToMrkdwn("~~~\nplain\n~~~")).toBe("```\nplain\n```");
  });

  it("closes an unterminated fence", () => {
    expect(markdownToMrkdwn("```js\nconst a = 1;")).toBe(
      "```\nconst a = 1;\n```",
    );
  });

  it("leaves an unpaired backtick as literal text", () => {
    expect(markdownToMrkdwn("a ` b")).toBe("a ` b");
  });
});

describe("markdownToMrkdwn links", () => {
  it("rewrites an inline link and escapes the query string", () => {
    expect(markdownToMrkdwn("[Docs](https://x.test?a=1&b=2)")).toBe(
      "<https://x.test?a=1&amp;b=2|Docs>",
    );
  });

  it("rewrites a bare url", () => {
    expect(markdownToMrkdwn("see https://x.test/page now")).toBe(
      "see <https://x.test/page> now",
    );
  });

  it("rewrites an autolink", () => {
    expect(markdownToMrkdwn("<https://x.test>")).toBe("<https://x.test>");
  });

  it("rewrites a mailto link", () => {
    expect(markdownToMrkdwn("[Mail](mailto:a@x.test)")).toBe(
      "<mailto:a@x.test|Mail>",
    );
  });

  it("uses the url alone when a link has no label", () => {
    expect(markdownToMrkdwn("[](https://x.test)")).toBe("<https://x.test>");
  });

  it("does not inject emphasis inside a url", () => {
    expect(markdownToMrkdwn("see https://x.test/a*b*c now")).toBe(
      "see <https://x.test/a*b*c> now",
    );
  });

  it("does not relink a url that is already inside a link", () => {
    expect(markdownToMrkdwn("[Docs](https://x.test/a)")).toBe(
      "<https://x.test/a|Docs>",
    );
  });

  it("keeps a link intact inside bold", () => {
    expect(markdownToMrkdwn("**[Docs](https://x.test)**")).toBe(
      "*<https://x.test|Docs>*",
    );
  });

  it("drops the marker of an image and keeps its alt text", () => {
    expect(markdownToMrkdwn("![Chart](https://x.test/c.png)")).toBe(
      "<https://x.test/c.png|Chart>",
    );
  });
});

describe("markdownToMrkdwn input hygiene", () => {
  it.each([
    ["empty", "", ""],
    ["blank", "   ", "   "],
  ])("passes %s input through", (_name, input, expected) => {
    expect(markdownToMrkdwn(input)).toBe(expected);
  });

  it("normalizes carriage returns", () => {
    expect(markdownToMrkdwn("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("strips the vault sentinel from input", () => {
    const sentinel = "\ue000";
    expect(markdownToMrkdwn(`a${sentinel}0${sentinel}b`)).toBe("a0b");
  });

  it("converting twice is not the same as converting once", () => {
    const once = markdownToMrkdwn("**bold**");
    expect(markdownToMrkdwn(once)).not.toBe(once);
  });
});

describe("summarize", () => {
  it("keeps mrkdwn formatting and escaping for a notification", () => {
    expect(summarizeToMrkdwn("## Title\n\n**b** & `c`")).toBe(
      "*Title* *b* &amp; `c`",
    );
  });

  it("removes formatting and escaping for a plain text field", () => {
    expect(summarizeToPlainText("## Title\n\n**b** & `c`")).toBe("Title b & c");
  });

  it("drops a fenced block from a plain text summary", () => {
    expect(summarizeToPlainText("before\n```\ncode\n```\nafter")).toBe(
      "before after",
    );
  });

  it("keeps a link label and drops its url in a plain text summary", () => {
    expect(summarizeToPlainText("see [Docs](https://x.test)")).toBe("see Docs");
  });
});
