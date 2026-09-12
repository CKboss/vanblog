// import breaks from '@bytemd/plugin-breaks';
import frontmatter from '@bytemd/plugin-frontmatter';
import gfm from '@bytemd/plugin-gfm';
import { highlightSsr } from './highlightSsr';
import mediumZoom from '@bytemd/plugin-medium-zoom';
import { Editor } from '@bytemd/react';
import { Spin } from 'antd';
import 'bytemd/dist/index.css';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { cn } from './locales';
import { useModel } from 'umi';
import { customContainer } from './plugins/customContainer';
import { extraSyntax } from './plugins/extraSyntax';
import { defListHastHandlers } from 'remark-definition-list';
import 'remark-github-blockquote-alert/alert.css';
import '../../style/markdown-extra.css';
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
        setMathPlugin(() => factory({ locale: cn }));
      })
      .catch(() => {
        // 加载失败就保持原文显示，不要让编辑器崩掉
      });
    return () => {
      cancelled = true;
    };
  }, [hasMath, mathPlugin]);

  const plugins = useMemo(() => {
    return withSafeViewerEffects([
      ...(mathPlugin ? [mathPlugin] : []),
      customContainer(),
      // singleTilde:false —— 单个 `~x~` 让给下标（remark-supersub），删除线仍用 `~~x~~`
      gfm({ locale: cn, singleTilde: false }),
      extraSyntax(),
      highlightSsr(),
      frontmatter(),
      mediumZoom(),
      mermaidForEditor({ locale: cn }),
      tocViewportGuard(),
      imgUploadPlugin(setLoading),
      fileUploadPlugin(setLoading),
      transferRemotePlugin(setLoading, props.onChange),
      emoji(),
      insertMore(),
      rawHTML(),
      historyIcon(),
      Heading(),
      customCodeBlock(),
      LinkTarget(),
      // Keep mode="auto" (tab under 800px). Expand that toolbar; do not dump desktop icons.
      mobileToolbarPlugin({
        uploadImages: (files) => uploadEditorImages(files, setLoading),
      }),
      // Enter / paste can complete trailing spaces. Preview stays CommonMark (#311).
      softLineBreaksPlugin({
        getEnabled: () => softLineBreaksRef.current === true || softLineBreaksRef.current === 'open',
      }),
    ]);
  }, [themeClass, mathPlugin]);

  return (
    <div style={{ height: '100%', minHeight: 0 }} className={`editor-shell ${themeClass}`}>
      <Spin spinning={loading} className="editor-wrapper">
        <Editor
          value={props.value}
          plugins={plugins}
          onChange={props.onChange}
          locale={cn}
          mode="auto"
          remarkRehype={{ allowDangerousHtml: true, handlers: defListHastHandlers }}
          sanitize={sanitize}
          uploadImages={(files: File[]) => uploadEditorImages(files, setLoading)}
        />
      </Spin>
    </div>
  );
}
