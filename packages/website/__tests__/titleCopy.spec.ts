import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  SITE_NAME_COPY_CLASS,
  SITE_NAME_COPY_CONTROL,
  SITE_NAME_COPY_LABEL,
  SITE_NAME_COPY_TOAST,
  TITLE_COPY_CLASS,
  TITLE_COPY_CONTROL,
  TITLE_COPY_LABEL,
  TITLE_COPY_TOAST,
  TITLE_LINK_COPY_CLASS,
  TITLE_LINK_COPY_CONTROL,
  TITLE_LINK_COPY_LABEL,
  TITLE_LINK_COPY_TOAST,
  TITLE_SELECTABLE_CLASS,
  articleUrl,
  describeTitleCopyControls,
  titleCopyIsKeyboardActivatable,
} from "../components/PostCard/titleCopyA11y";

const websiteRoot = path.join(__dirname, "..");
const readSrc = (rel: string) => readFileSync(path.join(websiteRoot, rel), "utf8");

describe("title copy controls", () => {
  it("are native buttons with accessible names and toasts", () => {
    const controls = describeTitleCopyControls();
    expect(controls.map((c) => c.kind)).toEqual(["title", "link", "siteName"]);
    for (const control of controls) {
      expect(control.tag).toBe("button");
      expect(control.type).toBe("button");
      expect(control.focusable).toBe(true);
      expect(control.ariaLabel.length).toBeGreaterThan(0);
      expect(control.toast.length).toBeGreaterThan(0);
      expect(control.className.length).toBeGreaterThan(0);
      expect([...control.activateKeys]).toEqual(["Enter", " "]);
    }
    expect(TITLE_COPY_LABEL).toBe("复制标题");
    expect(TITLE_LINK_COPY_LABEL).toBe("复制文章链接");
    expect(SITE_NAME_COPY_LABEL).toBe("复制站点名");
    expect(TITLE_COPY_TOAST).toMatch(/已复制/);
    expect(TITLE_LINK_COPY_TOAST).toMatch(/已复制/);
    expect(SITE_NAME_COPY_TOAST).toMatch(/已复制/);
    expect(TITLE_COPY_CONTROL.className).toBe(TITLE_COPY_CLASS);
    expect(TITLE_LINK_COPY_CONTROL.className).toBe(TITLE_LINK_COPY_CLASS);
    expect(SITE_NAME_COPY_CONTROL.className).toBe(SITE_NAME_COPY_CLASS);
  });

  it("activate with Enter and Space like every other icon action", () => {
    expect(titleCopyIsKeyboardActivatable("Enter")).toBe(true);
    expect(titleCopyIsKeyboardActivatable(" ")).toBe(true);
    expect(titleCopyIsKeyboardActivatable("a")).toBe(false);
  });

  it("builds an absolute share URL, and a root-relative one during SSR", () => {
    expect(articleUrl("http://localhost:3001", 53)).toBe(
      "http://localhost:3001/post/53"
    );
    expect(articleUrl("https://blog.example.com", "my-slug")).toBe(
      "https://blog.example.com/post/my-slug"
    );
    // The origin is unknown while server-rendering; the path still works.
    expect(articleUrl("", 53)).toBe("/post/53");
  });
});

describe("article / about title markup", () => {
  const title = readSrc("components/PostCard/title.tsx");

  it("keeps titles selectable instead of select-none", () => {
    expect(TITLE_SELECTABLE_CLASS).toBe("select-text");
    expect(title).not.toMatch(/select-none/);
    // 文章标题与关于页标题两处都要可选中
    expect(title.match(/TITLE_SELECTABLE_CLASS/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("renders copy-title and copy-link buttons next to the title", () => {
    expect(title).toMatch(/TITLE_COPY_CLASS/);
    expect(title).toMatch(/TITLE_LINK_COPY_CLASS/);
    expect(title).toMatch(/CopyToClipboard/);
    expect(title).toMatch(/aria-label=\{[^}]*(TITLE_COPY_LABEL|SITE_NAME_COPY_LABEL)\}/);
    expect(title).toMatch(/aria-label=\{TITLE_LINK_COPY_LABEL\}/);
    expect(title).toMatch(/type="button"/);
    // 复制链接用绝对地址，SSR 阶段先拿到 origin
    expect(title).toMatch(/articleUrl\(origin, props\.id\)/);
    expect(title).toMatch(/location\.protocol/);
  });

  it("reveals the actions on hover and on keyboard focus", () => {
    expect(title).toMatch(/group\/title/);
    expect(title).toMatch(/md:group-hover\/title:opacity-100/);
    expect(title).toMatch(/md:group-focus-within\/title:opacity-100/);
    // 触屏没有 hover，小屏保持可见
    expect(title).toMatch(/opacity-100 md:opacity-0/);
  });
});

describe("navbar site name markup", () => {
  const nav = readSrc("components/NavBar/index.tsx");
  // 只针对站点名两处；导航栏里的图标按钮本来就带 select-none
  const siteNameLines = nav
    .split("\n")
    .filter(
      (line) =>
        line.includes("className") &&
        (line.includes("NAV_SITE_NAME_MOBILE_CLASS") ||
          line.includes("NAV_SITE_NAME_DESKTOP_CLASS"))
    );

  it("is selectable on both mobile and desktop", () => {
    expect(siteNameLines.length).toBeGreaterThanOrEqual(2);
    for (const line of siteNameLines) {
      expect(line).not.toMatch(/select-none/);
      expect(line).toMatch(/select-text/);
    }
  });

  it("offers a copy button with an accessible name", () => {
    expect(nav).toMatch(/SITE_NAME_COPY_CLASS/);
    expect(nav).toMatch(/aria-label=\{SITE_NAME_COPY_LABEL\}/);
    expect(nav).toMatch(/CopyToClipboard/);
    expect(nav).toMatch(/group\/site-name/);
    // 桌面端站点名仍然是回首页的链接
    expect(nav).toMatch(/data-nav-site-name=\{NAV_SITE_NAME_DESKTOP\}/);
  });
});
