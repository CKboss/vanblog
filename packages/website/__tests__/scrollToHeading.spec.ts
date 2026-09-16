import { describe, it, expect } from "vitest";
import {
  headingScrollTop,
  scrollElUntilSettled,
  waitForNavEl,
} from "../components/MarkdownTocBar/scrollToHeading";
import { NavItem } from "../components/MarkdownTocBar/tools";

const item: NavItem = {
  index: 3,
  level: 2,
  listNo: "4",
  text: "4. 配置DHCP引导选项",
};

describe("headingScrollTop", () => {
  it("subtracts the heading offset", () => {
    expect(headingScrollTop({ offsetTop: 400 } as HTMLElement, 56)).toBe(344);
  });

  it("snaps near the top of the page to 0", () => {
    expect(headingScrollTop({ offsetTop: 80 } as HTMLElement, 0)).toBe(0);
  });
});

describe("scrollElUntilSettled", () => {
  it("re-scrolls when heading offsetTop grows after images load", async () => {
    // HTMLElement.offsetTop 是只读的（TS2540），而本用例恰恰要在 waitFrame 里改写它
    // 模拟「图片加载后标题位置变低」。替身保持普通对象（可写），只在调用处断言一次
    // 当作 HTMLElement 传入 —— scrollElUntilSettled 对 el 只读 offsetTop，行为不变。
    const el = { offsetTop: 240 };
    const jumps: number[] = [];
    let t = 0;
    let scrollY = 0;
    await scrollElUntilSettled(el as HTMLElement, 0, {
      initialDuration: 0,
      settleMs: 200,
      now: () => t,
      getScrollY: () => scrollY,
      waitFrame: async () => {
        t += 20;
        if (t === 40) {
          el.offsetTop = 2400;
        }
      },
      jump: async (top) => {
        jumps.push(top);
        scrollY = top;
      },
    });
    expect(jumps.some((top) => top >= 2300)).toBe(true);
    expect(scrollY).toBe(2400);
  });
});

describe("waitForNavEl", () => {
  it("returns immediately when the heading is already in the DOM", async () => {
    const el = { id: "present" } as HTMLElement;
    const result = await waitForNavEl(item, [item], {
      getElement: () => el,
      observe: () => () => {},
    });
    expect(result).toBe(el);
  });

  it("resolves when a heading appears after layout observers fire", async () => {
    let el: HTMLElement | undefined;
    const fakeEl = { id: "heading" } as HTMLElement;
    const observers: Array<() => void> = [];
    const pending = waitForNavEl(item, [item], {
      getElement: () => el,
      observe: (cb) => {
        observers.push(cb);
        return () => {};
      },
      timeoutMs: 1000,
    });
    queueMicrotask(() => {
      el = fakeEl;
      observers.forEach((cb) => cb());
    });
    await expect(pending).resolves.toBe(fakeEl);
  });
});
