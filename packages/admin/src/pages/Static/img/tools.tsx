import { writeClipBoardText } from '@/services/van-blog/clipboard';
import { message } from 'antd';
import { StaticItem } from '../type';

/**
 * 🔴 多语言：**注入式翻译器**（与 `components/RecycleBin/recycleCore.js`、`InitPage/restoreCore.js` 同一套模式）。
 *
 * ## 为什么不是在这里 import umi
 * 本模块是**纯函数集合**（不是组件），而且被 `Editor/imgUpload.tsx` 等非组件代码调用；
 * 在模块加载期 `getIntl()` 会拿到 undefined（umi 插件运行时还没初始化）。所以翻译器由**调用方在渲染期注入**。
 *
 * ## 🔴 不传 t 时的行为：与改造前**逐字相同**
 * 每个函数都默认落到 `IDENTITY_T`：它拿 `t()` 的**第二个实参（defaultMessage）**做 `{k}` 插值。
 * ⇒ 中文文案在源码里**只有一份**（就是那个 defaultMessage 字面量），不是"一份给 t()、一份给 identity 路径"。
 * 🔴 所以既有的调用方（`Editor/imgUpload.tsx` 那处 `copyImgLink(src, true, '上传成功！ ')`）**一个字都不用改**，
 * 输出与今天逐字相同 —— 这是本批最重要的兼容性证据。
 */
function interpolate(template: any, values?: Record<string, any>) {
  if (!values) return String(template);
  return String(template).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
  );
}

/** 不传翻译器时的回落：把 defaultMessage 当成中文模板直接插值（`{k}` 语法与 react-intl 一致）。 */
export const IDENTITY_T = (id: string, defaultMessage: string, values?: Record<string, any>) =>
  interpolate(defaultMessage, values);
export const getImgLink = (realPath, autoCompleteHost = true) => {
  let url = realPath;
  if (realPath.includes('http://') || realPath.includes('https://')) {
    url = realPath;
  } else {
    if (autoCompleteHost) {
      url = `${window.location.protocol}//${window.location.host}${realPath}`;
    }
  }
  url = url.replace(/\)/g, '%29');
  url = url.replace(/\(/g, '%28');
  return url;
};
export const copyImgLink = (
  realPath,
  isMarkdown = false,
  info = undefined,
  autoCompleteHost = true,
  // 🔴 第 5 个参数才是翻译器：既有调用方（含 Editor/imgUpload.tsx）不传 ⇒ 落到 IDENTITY_T ⇒ 逐字与改造前相同
  t: (id: string, defaultMessage: string, values?: Record<string, any>) => string = IDENTITY_T,
) => {
  let url = getImgLink(realPath, autoCompleteHost);
  if (isMarkdown) {
    url = `![](${url})`;
  }
  writeClipBoardText(url).then((res) => {
    if (res) {
      // 🔴 原来是一条"三目拼出来的句子"（`已复制${isMarkdown ? ' markdown ' : '图片'}链接…`）：
      //    那种形状**没法翻**（英文的语序不一样）⇒ 拆成两个完整句子的 key，`{prefix}` 放调用方给的前缀。
      message.success(
        isMarkdown
          ? t('img.copiedMarkdown', '{prefix}已复制 markdown 链接到剪切板！', { prefix: info ? info : '' })
          : t('img.copiedLink', '{prefix}已复制图片链接到剪切板！', { prefix: info ? info : '' }),
      );
    } else {
      message.error(t('img.copyFailed', '{prefix}复制链接到剪切板失败！', { prefix: info ? info : '' }));
    }
  });
};
export const mergeMetaInfo = (
  item: StaticItem,
  // 🔴 同样注入式：不传 t 时下面每个 label 都落到 defaultMessage ⇒ 与改造前逐字相同
  t: (id: string, defaultMessage: string, values?: Record<string, any>) => string = IDENTITY_T,
) => {
  // ⚠️ 这三个 label 与列表的列头是**同一个性质**（格式 / 名称 / 大小）⇒ 复用同一个 key，不新增同值第二处
  const Dic = {
    type: t('img.colFormat', '格式'),
    height: t('img.meta.height', '高'),
    width: t('img.meta.width', '宽'),
    name: t('common.colName', '名称'),
    sign: 'md5',
    storageType: t('img.meta.storageType', '存储'),
    url: t('img.meta.url', '外链'),
    size: t('img.colBytes', '大小'),
    thumb: t('img.meta.thumb', '缩略图'),
    thumbWidth: t('img.meta.thumbWidth', '缩略图宽'),
    thumbHeight: t('img.meta.thumbHeight', '缩略图高'),
  };
  const KeyDic = {
    local: t('img.meta.local', '本地'),
  };
  let url = getImgLink(item.realPath);
  const rawObj = {
    name: item.name,
    ...item.meta,
    sign: item.sign,
    storageType: item.storageType,
    url,
  };
  const res = {};

  for (const [k, v] of Object.entries(rawObj)) {
    res[Dic[k] || k] = KeyDic[v as any] || v;
  }
  return res;
};
export const downloadImg = (name, url) => {
  const tag = document.createElement('a');
  // 此属性的值就是下载时图片的名称，注意，名称中不能有半角点，否则下载时后缀名会错误
  tag.setAttribute('download', name);
  const link = getImgLink(url);
  tag.href = link;
  tag.dispatchEvent(new MouseEvent('click'));
};

/**
 * 列表用的小图：有缩略图就用缩略图（一般 10KB 左右），没有就退回原图。
 * 点开预览时仍然看原图（见 index.tsx 里的 preview.src）。
 */
export const getThumbLink = (item: StaticItem) => {
  const thumb = (item as any)?.meta?.thumb;
  return typeof thumb === 'string' && thumb ? thumb : item?.realPath;
};

/** 去掉落盘名前面的 md5 前缀，列表里显示原始文件名。 */
export const displayImgName = (name?: string) => {
  const raw = String(name || '');
  return raw.replace(/^[a-f0-9]{32}\./i, '') || raw || '-';
};

/** statics 表只存 updatedAt（新建时就是上传时间，替换后会刷新）。 */
export const formatDateTime = (value: any) => {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    return String(value);
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
};
