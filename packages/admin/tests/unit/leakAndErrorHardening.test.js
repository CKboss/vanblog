const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const adminRoot = path.join(__dirname, '../..');
const read = (rel) => readFileSync(path.join(adminRoot, rel), 'utf8');

// 断言前剔除注释：新写的注释里经常引用旧写法（不然看不出「以前错在哪」），
// 不剔除的话断言会匹配到注释自己（本仓库踩过 10+ 次的坑）。
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');
}

describe('日志查看器：拉取失败不再静默', () => {
  const src = codeOnly(read('src/pages/LogManage/tabs/System.tsx'));

  it('没有空 catch（旧实现 catch(err){} + 空 finally，失败页面无感知、控制台无痕迹）', () => {
    assert.ok(!/catch \(err\) \{\s*\}/.test(src), '还存在空 catch');
    assert.ok(src.includes("console.error('[系统日志] 拉取失败'"));
    assert.ok(src.includes('setError('));
  });

  it('失败状态渲染成 Alert（请求失败 ≠ 没有日志）', () => {
    assert.ok(src.includes('<Alert'));
    assert.ok(src.includes('日志拉取失败'));
  });

  it('reverse() 前先浅拷贝（不再原地改接口返回的数组），data.data 缺失回空数组', () => {
    assert.ok(src.includes('lines.slice().reverse()'));
    assert.ok(src.includes('Array.isArray(data?.data)'));
  });

  it('5s 轮询有清理（这一条旧实现就是对的，钉住防回归）', () => {
    assert.ok(src.includes('setInterval(fetchLog, 5000)'));
    assert.ok(src.includes('clearInterval(timerRef.current)'));
  });
});

describe('图片管理：删除失败不再把整页卡在 Spin 里', () => {
  const src = codeOnly(read('src/pages/Static/img/index.tsx'));

  it('deleteImg 的 setLoading(false) 在 finally 里', () => {
    const start = src.indexOf('async function deleteImg');
    assert.notEqual(start, -1);
    const end = src.indexOf('fetchData();', start);
    const fn = src.slice(start, end);
    assert.ok(fn.includes('} finally {'), '缺少 finally');
    assert.ok(fn.includes('setLoading(false);'), 'finally 里没有 setLoading(false)');
    // 成功路径里不能再有第二个 setLoading(false)（finally 统一收尾）
    const occurrences = fn.split('setLoading(false);').length - 1;
    assert.equal(occurrences, 1);
  });
});

describe('useNum：localStorage 里的坏值不再流出 NaN', () => {
  const src = codeOnly(read('src/services/van-blog/useNum.js'));

  it('读取有 NaN 守卫，写入拒绝非数字', () => {
    assert.ok(src.includes('Number.isFinite(parsed)'));
    assert.ok(src.includes('if (!Number.isFinite(next)) {'));
    assert.ok(src.includes('parseInt(localData, 10)'));
  });

  it('localStorage 读写都包了 try/catch（隐私模式不能把页面搞崩）', () => {
    const hookStart = src.indexOf('export const useNum');
    const hook = src.slice(hookStart);
    assert.ok(hook.includes('try {'));
    assert.ok(hook.includes('window.localStorage.getItem(key)'));
    assert.ok(hook.includes('window.localStorage.setItem(key, String(next))'));
  });
});

describe('ThemeButton：自动主题的 10s 轮询不再是死功能', () => {
  const src = codeOnly(read('src/components/ThemeButton/index.tsx'));

  it('轮询 effect 只依赖 theme 值（旧依赖含每次渲染新建的 setTimer/clearTimer 闭包）', () => {
    assert.match(src, /\}, \[theme\]\);/);
    assert.ok(!src.includes('[current, clearTimer, theme, setTimer]'));
    assert.ok(!src.includes('hasInit'));
  });

  it('setInitialState 用函数式更新（定时器闭包里的 initialState 是旧快照）', () => {
    assert.ok(src.includes('setInitialState((prev: any) => ({'));
  });
});

describe('Code / Editor 页：Ctrl+S 监听不再每敲一键重注册一轮', () => {
  it('Code 页：keydown 监听只注册一次，handleSave 走 ref', () => {
    const src = codeOnly(read('src/pages/Code/index.tsx'));
    assert.ok(src.includes('handleSaveRef.current = handleSave;'));
    assert.ok(!src.includes('}, [currObj, value, type]);'));
    // 监听 effect 的依赖是空的（注册一次）
    const m = src.match(
      /window\.addEventListener\('keydown', onKeyDown\);[\s\S]*?\}, (\[[^\]]*\])\);/,
    );
    assert.ok(m, '找不到 keydown 监听注册块');
    assert.equal(m[1], '[]');
  });

  it('Editor 页：同样只注册一次', () => {
    const src = codeOnly(read('src/pages/Editor/index.jsx'));
    assert.ok(src.includes('handleSaveRef.current = handleSave;'));
    assert.ok(src.includes('handleSaveRef.current();'));
    assert.ok(!src.includes('}, [currObj, value, type]);'));
  });

  it('Code 页：updateEditorSize 对查不到的页头有守卫，两个 setTimeout 有清理', () => {
    const src = codeOnly(read('src/pages/Code/index.tsx'));
    const start = src.indexOf('const updateEditorSize');
    const end = src.indexOf('const handleSaveRef', start);
    const fn = src.slice(start, end);
    assert.ok(fn.includes('if (!el) {'));
    assert.ok(src.includes('clearTimeout(menuTimerRef.current)'));
    assert.ok(src.includes('clearTimeout(mountTimerRef.current)'));
  });
});

describe('系统设置：数字表单字段在表单层就有下限（不让坏值直达 server）', () => {
  const src = codeOnly(read('src/pages/SystemConfig/tabs/Advance.jsx'));

  it('Token 有效期（直接进 JWT expiresIn）有 min=60 且只收整数', () => {
    const start = src.indexOf("name={'expiresIn'}");
    assert.notEqual(start, -1);
    const block = src.slice(start, src.indexOf('/>', start));
    assert.ok(block.includes('min={60}'), 'expiresIn 缺少 min={60}');
    assert.ok(block.includes('precision: 0'), 'expiresIn 缺少整数约束');
  });

  it('ISR 延时秒数有 min=1 且只收整数（前端另有 60s 下限兜底）', () => {
    const start = src.indexOf("name={'delay'}");
    assert.notEqual(start, -1);
    const block = src.slice(start, src.indexOf('/>', start));
    assert.ok(block.includes('min={1}'), 'delay 缺少 min={1}');
    assert.ok(block.includes('precision: 0'), 'delay 缺少整数约束');
  });
});

describe('表情选择器：按容器渲染 + editorEffect 有清理', () => {
  const src = codeOnly(read('src/components/Editor/emoji.tsx'));

  it('缓存的是 import() 的模块，不是绑定在首个容器上的渲染 promise', () => {
    // 旧实现的 pickerPromise 渲染进的是第一个编辑器的容器：SPA 里第二次打开
    // 编辑器（新 DOM）时它已存在，ensurePicker 直接返回旧 promise，
    // 新容器里永远不会有 Picker —— 表情按钮从第二个会话起静默失灵。
    assert.ok(src.includes('function loadEmojiMods'), '缺少模块级 loadEmojiMods');
    assert.ok(!src.includes('pickerPromise'), '不允许再出现绑定单容器的 pickerPromise');
    assert.ok(src.includes("container.getAttribute('data-emoji-ready') === 'true'"));
    // 每个容器渲染后各自打标记
    assert.ok(src.includes("container.setAttribute('data-emoji-ready', 'true')"));
  });

  it('editorEffect 返回清理：重置 currentEditor、unmount Picker、摘掉容器与全局监听', () => {
    const start = src.indexOf('editorEffect: (ctx) =>');
    assert.notEqual(start, -1);
    const fn = src.slice(start);
    assert.ok(fn.includes('currentEditor = null'), '清理里没有重置 currentEditor');
    assert.ok(fn.includes('unmountComponentAtNode(targetEl)'), '清理里没有 unmount Picker');
    assert.ok(fn.includes("document.removeEventListener('click', handleClick)"), '清理里没有摘全局 click 监听');
    assert.ok(fn.includes('targetEl.parentNode.removeChild(targetEl)'), '清理里没有摘容器节点');
    assert.ok(src.includes("import { render, unmountComponentAtNode } from 'react-dom'"));
  });
});
