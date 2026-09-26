// import breaks from '@bytemd/plugin-breaks';
import frontmatter from '@bytemd/plugin-frontmatter';
import gfm from '@bytemd/plugin-gfm';
import { highlightSsr } from './highlightSsr';
import mediumZoom from '@bytemd/plugin-medium-zoom';
import { Editor } from '@bytemd/react';
import { Spin } from 'antd';
import 'bytemd/dist/index.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BytemdPlugin } from 'bytemd';
import '../../style/github-markdown.css';
import '../../style/code-light.css';
import '../../style/code-dark.css';
import '../../style/custom-container.css';
import { emoji } from './emoji';
import { imgUploadPlugin, uploadImg } from './imgUpload';
import { fileUploadPlugin } from './fileUpload';
import { transferRemotePlugin } from './transferRemote';
import './index.less';
import './mermaid-safety.css';
import './toc-viewport.css';
import { insertMore } from './insertMore';
import { pickEditorLocale } from './locales';
import { getLocale, useIntl, useModel } from 'umi';
import { customContainer } from './plugins/customContainer';
import { extraSyntax } from './plugins/extraSyntax';
import { defListHastHandlers } from 'remark-definition-list';
import 'remark-github-blockquote-alert/alert.css';
import '../../style/markdown-extra.css';
import '../../style/apple-preview.css';
import useApplePreviewFont from './useApplePreviewFont';
import { getSiteInfo } from '@/services/van-blog/api';
import { historyIcon } from './history';
import rawHTML from './rawHTML';
import { Heading } from './plugins/heading';
import { customCodeBlock } from './plugins/codeBlock';
import { LinkTarget } from './plugins/linkTarget';
import { mermaidForEditor } from './plugins/mermaidSafety';
import { withSafeViewerEffects } from './plugins/previewSafety';
import { tocViewportGuard } from './plugins/tocViewport';
import { mobileToolbarPlugin } from './plugins/mobileToolbar';
import { sanitizeMarkdownSchema as sanitize } from './markdownSanitize';
import { softLineBreaksPlugin } from './plugins/softLineBreaks';
import './mobile-toolbar.css';

async function uploadEditorImages(files: File[], setLoading: (loading: boolean) => void) {
  setLoading(true);
  const res: { url: string }[] = [];
  try {
    for (const each of files) {
      const url = await uploadImg(each);
      if (url) {
        res.push({ url: encodeURI(url) });
      }
    }
    return res;
  } finally {
    setLoading(false);
  }
}

export default function EditorComponent(props: {
  value: string;
  onChange: (string: string) => void;
  loading: boolean;
  setLoading: (l: boolean) => void;
  softLineBreaks?: string | boolean;
}) {
  const { loading, setLoading } = props;
  const { initialState } = useModel('@@initialState');
  const navTheme = initialState.settings.navTheme;
  const themeClass = navTheme.toLowerCase().includes('dark') ? 'dark' : 'light';
  /**
   * 🔴 编辑器文案跟随站点语言。**选择必须发生在渲染期**：`getLocale()` 内部会走 umi 的
   * `plugin.applyPlugins(...)`，依赖插件运行时已初始化，在模块加载期调用会拿到 undefined
   * （与 `app.jsx` 的 `links` 数组是同一条约束）。
   * 🔴 `pickEditorLocale()` 返回的是稳定引用（不是每次新建对象），所以把它放进下面 `plugins`
   * 的 `useMemo` 依赖**不会**导致插件数组反复重建、编辑器状态被重置。
   * ⚠️ 切换语言走 `setLocale(lang, true)` 的整页 reload，因此每次挂载读一次就够。
   */
  const editorLocale = pickEditorLocale(getLocale());
  // 🔴 编辑器**自己那几条**文案（撤销/重做/表情/插入 more/复制成功/自定义高亮块）走 admin 语言包：
  //    bytemd 插件的 action 是纯对象、在工厂里就构造好了，拿不到 React 上下文 ⇒ 在这里（渲染期）把 t 传进去。
  // 🔴 t 必须**稳定**（useCallback([intl])）：它会进下面 `plugins` 的 useMemo 依赖数组，
  //    不稳定 ⇒ 每次渲染都重建插件数组 ⇒ 编辑器状态被重置（§7.144 A 那个坑）。
  const intl = useIntl();
  const t = useCallback(
    (id: string, defaultMessage: string, values?: Record<string, any>) =>
      intl.formatMessage({ id, defaultMessage }, values),
    [intl],
  );
  // 前台皮肤是 Apple 风格时，预览也用同一套字体（Maple Mono），做到所见即所得。
  // 站点设置里没有这个字段（/api/admin/meta 只返回 version/user/baseUrl 等），
  // 所以单独取一次 /api/admin/meta/site；取不到就当默认皮肤，不影响编辑器其它功能。
  const [appleSkin, setAppleSkin] = useState(false);
  useEffect(() => {
    let alive = true;
    getSiteInfo()
      .then((res: any) => {
        const uiStyle = res?.data?.uiStyle;
        // 与前台 components/Layout 的判定一致：只有显式 'default' 才是默认皮肤
        if (alive) {
          setAppleSkin(uiStyle !== undefined && uiStyle !== 'default');
        }
      })
      .catch(() => {
        // 拿不到设置就保持默认皮肤，别把编辑器搞挂
      });
    return () => {
      alive = false;
    };
  }, []);
  useApplePreviewFont(appleSkin);
  const softLineBreaksRef = useRef(props.softLineBreaks);
  softLineBreaksRef.current = props.softLineBreaks;
  /**
   * KaTeX 只在正文真的有公式时才加载（`@bytemd/plugin-math-ssr` + `katex.css` 合计数百 KB）。
   * 嗅探规则和前台一致：宁可误判（多下一个 chunk）也不能漏判（公式显示成原文）。
   */
  const [mathPlugin, setMathPlugin] = useState<BytemdPlugin | null>(null);
  const hasMath = /\$\$|(^|[^\\\w$])\$(?!\s)[^$\n]+?\$/.test(props.value || '');
  useEffect(() => {
    if (!hasMath || mathPlugin) {
      return;
    }
    let cancelled = false;
    Promise.all([import('@bytemd/plugin-math-ssr'), import('katex/dist/katex.css')])
      .then((mods: any[]) => {
        if (cancelled) {
          return;
        }
        const factory = mods[0]?.default ?? mods[0];
        setMathPlugin(() => factory({ locale: editorLocale }));
      })
      .catch(() => {
        // 加载失败就保持原文显示，不要让编辑器崩掉
      });
    return () => {
      cancelled = true;
    };
  }, [hasMath, mathPlugin, editorLocale]);

  const plugins = useMemo(() => {
    return withSafeViewerEffects([
      ...(mathPlugin ? [mathPlugin] : []),
      customContainer(t),
      // singleTilde:false —— 单个 `~x~` 让给下标（remark-supersub），删除线仍用 `~~x~~`
      gfm({ locale: editorLocale, singleTilde: false }),
      extraSyntax(),
      highlightSsr(),
      frontmatter(),
      mediumZoom(),
      mermaidForEditor({ locale: editorLocale }),
      tocViewportGuard(),
      imgUploadPlugin(setLoading),
      fileUploadPlugin(setLoading),
      transferRemotePlugin(setLoading, props.onChange),
      emoji(t),
      insertMore(t),
      rawHTML(),
      historyIcon(t),
      Heading(),
      customCodeBlock(t),
      LinkTarget(),
      // Keep mode="auto" (tab under 800px). Expand that toolbar; do not dump desktop icons.
      mobileToolbarPlugin({
        uploadImages: (files) => uploadEditorImages(files, setLoading),
        // 🔴 移动端工具栏那 11 个标题**不进 admin 语言包**：它们与上游 bytemd 的 zh_Hans 值逐字相同
        //    （headingText/bold/italic/quote/link/image/ul/code/h1/h2/h3）⇒ 直接读 editorLocale，
        //    繁中与英文由上游给（实测 zh_Hant 是 標題/粗體/連結/圖像，真正的地区用词）。
        locale: editorLocale,
      }),
      // Enter / paste can complete trailing spaces. Preview stays CommonMark (#311).
      softLineBreaksPlugin({
        getEnabled: () => softLineBreaksRef.current === true || softLineBreaksRef.current === 'open',
      }),
    ]);
  }, [themeClass, mathPlugin, editorLocale, t]);

  return (
    <div
      style={{ height: '100%', minHeight: 0 }}
      // apple 皮肤下加 vanblog-apple-preview：style/apple-preview.css 只在这个作用域里生效，
      // 而且只作用于 .bytemd-preview（预览面板），不动左侧 CodeMirror 编辑区
      className={`editor-shell ${themeClass}${appleSkin ? ' vanblog-apple-preview' : ''}`}
    >
      <Spin spinning={loading} className="editor-wrapper">
        <Editor
          value={props.value}
          plugins={plugins}
          onChange={props.onChange}
          locale={editorLocale}
          mode="auto"
          remarkRehype={{ allowDangerousHtml: true, handlers: defListHastHandlers }}
          sanitize={sanitize}
          uploadImages={(files: File[]) => uploadEditorImages(files, setLoading)}
        />
      </Spin>
    </div>
  );
}
