import { spawnSync } from 'child_process';
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export const CWEBP_QUALITY = '80';

export function buildCwebpArgv(inputPath: string, outputPath: string): string[] {
  return ['-q', CWEBP_QUALITY, inputPath, '-o', outputPath];
}

export function runCwebp(inputPath: string, outputPath: string) {
  const result = spawnSync('cwebp', buildCwebpArgv(inputPath, outputPath), {
    encoding: 'buffer',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString?.() || '';
    throw new Error(stderr || `cwebp exited with status ${result.status}`);
  }
  return result;
}

export const compressImgToWebp = async (srcImage: Buffer) => {
  // 以前是 `/tmp/temp${Date.now()}`，而且**没有 finally**：
  // cwebp 一失败（例如上传的根本不是图片）整块 buffer 就永久留在 /tmp，
  // 反复上传即可写满磁盘；同毫秒并发还会互相覆盖，writeFileSync 也会跟随符号链接。
  const dir = mkdtempSync(join(tmpdir(), 'vanblog-webp-'));
  const p = join(dir, 'in');
  const o = join(dir, 'out.webp');
  try {
    writeFileSync(p, srcImage, { mode: 0o600, flag: 'wx' });
    await runCwebp(p, o);
    return readFileSync(o);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
