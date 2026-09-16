import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { startWalineSession, type WalineInitBase } from "../components/WaLine/lifecycle";

/**
 * waline 会话生命周期。
 *
 * 旧实现（core.tsx 里 useRef(hasInit) + useEffect([current, props])）有三个叠加缺陷：
 * 1. 依赖是 props **对象**：父组件任何一次重渲染 → cleanup → destroy 评论组件；
 * 2. hasInit 门闩：cleanup 之后不再 init —— 销毁了就永远回不来（评论区静默空白）；
 * 3. 异步竞态：loadCommentSetting 在飞的时候发生一次重渲染 → cancelled=true，
 *    随后 resolve 的 init 被跳过，而门闩已落下 → 这个页面上 waline 永不初始化。
 * 现在生命周期抽成纯函数 startWalineSession，组件只依赖 (enabled, visible) 两个值。
 */
function makeDeps(overrides: Partial<Parameters<typeof startWalineSession>[0]> = {}) {
  const log: string[] = [];
  let resolveSetting: (v: Record<string, unknown>) => void = () => undefined;
  const settingPromise = new Promise<Record<string, unknown>>((r) => {
    resolveSetting = r;
  });
  const instance = {
    destroyed: 0,
    destroy() {
      this.destroyed += 1;
      log.push("destroy");
    },
  };
  let cancelCalls = 0;
  const deps = {
    visible: true,
    serverURL: "https://blog.example",
    loadSetting: () => {
      log.push("loadSetting");
      return settingPromise;
    },
    buildOptions: (setting: Record<string, unknown>) => {
      log.push("buildOptions");
      return { login: "enable" as const, ...(setting as object) } as Record<string, string>;
    },
    init: (
      base: WalineInitBase,
      extra: Record<string, string | boolean | number>,
    ) => {
      log.push(`init:${JSON.stringify({ ...base, ...extra })}`);
      return instance;
    },
    commentCount: (options: Record<string, unknown>) => {
      log.push(`commentCount:${JSON.stringify(options)}`);
      return () => {
        cancelCalls += 1;
        log.push("cancelCount");
      };
    },
    ...overrides,
  };
  return { deps, log, instance, resolveSetting, cancelCalls: () => cancelCalls };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("startWalineSession：文章页（visible=true）", () => {
  it("先取设置再 init，参数带 el/serverURL 与设置展开", async () => {
    const { deps, log, resolveSetting } = makeDeps();
    startWalineSession(deps);
    resolveSetting({ lang: "en" });
    await tick();
    await tick();
    expect(log[0]).toBe("loadSetting");
    expect(log).toContain("buildOptions");
    const initLine = log.find((l) => l.startsWith("init:"));
    expect(initLine).toBeTruthy();
    const options = JSON.parse((initLine as string).slice("init:".length));
    expect(options.el).toBe("#waline");
    expect(options.serverURL).toBe("https://blog.example");
    expect(options.comment).toBe(true);
    expect(options.pageview).toBe(false);
    expect(options.lang).toBe("en"); // 设置里的值覆盖默认的 zh
  });

  it("teardown 会 destroy 实例，且幂等", async () => {
    const { deps, instance, resolveSetting } = makeDeps();
    const teardown = startWalineSession(deps);
    resolveSetting({});
    await tick();
    await tick();
    expect(instance.destroyed).toBe(0);
    teardown();
    teardown();
    expect(instance.destroyed).toBe(1);
  });

  it("设置在飞时 teardown：init 根本不会发生（旧实现里这是「永不初始化」竞态的另一半）", async () => {
    const { deps, log, instance, resolveSetting } = makeDeps();
    const teardown = startWalineSession(deps);
    teardown(); // 还没 resolve 就拆
    resolveSetting({});
    await tick();
    await tick();
    expect(log.some((l) => l.startsWith("init:"))).toBe(false);
    expect(instance.destroyed).toBe(0);
  });

  it("设置接口失败：按默认值继续 init（不能把评论区整个搞没）", async () => {
    const { deps, log } = makeDeps({
      loadSetting: async () => {
        throw new Error("setting down");
      },
    });
    startWalineSession(deps);
    await tick();
    await tick();
    const initLine = log.find((l) => l.startsWith("init:"));
    expect(initLine).toBeTruthy();
    const options = JSON.parse((initLine as string).slice("init:".length));
    expect(options.lang).toBe("zh"); // 默认值
  });
});

describe("startWalineSession：列表页隐形实例（visible=false）", () => {
  it("只调 commentCount，teardown 调它返回的取消函数", async () => {
    const { deps, log, cancelCalls } = makeDeps({ visible: false });
    const teardown = startWalineSession(deps);
    expect(log.some((l) => l.startsWith("commentCount:"))).toBe(true);
    expect(log.some((l) => l.startsWith("init:"))).toBe(false);
    teardown();
    expect(cancelCalls()).toBe(1);
    teardown(); // 幂等
    expect(cancelCalls()).toBe(1);
  });
});

describe("接线：core.tsx 只按 (enabled, visible) 两个值管理会话", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
  const strip = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l))
      .join("\n");

  it("effect 依赖是值而不是 props 对象，且没有 hasInit 门闩", () => {
    const src = strip(read("components/WaLine/core.tsx"));
    expect(src).toContain("startWalineSession");
    expect(src).toMatch(/\}, \[enabled, visible\]\);/);
    expect(src).not.toContain("hasInit");
    // 不能再把 props 对象整个放进依赖（父组件重渲染就会拆评论区）
    expect(src).not.toMatch(/\}, \[current, props\]\);/);
  });
});
