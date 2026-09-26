import Editor from '@/components/Editor';
import EditorProfileModal from '@/components/EditorProfileModal';
import { useIntl } from 'umi';
import PublishDraftModal from '@/components/PublishDraftModal';
import RevisionHistory from '@/components/RevisionHistory';
import Tags from '@/components/Tags';
import UpdateModal from '@/components/UpdateModal';
import { SaveTip } from '@/components/SaveTip';
import {
  deleteArticle,
  deleteDraft,
  getAbout,
  getArticleById,
  getDraftById,
  updateAbout,
  updateArticle,
  updateDraft,
} from '@/services/van-blog/api';
import { getPathname } from '@/services/van-blog/getPathname';
import { parseMarkdownFile } from '@/services/van-blog/parseMarkdownFile';
import { downloadMarkdownExport } from '@/services/van-blog/exportMarkdown';
import { importMdzFile, importMdzErrorMessage } from '@/services/van-blog/importMdz';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  IMPORT_PHASE_TEXT,
  isMdzFileName,
  frontMatterPatchForEditor,
  describeImportOutcome,
} = require('@/services/van-blog/importMdzCore');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { exportFormats } = require('@/services/van-blog/exportFormats');
import { describeScheduledTag, isScheduled } from '@/services/van-blog/schedule';
import { formatDateTime } from '@/services/van-blog/formatTime';
import { useCacheState } from '@/services/van-blog/useCacheState';
import { handleEditorHotkey } from '@/services/van-blog/editableKeyboard';
import { DownOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-layout';
import { Button, Dropdown, Input, Menu, message, Modal, Space, Tag, Upload } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { history } from 'umi';
import moment from 'moment';

function parseDocId(id) {
  if (id === undefined || id === null || id === '') {
    return null;
  }
  const parsed = Number(id);
  return Number.isInteger(parsed) ? parsed : null;
}

export default function () {
  // 🔴 语言选择必须在**渲染期**（useIntl 是 hook；模块加载期 umi 插件运行时还没初始化）。
  // 🔴 t 用 useCallback([intl]) 包成**稳定引用**：这个文件里 `typeMap` 与多个 useMemo/useCallback
  //    都会用到它，不稳定 ⇒ 每次渲染都是新函数 ⇒ 依赖数组全变 ⇒ 无限重渲染/重复请求（§7.144 A）。
  const intl = useIntl();
  const t = useCallback(
    (id, defaultMessage, values) => intl.formatMessage({ id, defaultMessage }, values),
    [intl],
  );
  const [value, setValue] = useState('');
  const [currObj, setCurrObj] = useState({});
  const [loading, setLoading] = useState(true);
  const [updateModalVisible, setUpdateModalVisible] = useState(false);
  // .mdz 导入的进行中阶段：'upload'（浏览器上传）→ 'ingest'（服务端解包+图床入库）→ null。
  // ref 是给 onProgress 闭包用的（state 在闭包里是旧值）。
  const [mdzImportPhase, setMdzImportPhase] = useState(null);
  const mdzImportPhaseRef = useRef(null);
  const [editorConfig, setEditorConfig] = useCacheState(
    { afterSave: 'stay', useLocalCache: 'close', softLineBreaks: 'close' },
    'editorConfig',
  );
  const type = history.location.query?.type || 'article';
  const getCacheKey = () => `${type}-${history.location.query?.id || '0'}`;

  // Ctrl+S 热键：把最新的 handleSave 放进 ref，window 监听只注册一次。
  // 以前的依赖是 [currObj, value, type] —— value 每敲一个字符就变，
  // 等于**每敲一键都 removeEventListener + addEventListener 一轮**（写作时持续抖动）。
  const handleSaveRef = useRef(null);
  useEffect(() => {
    const onKeyDown = (ev) => {
      // Ctrl/Cmd+S saves. Edit keys reach title/form fields (#233, #390, #470).
      handleEditorHotkey(ev, () => {
        if (typeof handleSaveRef.current === 'function') {
          handleSaveRef.current();
        }
      });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const typeMap = {
    // 🔴 这三个是"文档类型"的名字（页头标题、导出/删除菜单都用它拼句子）
    article: t('common.article', '文章'),
    draft: t('common.draft', '草稿'),
    about: t('common.about', '关于'),
  };
  const fetchData = useCallback(
    async (noMessage) => {
      setLoading(true);

      const type = history.location.query?.type || 'article';
      const id = parseDocId(history.location.query?.id);
      try {
      const cacheString = window.localStorage.getItem(getCacheKey());
      let cacheObj = {};
      try {
        cacheObj = JSON.parse(cacheString || '{}');
      } catch (err) {
        window.localStorage.removeItem(getCacheKey());
      }
      const checkCache = (data) => {
        const clear = () => {
          window.localStorage.removeItem(getCacheKey());
        };
        if (editorConfig?.useLocalCache == 'close') {
          clear();
          return false;
        }
        if (!cacheObj || !cacheObj?.content) {
          clear();
          return false;
        }
        if (cacheObj?.content == data?.content) {
          clear();
          return false;
        }
        const updatedAt = data?.updatedAt;
        if (!updatedAt) {
          clear();
          return false;
        }
        const cacheTime = cacheObj?.time;
        if (moment(updatedAt).isAfter(cacheTime)) {
          clear();
          return false;
        } else {
          console.log('[缓存检查] 本地缓存时间晚于服务器更新时间，使用缓存');
          return cacheObj?.content;
        }
      };

      if (type == 'about') {
        const { data } = await getAbout();
        const cache = checkCache(data);
        if (cache) {
          if (!noMessage) {
            message.success(t('editor.restoredFromCache', '从缓存中恢复状态！'));
          }
          setValue(cache);
        } else {
          setValue(data?.content || '');
        }
        document.title = t('editor.docTitle', '{title} - VanBlog 编辑器', {
          title: t('common.about', '关于'),
        });
        setCurrObj(data);
      }
      if (type == 'article' && id) {
        const { data } = await getArticleById(id);
        const cache = checkCache(data);
        if (cache) {
          setValue(cache);
          if (!noMessage) {
            message.success(t('editor.restoredFromCache', '从缓存中恢复状态！'));
          }
        } else if (data) {
          setValue(data.content || '');
        } else {
          message.error(t('editor.articleNotFound', '未找到文章，已保留当前编辑内容以免覆盖'));
          setLoading(false);
          return;
        }
        document.title = t('editor.docTitle', '{title} - VanBlog 编辑器', { title: data?.title || '' });
        setCurrObj(data);
      }
      if (type == 'draft' && id) {
        const { data } = await getDraftById(id);
        const cache = checkCache(data);
        if (cache) {
          if (!noMessage) {
            message.success(t('editor.restoredFromCache', '从缓存中恢复状态！'));
          }
          setValue(cache);
        } else if (data) {
          setValue(data.content || '');
        } else {
          message.error(t('editor.draftNotFound', '未找到草稿，已保留当前编辑内容以免覆盖'));
          setLoading(false);
          return;
        }
        setCurrObj(data);
        document.title = t('editor.docTitle', '{title} - VanBlog 编辑器', { title: data?.title || '' });
      }
      if ((type == 'article' || type == 'draft') && !id) {
        message.error(t('editor.invalidDocId', '无效的文档 ID，无法加载'));
      }
      } catch (err) {
        message.error(t('editor.loadFailed', '加载文档失败，已保留当前内容以免覆盖'));
      } finally {
        setLoading(false);
      }
    },
    // 🔴 依赖数组必须带上 t：这个 useCallback 的回调体里用了 t（未找到/加载失败/从缓存恢复那几句提示），
    //    不带就会闭包住**首轮渲染的翻译器** ⇒ 切语言后仍是旧译文（§7.144 B）。
    //    t 是 useCallback([intl]) 包过的稳定引用 ⇒ 加进来不会造成重复请求。
    [history, setLoading, setValue, type, t],
  );

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    // 进入默认收起侧边栏
    const el = document.querySelector('.ant-pro-sider-collapsed-button');
    if (el && el.style.paddingLeft != '') {
      el.click();
    }
  }, []);

  const saveFn = async () => {
    const v = value;
    const docId = parseDocId(currObj?.id) ?? parseDocId(history.location.query?.id);
    setLoading(true);
    try {
      if (type == 'article') {
        if (docId == null) {
          message.error(t('editor.saveNeedsArticleId', '无法保存：缺少有效的文章 ID'));
          return;
        }
        await updateArticle(docId, { content: v });
        await fetchData();
        message.success(t('common.saveSuccess', '保存成功！'));
      } else if (type == 'draft') {
        if (docId == null) {
          message.error(t('editor.saveNeedsDraftId', '无法保存：缺少有效的草稿 ID'));
          return;
        }
        await updateDraft(docId, { content: v });
        await fetchData();
        message.success(t('common.saveSuccess', '保存成功！'));
      } else if (type == 'about') {
        await updateAbout({ content: v });
        await fetchData();
        message.success(t('common.saveSuccess', '保存成功！'));
      }
      if (editorConfig.afterSave && editorConfig.afterSave == 'goBack') {
        history.go(-1);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (location.hostname == 'blog-demo.mereith.com' && type != 'draft') {
      Modal.info({
        title: t('editor.demoBlockedEdit', '演示站禁止修改此信息！'),
        content: t(
          'common.demoBlockedReason',
          '本来是可以的，但有个人在演示站首页放黄色信息，所以关了这个权限了。',
        ),
      });
      return;
    }
    // 先检查一下有没有 more .
    let hasMore = true;
    if (['article', 'draft'].includes(history.location.query?.type)) {
      if (!value?.includes('<!-- more -->')) {
        hasMore = false;
      }
    }
    let hasTags =
      ['article', 'draft'].includes(history.location.query?.type) &&
      currObj?.tags &&
      currObj.tags.length > 0;
    if (history.location.query?.type == 'about') {
      hasTags = true;
    }
    Modal.confirm({
      // 🔴 原来是"标题 + 条件后缀"拼接 ⇒ 收成一条带 {warning} 占位符的整句：
      //    英文语序不同，拼接会出接缝（§7.152 B / §7.156 B / §7.160 C / §7.162 A / §7.166 D 已五次）。
      //    ⚠️ 英文那份 warning 值**自带前导空格**（拼接处需要；中文两份都不带，逐字对账仍成立）。
      title: t('editor.saveConfirmTitle', '确定保存吗？{warning}', {
        warning: hasTags ? '' : t('editor.noTagsYet', '此文章还没设置标签呢'),
      }),
      content: hasMore ? undefined : (
        <div style={{ marginTop: 8 }}>
          <p>{t(
            'editor.moreHintP1',
            '没有 more 标记：前台会自动截取正文前 200 字作为摘要（列表页「阅读全文」之前的内容）。',
          )}</p>
          <p>
            {/* 🔴 这三行 JSX 文本渲染时会被折成一行（换行处变空格）⇒ defaultMessage 用**折叠后**的那一句，
                改成 t() 之后渲染结果与今天逐字相同。链接在最后 ⇒ 只需要一个前缀 key（prefix/suffix 那套手法）。 */}
            {t(
              'editor.moreHintP2',
              '自动截取可能把图片语法从中间切开导致摘要里图片不显示；截断点落在 [文字](网址) 里时会自动补全这条链接。想精确控制摘要，就点编辑器工具栏最后一个按钮在合适的位置插入 more 标记。',
            )}
            <a
              target={'_blank'}
              rel="noreferrer"
              // 上游文档站的这个深链已经失效（文档结构变了），改指本分支仓库里的文档
              href="https://github.com/CKboss/vanblog/blob/dev/dsh/docs/features/editor.md"
            >
              {t('common.relatedDocs', '相关文档')}
            </a>
          </p>
          <img src="/more.png" alt="more" width={200}></img>
        </div>
      ),
      onOk: saveFn,
    });
  };
  // 每次渲染都把最新的 handleSave 放进 ref（热键监听器只注册一次，见文件顶部）
  handleSaveRef.current = handleSave;
  // format: 'md' | 'mdz' | 'zip'（不传 = zip = 老行为）
  const handleExport = async (format) => {
    // 关于页没有文章 id，走 raw：直接把当前编辑器内容交给服务端打包
    if (type == 'about') {
      await downloadMarkdownExport({
        type: 'raw',
        title: currObj?.title || t('common.about', '关于'),
        content: value,
        format,
      });
      return;
    }
    if (!currObj?.id) {
      message.warning(t(
        'editor.exportNeedsSave',
        '还没保存过，先保存再导出（否则拿不到分类、标签、别名这些 front matter）',
      ));
      return;
    }
    // 带上当前编辑器内容：未保存的改动也能导出来（所见即所得），元信息仍取自已保存的那份
    await downloadMarkdownExport({
      id: currObj.id,
      type: type == 'draft' ? 'draft' : 'article',
      title: currObj?.title,
      content: value,
      format,
    });
  };
  const handleImport = async (file) => {
    // .mdz（后台导出的 Typora 图片包）走服务端：解包、图片入图床、相对链接改写成服务 URL。
    // .md 保持原来的纯浏览器解析路径，一个字节都不动。
    if (isMdzFileName(file?.name)) {
      await handleImportMdz(file);
      return false; // 阻止 rc-upload 再发一次请求
    }
    setLoading(true);
    try {
      const { content } = await parseMarkdownFile(file, undefined, t);
      Modal.confirm({
        title: t('editor.importConfirmTitle', '确认内容'),
        content: <Input.TextArea value={content} autoSize={{ maxRows: 10, minRows: 5 }} />,
        onOk: () => {
          setValue(content);
          message.success(t('common.importOk', '导入成功！'));
        },
      });
    } catch (err) {
      message.error(t('editor.importFailed', '导入失败！请检查文件格式！'));
    }
    setLoading(false);
  };
  /**
   * .mdz 导入（不建文章）：服务端只解析并把图片写进图床，返回编辑器填表所需的一切；
   * 内容填入编辑器、front matter 合进 currObj（「修改信息」表单打开即是这些值），
   * 是否保存由用户审阅后自己决定。失败文案按拒绝原因分类（importMdzCore.mdzFailureMessage）。
   */
  const handleImportMdz = async (file) => {
    let hide = null;
    try {
      setMdzImportPhase('upload');
      hide = message.loading(IMPORT_PHASE_TEXT.upload, 0);
      const data = await importMdzFile(file, {
        onProgress: (p) => {
          if (p.phase === 'ingest' && mdzImportPhaseRef.current !== 'ingest') {
            mdzImportPhaseRef.current = 'ingest';
            setMdzImportPhase('ingest');
            if (hide) {
              hide();
            }
            hide = message.loading(IMPORT_PHASE_TEXT.ingest, 0);
          }
        },
      });
      if (hide) {
        hide();
        hide = null;
      }
      setValue(data?.content || '');
      if (type != 'about') {
        const patch = frontMatterPatchForEditor(data?.frontMatter);
        setCurrObj((prev) => ({ ...(prev || {}), ...patch }));
        document.title = t('editor.docTitle', '{title} - VanBlog 编辑器', { title: data?.title || patch.title || '' });
      }
      const outcome = describeImportOutcome(data);
      const open = outcome.tone === 'warn' ? Modal.warning : Modal.success;
      open({
        title: outcome.title,
        width: 560,
        content: (
          <div>
            {outcome.lines.map((line, idx) => (
              <p key={idx} style={{ marginBottom: 4 }}>
                {line}
              </p>
            ))}
            <p style={{ marginBottom: 0, color: '#888' }}>
              {t(
                'editor.importedNotSaved',
                '内容已填入编辑器但尚未保存：请在「修改信息」里核对标题/分类/标签等字段后点保存。',
              )}
            </p>
          </div>
        ),
      });
    } catch (err) {
      if (hide) {
        hide();
        hide = null;
      }
      Modal.error({
        title: t('editor.importMdzFailed', '导入 .mdz 失败'),
        content: importMdzErrorMessage(err),
      });
    } finally {
      mdzImportPhaseRef.current = null;
      setMdzImportPhase(null);
    }
  };
  const actionMenu = (
    <Menu
      items={[
        {
          key: 'resetBtn',
          label: t('common.reset', '重置'),
          onClick: () => {
            setValue(currObj?.content || '');
            message.success(t('editor.resetOk', '重置为初始值成功！'));
          },
        },
        type != 'about'
          ? {
              key: 'updateModalBtn',
              label: t('common.editInfo', '修改信息'),
              onClick: () => {
                setUpdateModalVisible(true);
              },
            }
          : null,
        // 历史版本（仅文章；服务端保留条数上限，功能关闭时抽屉里会平静说明）
        type == 'article' && currObj?.id != null
          ? {
              key: 'revisionsBtn',
              label: (
                <RevisionHistory
                  articleId={currObj?.id}
                  articleTitle={currObj?.title}
                  trigger={
                    <a key={'revisionsTrigger' + currObj?.id}>{t('revision.title', '历史版本')}</a>
                  }
                  onRestored={() => {
                    // 恢复版本后重拉正文，编辑器里立刻是新内容
                    fetchData(true);
                  }}
                />
              ),
            }
          : null,
        type == 'draft'
          ? {
              key: 'publishBtn',
              label: (
                <PublishDraftModal
                  title={currObj?.title}
                  key="publishModal1"
                  id={currObj?.id}
                  trigger={
                    <a key={'publishBtn' + currObj?.id}>{t('common.publishDraft', '发布草稿')}</a>
                  }
                  onFinish={() => {
                    history.push(`/article`);
                  }}
                />
              ),
            }
          : null,
        {
          key: 'importBtn',
          label: t('editor.importContent', '导入内容'),
          onClick: () => {
            const el = document.querySelector('#importBtn');
            if (el) {
              el.click();
            }
          },
        },
        {
          key: 'exportBtn',
          label: t('editor.exportType', '导出{type}', { type: typeMap[type] }),
          // ⚠️ 子菜单而不是单个 onClick：以前点这里**永远**得到一个外层 zip，
          // 想要一个能直接拖进 Typora 的 .md 还得先解包。
          // 🔴 期 6 第四批：改用**函数版**（传 t）⇒ 导出下拉的三项标签/说明跟着语言走。
          //    ⚠️ 不要改回 `EXPORT_FORMATS` 那个 identity 常量（localePackParity 有判据盯着）
          children: exportFormats(t).map((f) => ({
            key: `export-${f.key}`,
            label: f.label,
            title: f.hint,
            onClick: () => handleExport(f.key),
          })),
        },
        type != 'draft'
          ? {
              key: 'viewFE',
              label: t('editor.viewFrontend', '查看前台'),
              onClick: () => {
                let url = '';
                if (type == 'article') {
                  if (currObj.hidden) {
                    Modal.confirm({
                      title: t('article.hiddenWarningTitle', '此文章为隐藏文章！'),
                      content: (
                        <div>
                          <p>
                            {t(
                              'article.hiddenWarningP1',
                              '隐藏文章在未开启通过 URL 访问的情况下（默认关闭），会出现 404 页面！',
                            )}
                          </p>
                          <p>
                            {t('article.hiddenWarningPrefix', '您可以在')}{' '}
                            <a
                              onClick={() => {
                                // `subTab` 这个 key 没人读（SystemConfig 读 `tab`、SiteInfo 读
                                // `siteInfoTab`），以前点「布局配置」只会停在默认的「基本设置」。
                                history.push('/site/setting?tab=siteInfo&siteInfoTab=layout');
                              }}
                            >
                              {t('article.layoutConfig', '布局配置')}
                            </a>{' '}
                            {t('article.hiddenWarningSuffix', '中修改此项。')}
                          </p>
                        </div>
                      ),
                      onOk: () => {
                        window.open(`/post/${getPathname(currObj)}`, '_blank');
                        return true;
                      },
                      okText: t('common.visitAnyway', '仍然访问'),
                      cancelText: t('common.back', '返回'),
                    });
                    return;
                  }
                  if (isScheduled(currObj?.publishAt)) {
                    // 定时中的文章前台还不可见：别让「查看前台」看起来像已经发布了
                    Modal.confirm({
                      title: t('article.scheduledWarningTitle', '此文章处于「定时待发布」状态！'),
                      content: (
                        <div>
                          <p>
                            {t('article.scheduledWarningP1a', '这篇文章定时于')} <b>{formatDateTime(currObj?.publishAt)}</b>{' '}
                            {t(
                              'article.scheduledWarningP1b',
                              '自动发布，在那之前它对所有前台页面不可见，现在打开会是 404 页面。',
                            )}
                          </p>
                          <p>{t('editor.scheduledWarningP2', '想改时间或取消定时：「操作 → 修改信息 → 定时发布」。')}</p>
                        </div>
                      ),
                      onOk: () => {
                        window.open(`/post/${getPathname(currObj)}`, '_blank');
                        return true;
                      },
                      okText: t('common.visitAnyway', '仍然访问'),
                      cancelText: t('common.back', '返回'),
                    });
                    return;
                  }
                  url = `/post/${getPathname(currObj)}`;
                } else {
                  url = '/about';
                }
                window.open(url, '_blank');
              },
            }
          : undefined,
        type != 'about'
          ? {
              key: 'deleteBtn',
              label: t('editor.deleteType', '删除{type}', { type: typeMap[type] }),
              onClick: () => {
                Modal.confirm({
                  title: t('editor.deleteConfirmTitle', '确定删除 “{title}” 吗？', { title: currObj.title }),
                  // 文章与草稿现在都是软删除：说清去向和撤销路径
                  content:
                    type == 'article'
                      ? t(
                          'editor.deleteArticleContent',
                          '删除后文章会移入「文章管理 → 回收站」，前台立刻不可见，可随时恢复；只有在回收站里「永久删除」才不可撤销。',
                        )
                      : type == 'draft'
                        ? t(
                            'editor.deleteDraftContent',
                            '删除后草稿会移入「草稿管理 → 回收站」，可随时恢复；只有在回收站里「永久删除」才不可撤销。',
                          )
                        : undefined,
                  onOk: async () => {
                    if (location.hostname == 'blog-demo.mereith.com' && type == 'article') {
                      if ([28, 29].includes(currObj.id)) {
                        message.warn(t('common.demoBlockedDelete', '演示站禁止删除此文章！'));
                        return false;
                      }
                    }
                    if (type == 'article') {
                      await deleteArticle(currObj.id);
                      message.success(t('editor.articleDeletedOk', '删除文章成功，已移入回收站（可恢复）！返回列表页！'));
                      history.push('/article');
                    } else if (type == 'draft') {
                      await deleteDraft(currObj.id);
                      message.success(t('editor.draftDeletedOk', '删除草稿成功，已移入回收站（可恢复）！返回列表页！'));
                      history.push('/draft');
                    }
                  },
                });
              },
            }
          : undefined,
        {
          key: 'settingBtn',
          label: (
            <EditorProfileModal
              value={editorConfig}
              setValue={setEditorConfig}
              trigger={<a key={'editerConfigBtn'}>{t('editor.preferences', '偏好设置')}</a>}
            />
          ),
        },
        {
          key: 'clearCacheBtn',
          label: t('editor.clearCache', '清理缓存'),
          onClick: () => {
            Modal.confirm({
              title: t('editor.clearCacheTitle', '清理实时保存缓存'),
              content:
                t(
                  'editor.clearCacheContent',
                  '确定清理当前内容的实时保存缓存吗？清理后未保存的内容将会丢失，编辑器内容将重置为服务端返回的最新数据。',
                ),
              okText: t('editor.clearCacheOk', '确认清理'),
              cancelText: t('common.back', '返回'),
              onOk: () => {
                window.localStorage.removeItem(getCacheKey());
                setValue(currObj?.content || '');
                message.success(t('editor.clearCacheDone', '清除实时保存缓存成功！已重置为服务端返回数据'));
              },
            });
          },
        },
        {
          key: 'helpBtn',
          label: t('init.wizard.helpDoc', '帮助文档'),
          onClick: () => {
            // 上游文档站的这个地址已经 404，改指本分支仓库里的文档（跟着代码一起版本化）
            window.open('https://github.com/CKboss/vanblog/blob/dev/dsh/docs/features/editor.md', '_blank');
          },
        },
      ]}
    ></Menu>
  );
  return (
    <PageContainer
      className="editor-full"
      style={{ overflow: 'hidden' }}
      header={{
        title: (
          <Space>
            <span title={type == 'about' ? t('common.about', '关于') : currObj?.title}>
              {type == 'about' ? t('common.about', '关于') : currObj?.title}
            </span>
            {type != 'about' && (
              <>
                <Tag color="green">{typeMap[type] || '-'}</Tag>
                <Tag color="blue">{currObj?.category || '-'}</Tag>
                <Tags tags={currObj?.tags} />
                {/* 定时待发布：到点之前前台不可见，标题栏必须能一眼看出来 */}
                {describeScheduledTag(currObj?.publishAt, undefined, t) ? (
                  <Tag color="orange" data-editor-scheduled-tag>
                    {describeScheduledTag(currObj?.publishAt, undefined, t)}
                  </Tag>
                ) : null}
              </>
            )}
          </Space>
        ),
        extra: [
          <Button key="extraSaveBtn" type="primary" onClick={handleSave}>
            {<SaveTip />}
          </Button>,
          <Button
            key="backBtn"
            onClick={() => {
              history.go(-1);
            }}
          >
            {t('common.back', '返回')}
          </Button>,
          <Dropdown key="moreAction" overlay={actionMenu} trigger={['click']}>
            <Button size="middle">
              {t('common.colOption', '操作')}
              <DownOutlined />
            </Button>
          </Dropdown>,
        ],
        breadcrumb: {},
      }}
      footer={null}
    >
      {type != 'about' && (
        <UpdateModal
          visible={updateModalVisible}
          onVisibleChange={setUpdateModalVisible}
          onFinish={() => {
            fetchData(true);
          }}
          type={type}
          currObj={currObj}
          setLoading={setLoading}
        />
      )}
      <div style={{ height: '100%' }}>
        <div style={{ height: '0' }}>
          <Upload
            showUploadList={false}
            multiple={false}
            accept={'.md,.mdz'}
            disabled={!!mdzImportPhase}
            beforeUpload={handleImport}
            style={{ display: 'none', height: 0 }}
          >
            <a key="importBtn" type="link" style={{ display: 'none' }} id="importBtn">
              {t('editor.importContent', '导入内容')}
            </a>
          </Upload>
        </div>
        <Editor
          loading={loading}
          setLoading={setLoading}
          value={value}
          softLineBreaks={editorConfig?.softLineBreaks || 'close'}
          onChange={(val) => {
            setValue(val);
            if (editorConfig?.useLocalCache && editorConfig?.useLocalCache == 'open') {
              window.localStorage.setItem(
                getCacheKey(),
                JSON.stringify({
                  content: val,
                  time: new Date().valueOf(),
                }),
              );
            }
          }}
        />
      </div>
    </PageContainer>
  );
}
