import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  __setImageZoomFactoryForTest,
  attachImageZoom,
  getSharedImageZoom,
  sharedImageZoomCreated,
  type ZoomLike,
} from "../utils/imageZoom";

/**
 * medium-zoom 的实例一旦创建，就会在 document/window 上挂 4 个**无法移除**的
 * 全局监听（click/keyup/scroll/resize，detach() 只摘图片不摘监听，
 * medium-zoom@1.1.0 源码里实例尾部是无条件的 4 个 addEventListener）。
 * 所以「每张图一个实例 + 没有清理」的旧写法是一个按导航次数线性增长的泄漏；
 * 这个 spec 钉住新契约：全站单例 + 挂载 attach / 卸载 detach。
 */
function makeFakeZoom() {
  const state = {
    instances: 0,
    attached: [] as unknown[],
    detached: [] as unknown[],
  };
  const factory = (): ZoomLike => {
    state.instances += 1;
    return {
      attach(el: unknown) {
        state.attached.push(el);
        return el;
      },
      detach(el: unknown) {
        state.detached.push(el);
        return el;
      },
    };
  };
  return { state, factory };
}

// 让 imageZoom 认为自己在浏览器里（它只检查 window/document 是否存在）
const g = globalThis as Record<string, unknown>;
const hadWindow = "window" in g;
const hadDocument = "document" in g;
if (!hadWindow) {
  g.window = {};
}
if (!hadDocument) {
  g.document = {};
}

afterEach(() => {
  __setImageZoomFactoryForTest(null);
});

describe("utils/imageZoom：全站单例", () => {
  it("无论 attach 多少张图，实例只创建一次", () => {
    const { state, factory } = makeFakeZoom();
    __setImageZoomFactoryForTest(factory);
    for (let i = 0; i < 300; i += 1) {
      attachImageZoom({ id: i });
    }
    expect(state.instances).toBe(1);
    expect(state.attached).toHaveLength(300);
    expect(sharedImageZoomCreated()).toBe(true);
    expect(getSharedImageZoom()).toBeTruthy();
  });

  it("detach 函数把图从实例里摘出来，且幂等、不抛", () => {
    const { state, factory } = makeFakeZoom();
    __setImageZoomFactoryForTest(factory);
    const img = { id: 1 };
    const detach = attachImageZoom(img);
    detach();
    detach();
    expect(state.detached).toEqual([img]);
    // detach 内部抛错也不能冒出来（清理阶段）
    __setImageZoomFactoryForTest(() => ({
      attach: () => undefined,
      detach: () => {
        throw new Error("boom");
      },
    }));
    const throwing = attachImageZoom({});
    expect(() => throwing()).not.toThrow();
  });

  it("模拟 200 次「文章页导航」：监听器数量是常数，不随导航增长", () => {
    const { state, factory } = makeFakeZoom();
    __setImageZoomFactoryForTest(factory);
    // 每页 10 张图 + ImageBox 2 张；旧实现是每次导航新建 12 个实例（= 48 个全局监听）
    for (let nav = 0; nav < 200; nav += 1) {
      const detachers: Array<() => void> = [];
      for (let i = 0; i < 12; i += 1) {
        detachers.push(attachImageZoom({ nav, i }));
      }
      detachers.forEach((d) => d()); // 页面卸载
    }
    expect(state.instances).toBe(1);
    expect(state.attached).toHaveLength(2400);
    expect(state.detached).toHaveLength(2400);
  });
});

describe("接线：调用方都走单例并返回清理", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
  const strip = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l))
      .join("\n");

  it("img.tsx 的 viewerEffect 用 attachImageZoom 并返回清理函数", () => {
    const src = strip(read("components/Markdown/img.tsx"));
    expect(src).toContain('import { attachImageZoom } from "../../utils/imageZoom"');
    expect(src).toContain("detachers.push(attachImageZoom(img))");
    expect(src).toMatch(/return \(\) => \{\s*detachers\.forEach\(\(detach\) => detach\(\)\)/);
    // 旧的每图一个实例写法必须死透
    expect(src).not.toMatch(/\bm\(img\)/);
    expect(src).not.toContain('from "medium-zoom"');
  });

  it("ImageBox 把 attachImageZoom 的返回值直接当 effect 清理", () => {
    const src = strip(read("components/ImageBox/index.tsx"));
    expect(src).toContain('import { attachImageZoom } from "../../utils/imageZoom"');
    expect(src).toContain("return attachImageZoom(imgRef.current)");
    expect(src).not.toContain('from "medium-zoom"');
    // 不能再有 hasInit 门闩（有清理函数的 effect + 门闩 = StrictMode 下永不重挂）
    expect(src).not.toContain("hasInit");
  });

  it("仓库里不再有人直接 import medium-zoom（只能走 utils/imageZoom 单例）", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".next") continue;
          walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name) && !full.includes("__tests__")) {
          const src = strip(readFileSync(full, "utf8"));
          if (/from ["']medium-zoom["']/.test(src) && !full.endsWith("utils/imageZoom.ts")) {
            offenders.push(full);
          }
        }
      }
    };
    walk(join(__dirname, ".."));
    expect(offenders).toEqual([]);
  });
});
