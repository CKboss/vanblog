import { describe, it, expect } from "vitest";
import { headingRehypePlugin, isFootnotesHeading } from "../components/Markdown/heading";

/**
 * hast 风格的测试替身类型：插件会**原地改写**这棵树（往 properties 里写
 * id / data-id / class，往 children 里追加永久链接 <a>）。不给局部类型时，
 * 对象字面量会被推断成 `properties: {}` 这类窄形状，断言读插件写入的字段
 * 就全是 TS2339。真实的 hast `Properties` 本来就是开放索引签名，这里的
 * `Record<string, unknown>` 与运行时事实一致；断言一行未改。
 */
type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};
type HastRoot = { type: string; children: HastNode[] };

describe("heading plugin anchors", () => {
  it("strips trailing spaces from id and data-id", () => {
    const tree: HastRoot = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "h2",
          properties: {},
          children: [{ type: "text", value: "My Title " }],
        },
      ],
    };
    headingRehypePlugin()(tree);
    expect(tree.children[0].properties.id).toBe("My Title");
    expect(tree.children[0].properties["data-id"]).toBe("My Title");
  });

  it("uses the full visible text when a heading has inline markdown", () => {
    const tree: HastRoot = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "h3",
          properties: {},
          children: [
            {
              type: "element",
              tagName: "strong",
              children: [{ type: "text", value: "Bold Title" }],
            },
          ],
        },
      ],
    };
    headingRehypePlugin()(tree);
    expect(tree.children[0].properties.id).toBe("Bold Title");
    expect(tree.children[0].properties["data-id"]).toBe("Bold Title");
  });

  it("does not rewrite the GFM footnotes section heading", () => {
    const tree: HastRoot = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "h2",
          properties: { id: "footnote-label", className: ["sr-only"] },
          children: [{ type: "text", value: "Footnotes" }],
        },
      ],
    };
    headingRehypePlugin()(tree);
    expect(tree.children[0].properties.id).toBe("footnote-label");
    expect(tree.children[0].properties.className).toEqual(["sr-only"]);
    expect(tree.children[0].properties["data-id"]).toBeUndefined();
    expect(isFootnotesHeading(tree.children[0])).toBe(true);
  });

  it("leaves already-clean titles unchanged", () => {
    const tree: HastRoot = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "h2",
          properties: {},
          children: [{ type: "text", value: "Clean Title" }],
        },
      ],
    };
    headingRehypePlugin()(tree);
    expect(tree.children[0].properties.id).toBe("Clean Title");
  });

  it("adds a selectable permalink with an encoded hash href", () => {
    const tree: HastRoot = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "h2",
          properties: {},
          children: [{ type: "text", value: "评论系统" }],
        },
      ],
    };
    headingRehypePlugin()(tree);
    const heading = tree.children[0];
    const permalink = heading.children.find((child) => child.tagName === "a");
    expect(heading.properties.id).toBe("评论系统");
    expect(heading.properties["data-id"]).toBe("评论系统");
    expect(heading.properties.class).toBe("markdown-heading");
    expect(permalink.properties.href).toBe(
      "#%E8%AF%84%E8%AE%BA%E7%B3%BB%E7%BB%9F"
    );
    expect(permalink.properties.className).toEqual(["heading-permalink"]);
    expect(permalink.children[0].value).toBe("#");
  });

  it("encodes spaces in the permalink href and keeps the raw id", () => {
    const tree: HastRoot = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "h2",
          properties: {},
          children: [{ type: "text", value: "My Title" }],
        },
      ],
    };
    headingRehypePlugin()(tree);
    const permalink = tree.children[0].children.find(
      (child) => child.tagName === "a"
    );
    expect(tree.children[0].properties.id).toBe("My Title");
    expect(permalink.properties.href).toBe("#My%20Title");
  });
});
