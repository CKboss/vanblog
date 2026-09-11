import { describe, it, expect } from "vitest";
import {
  articleOverviewMarkdown,
  DEFAULT_OVERVIEW_CHARS,
} from "../utils/articleExcerpt";

/** Same pattern as issue #410 screenshots: long link text, URL cut mid-href. */
const ISSUE_410_LINK_TEXT = "1".repeat(DEFAULT_OVERVIEW_CHARS - 10);
const ISSUE_410_HREF = "https://www.baidu.com";
const ISSUE_410_MARKDOWN = `[${ISSUE_410_LINK_TEXT}](${ISSUE_410_HREF})`;
const pad = (n: number) => "x".repeat(n);

describe("automatic excerpt budget (no <!-- more -->)", () => {
  it("summarizes with the first 200 characters", () => {
    expect(DEFAULT_OVERVIEW_CHARS).toBe(200);
    const content = "汉".repeat(250);
    expect(articleOverviewMarkdown(content)).toBe("汉".repeat(200));
  });

  it("leaves content within the budget untouched", () => {
    const content = "汉".repeat(DEFAULT_OVERVIEW_CHARS - 1);
    expect(articleOverviewMarkdown(content)).toBe(content);
  });

  it("still prefers the marker over the budget", () => {
    const content = `这是摘要\n\n<!-- more -->\n\n${"正文".repeat(200)}`;
    expect(articleOverviewMarkdown(content)).toBe("这是摘要\n\n");
  });

  it("never cuts a surrogate pair (emoji) in half", () => {
    const content = "😀".repeat(99) + "a" + "😀".repeat(60);
    const excerpt = articleOverviewMarkdown(content);
    expect(excerpt).toBe("😀".repeat(99) + "a");
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(excerpt)).toBe(false);
  });

  it("accepts an explicit budget", () => {
    expect(articleOverviewMarkdown("abcdefg", 3)).toBe("abc");
  });
});

describe("articleOverviewMarkdown (#410)", () => {
  it("keeps a long [text](url) intact instead of cutting at the budget", () => {
    const excerpt = articleOverviewMarkdown(ISSUE_410_MARKDOWN);
    expect(ISSUE_410_MARKDOWN.length).toBeGreaterThan(DEFAULT_OVERVIEW_CHARS);
    expect(ISSUE_410_MARKDOWN.slice(0, DEFAULT_OVERVIEW_CHARS)).not.toContain(
      ISSUE_410_HREF
    );
    expect(excerpt).toBe(ISSUE_410_MARKDOWN);
    expect(excerpt).toContain(ISSUE_410_HREF);
    expect(excerpt).toContain(ISSUE_410_LINK_TEXT);
  });

  it("does not swallow the rest of the article after completing one link", () => {
    const rest = "\n\n第二段还在。";
    const excerpt = articleOverviewMarkdown(ISSUE_410_MARKDOWN + rest);
    expect(excerpt).toBe(ISSUE_410_MARKDOWN);
    expect(excerpt).not.toContain("第二段还在");
  });

  it("still uses the <!-- more --> split when the marker is present", () => {
    const content = `short intro\n\n<!-- more -->\n\n${ISSUE_410_MARKDOWN}`;
    expect(articleOverviewMarkdown(content)).toBe("short intro\n\n");
  });

  it("keeps backticks inside the link label and a query-string href", () => {
    const href = "https://example.com/search?q=hello+world&lang=zh-CN";
    const labeled = `[\`code label ${pad(
      DEFAULT_OVERVIEW_CHARS - 20
    )}\`](${href})\n\nmore text after the link`;
    const excerpt = articleOverviewMarkdown(labeled);
    expect(excerpt).toContain(href);
    expect(excerpt).toContain("`code label");
    expect(excerpt).not.toContain("more text after the link");
  });

  it("keeps balanced parentheses in the URL", () => {
    const href = "https://en.wikipedia.org/wiki/Example_(disambiguation)";
    const markdown = `[wiki parens ${pad(DEFAULT_OVERVIEW_CHARS - 20)}](${href})`;
    expect(markdown.length).toBeGreaterThan(DEFAULT_OVERVIEW_CHARS);
    expect(articleOverviewMarkdown(markdown)).toBe(markdown);
  });

  it("completes a truncated markdown image the same way", () => {
    const src = "https://example.com/very/long/path/to/an/image.png";
    const markdown = `![long alt text ${pad(DEFAULT_OVERVIEW_CHARS - 20)}](${src})`;
    expect(markdown.length).toBeGreaterThan(DEFAULT_OVERVIEW_CHARS);
    expect(articleOverviewMarkdown(markdown)).toBe(markdown);
  });

  it("leaves content shorter than the budget unchanged", () => {
    expect(articleOverviewMarkdown("hello [x](https://example.com)")).toBe(
      "hello [x](https://example.com)"
    );
  });
});
