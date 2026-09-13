export const useEditorCache = (key) => {
  const getCache = () => {
    // 少了 return：getCache() 永远返回 undefined，读缓存的一方拿到的都是空值
    return window.localStorage.getItem(key);
  };
  const setCache = (val) => {
    window.localStorage.setItem(key, val);
  };
  return [getCache, setCache];
};
