import { existsSync, readFileSync } from "fs";
import path from "path";
import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../..");
const websiteDir = path.join(repoRoot, "packages/website");
const serverDir = path.join(repoRoot, "packages/server");

/**
 * 读某个包里**已安装**的 package.json。
 *
 * ⚠️ 不能用 `require.resolve('sharp/package.json')`：sharp 0.33+ 的 `exports` 只导出 `"."`，
 * 子路径会被 Node 直接拒掉（ERR_PACKAGE_PATH_NOT_EXPORTED）。本 spec 的旧版本就是这么写的，
 * 升级 sharp 之后两条用例当场报 "Package subpath './package.json' is not defined by exports"。
 */
function installedPackageJson(pkgDir: string, name: string) {
  const p = path.join(pkgDir, "node_modules", name, "package.json");
  if (!existsSync(p)) {
    return null;
  }
  return JSON.parse(readFileSync(p, "utf8")) as {
    version: string;
    scripts?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
}

/** "0.35.4" >= "0.33.0"：只按数字段比，测试里不引运行时依赖 */
function atLeast(version: string, floor: string): boolean {
  const a = version.split(".").map((n) => Number(n) || 0);
  const b = floor.split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true;
}

describe("sharp 的安装方式（#413 那一类问题必须结构性消失）", () => {
  // #413 的原始故障：Alpine（musl）上 sharp 的**安装脚本** install/libvips.js 会把
  // detectLibc 读到的 musl 版本号（形如 `1.2.4_git20230717`）喂给 `semver.lt(...)`，
  // 而那不是合法 semver ⇒ 抛 `Invalid Version`，镜像构建直接失败。
  // 当时的修法是把 sharp 钉死在 0.32.6（那一版上游脚本里加了 semverCoerce 兜底），
  // 也就是**靠钉版本绕过一个安装脚本的 bug**，代价是 libvips/libheif 的一堆 CVE 只能干看着。
  //
  // sharp 0.33 起这套东西整个没了：预编译二进制改成 npm 的 optionalDependencies
  // （`@img/sharp-<平台>` + `@img/sharp-libvips-<平台>`），装包时**不下载 libvips、
  // 不跑任何 install 脚本**，于是"musl 版本号不是合法 semver"这条路径根本不存在。
  // 所以本 spec 的职责从"钉住 0.32.6"改成"钉住 0.33+ 的那几个结构性事实"。

  it("两个包声明的 sharp 都 >= 0.33（预编译改走 optionalDependencies 的起点）", () => {
    for (const [label, dir] of [
      ["website", websiteDir],
      ["server", serverDir],
    ] as const) {
      const pkg = JSON.parse(
        readFileSync(path.join(dir, "package.json"), "utf8"),
      ) as { dependencies: Record<string, string> };
      const spec = pkg.dependencies.sharp;
      expect(spec, `${label} 必须依赖 sharp`).toBeTruthy();
      const digits = spec.replace(/[^0-9.]/g, "");
      expect(
        atLeast(digits, "0.33.0"),
        `${label} 的 sharp 是 ${spec}；低于 0.33 就还带着会在 Alpine 上崩的安装脚本`,
      ).toBe(true);
    }
  });

  it("装好的 sharp 没有任何 install/preinstall/postinstall 脚本", () => {
    const sharpPkg = installedPackageJson(websiteDir, "sharp");
    expect(sharpPkg, "website 下应该能读到已安装的 sharp").not.toBeNull();
    const scripts = sharpPkg!.scripts || {};
    for (const hook of ["install", "preinstall", "postinstall"]) {
      expect(scripts[hook], `sharp 不该再有 ${hook} 脚本`).toBeUndefined();
    }
  });

  it("0.32 时代那个会抛 Invalid Version 的 install/libvips.js 已经不存在", () => {
    const sharpDir = path.join(websiteDir, "node_modules/sharp");
    expect(existsSync(sharpDir)).toBe(true);
    expect(existsSync(path.join(sharpDir, "install/libvips.js"))).toBe(false);
    expect(existsSync(path.join(sharpDir, "lib/libvips.js"))).toBe(false);
  });

  it("Alpine 需要的 musl 预编译包在 optionalDependencies 里（镜像里靠它，不靠下载）", () => {
    const sharpPkg = installedPackageJson(websiteDir, "sharp");
    const opt = sharpPkg!.optionalDependencies || {};
    // 运行镜像是 node:20-alpine（musl x64）：这两个缺一个，容器里 sharp 就加载不起来
    expect(opt["@img/sharp-linuxmusl-x64"], "缺 musl 的 sharp 预编译包").toBeTruthy();
    expect(
      opt["@img/sharp-libvips-linuxmusl-x64"],
      "缺 musl 的 libvips 预编译包",
    ).toBeTruthy();
    // 本机（glibc）那两个也要在，否则本地测试没法验证 sharp 真的可用
    expect(opt["@img/sharp-linux-x64"]).toBeTruthy();
    expect(opt["@img/sharp-libvips-linux-x64"]).toBeTruthy();
  });

  it("lockfile 里不再出现 0.31.3 / 0.32.x（那两版都带会崩的安装脚本）", () => {
    const lock = readFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "utf8");
    expect(lock).not.toMatch(/sharp@0\.31\.3/);
    expect(lock).not.toMatch(/sharp@0\.32\./);
    expect(lock).toMatch(/sharp@0\.3[3-9]\./);
  });

  it("装好的 sharp 真的能编解码（平台预编译包确实被解析并加载了）", () => {
    // 只断言版本号对是不够的：平台预编译包是 optionalDependencies，
    // 装不上时 npm/pnpm 只 warn 不 fail，要到第一次 require 才炸 —— 那正是镜像里最难查的一类故障。
    const requireFromWebsite = createRequire(path.join(websiteDir, "package.json"));
    const sharp = requireFromWebsite("sharp") as (input: unknown) => {
      webp: (o: { quality: number }) => { toBuffer: () => Promise<Buffer> };
      metadata: () => Promise<{ format?: string; width?: number; height?: number }>;
    };
    return sharp({
      create: { width: 32, height: 24, channels: 3, background: { r: 12, g: 200, b: 90 } },
    })
      .webp({ quality: 70 })
      .toBuffer()
      .then((buf) => {
        expect(buf.length).toBeGreaterThan(0);
        return sharp(buf).metadata();
      })
      .then((meta) => {
        expect(meta.format).toBe("webp");
        expect(meta.width).toBe(32);
        expect(meta.height).toBe(24);
      });
  });
});
