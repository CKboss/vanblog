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
  const localData = window.localStorage.getItem(key) || defaultNum;
  const [num, setNum] = useState(parseInt(localData));
  return [
    num,
    (newNum) => {
      window.localStorage.setItem(key, newNum);
      setNum(newNum);
    },
  ];
};
