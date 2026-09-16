import { useState } from 'react';

// 老版本首页三个统计 tab 调 useNum 时都不传 token，key 一律是
// `van-blog-admin-num-undefined` —— 三个 tab 共用一份数字，在「概览」里把
// 近 7 天改成近 30 天，「文章」「访客」tab 的条数也会跟着变。
// 现在每个调用方都带唯一 token；这里把老 key 的值一次性搬到三个新 key 上
// （只在新 key 还没有值时），再删掉老 key，保证用户以前选的数字不丢，
// 同时也不会影响文章/草稿列表各自的每页条数。
const LEGACY_SHARED_KEY = 'van-blog-admin-num-undefined';
const WELCOME_NUM_TOKENS = ['welcome-overview', 'welcome-viewer', 'welcome-article'];

try {
  const legacy = window.localStorage.getItem(LEGACY_SHARED_KEY);
  if (legacy !== null) {
    for (const token of WELCOME_NUM_TOKENS) {
      const key = `van-blog-admin-num-${token}`;
      if (window.localStorage.getItem(key) === null) {
        window.localStorage.setItem(key, legacy);
      }
    }
    window.localStorage.removeItem(LEGACY_SHARED_KEY);
  }
} catch (err) {
  // localStorage 不可用（隐私模式 / 被禁用）时用默认值就行，别把页面搞崩
}

export const useNum = (defaultNum, token) => {
  const key = `van-blog-admin-num-${token}`;
  // 获取 localstroge 的
  // ⚠️ parseInt 必须做 NaN 守卫：localStorage 里的值可以被写坏（旧版本 bug、
  // 手改、别的代码写入了非数字），NaN 会一路流进分页组件（pageSize=NaN）
  // 和图表的条数选择器，症状是"每页 NaN 条"这种很难归因的界面。
  let localData = defaultNum;
  try {
    localData = window.localStorage.getItem(key) || defaultNum;
  } catch (err) {
    localData = defaultNum; // 隐私模式 / 被禁用的 localStorage
  }
  const parsed = parseInt(localData, 10);
  const [num, setNum] = useState(Number.isFinite(parsed) ? parsed : defaultNum);
  return [
    num,
    (newNum) => {
      const next = parseInt(newNum, 10);
      if (!Number.isFinite(next)) {
        return; // 不把 NaN 写进 state / storage
      }
      try {
        window.localStorage.setItem(key, String(next));
      } catch (err) {
        // 存不进去只影响"下次打开还记得"，不影响本次
      }
      setNum(next);
    },
  ];
};
