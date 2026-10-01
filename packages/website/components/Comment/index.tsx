import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CommentContent from "./Content";
import {
  createComment,
  fetchComments,
  loadCommentSetting,
  PublicCommentItem,
  PublicCommentSetting,
} from "../../utils/commentApi";

import useT from "../../hooks/useT";
import { IDENTITY_T, translateServerMessage, type TFunc } from "../../utils/i18n";
const PAGE_SIZE = 20;
const IDENTITY_KEY = "van-comment-identity";

function readIdentity(): { nick: string; email: string; site: string } {
  if (typeof window === "undefined") {
    return { nick: "", email: "", site: "" };
  }
  try {
    const raw = window.localStorage.getItem(IDENTITY_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      nick: String(parsed?.nick || "").slice(0, 30),
      email: String(parsed?.email || "").slice(0, 100),
      site: String(parsed?.site || "").slice(0, 200),
    };
  } catch {
    return { nick: "", email: "", site: "" };
  }
}

function timeAgo(iso: string, t: TFunc = IDENTITY_T): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) {
    return "";
  }
  const diff = Date.now() - time;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  // 🔴 期 10 第九批：这 4 条是**我们自己写的文案** ⇒ 过接缝（与下面那行 `toLocaleDateString()` 性质不同：
  //    那是**平台的格式化结果**，站长裁定跟浏览器 locale 走）。
  //    ⚠️ 刻意**没有**复用 `utils/relativeTime.ts` 的 `relativeTime.*` key：那边是 `{n}分钟前`（**无空格**）、
  //    且没有"30 天后改用日期"这个分支 ⇒ 🔴 两套措辞与两套行为都不同，硬凑成同一个 key 会造成
  //    "改一处译文、另一处跟着变"的意外（那比多 4 个 key 更难查）。这个取舍已写进台账。
  if (diff < minute) return t("comment.timeJustNow", "刚刚");
  if (diff < hour) return t("comment.timeMinutes", "{n} 分钟前", { n: Math.floor(diff / minute) });
  if (diff < day) return t("comment.timeHours", "{n} 小时前", { n: Math.floor(diff / hour) });
  if (diff < 30 * day) return t("comment.timeDays", "{n} 天前", { n: Math.floor(diff / day) });
  // 🔴 **站长裁定（2026-10-01）：日期跟着浏览器的 locale 走，不跟站点语种。**
  //    `toLocaleDateString()` 不传 locale 参数 ⇒ 用浏览器/系统的语言与地区格式，这一行**刻意保持原样**。
  //    ⚠️ 已知代价（裁定接受的，不是缺陷）：站点语种设成英文、而浏览器是中文时，
  //    会出现「界面英文 + 这一处日期中文」并存。
  //    👉 下一批迁这个文件的其余文案时，**这一行不动**；上面那 4 条相对时间
  //    （刚刚 / N 分钟前 / N 小时前 / N 天前）则要过接缝 —— 它们是**我们自己写的文案**，
  //    不是 `Intl` 的输出（🔴 别把两者混为一谈：一个是"我们的字符串"，一个是"平台的格式化结果"）。
  return new Date(time).toLocaleDateString();
}

/** 昵称/主页都当作纯文本渲染，绝不进 href（主页地址服务端已校验过 http/https） */
function Nick({ item }: { item: PublicCommentItem }) {
  const safeSite = useMemo(() => {
    const site = String(item.site || "");
    return /^https?:\/\//i.test(site) ? site : "";
  }, [item.site]);
  if (!safeSite) {
    return <span className="van-comment-nick">{item.nick}</span>;
  }
  return (
    <a
      className="van-comment-nick"
      href={safeSite}
      target="_blank"
      rel="nofollow noopener noreferrer"
    >
      {item.nick}
    </a>
  );
}

function Item({
  item,
  onReply,
  replyTo,
  depth,
}: {
  item: PublicCommentItem;
  onReply: (target: PublicCommentItem) => void;
  replyTo: PublicCommentItem | null;
  depth: number;
}) {
  // 🔴 期 10 第五～九批的规矩：组件里用 `useT()`（渲染期取），纯函数用注入尾参
  const t = useT();
  return (
    <li className="van-comment-item" id={`comment-${item.id}`}>
      <div className="van-comment-avatar" aria-hidden="true">
        {(item.nick || "?").slice(0, 1).toUpperCase()}
      </div>
      <div className="van-comment-main">
        <div className="van-comment-meta">
          <Nick item={item} />
          {item.isAuthor && (
            <span className="van-comment-badge">{t("comment.authorBadge", "博主")}</span>
          )}
          {item.replyToNick ? (
            <span className="van-comment-reply-to">
              {t("comment.replyTo", "回复 @{nick}", { nick: item.replyToNick })}
            </span>
          ) : null}
          <time className="van-comment-time" dateTime={item.createdAt} title={item.createdAt}>
            {timeAgo(item.createdAt, t)}
          </time>
        </div>
        <CommentContent content={item.content} />
        <div className="van-comment-actions">
          <button type="button" onClick={() => onReply(item)}>
            {replyTo?.id === item.id
              ? t("comment.cancelReply", "取消回复")
              : t("comment.reply", "回复")}
          </button>
          <a
            href={`#comment-${item.id}`}
            className="van-comment-anchor"
            aria-label={t("comment.permalink", "链接到这条评论")}
          >
            #
          </a>
        </div>
        {depth === 0 && item.children && item.children.length > 0 ? (
          <ul className="van-comment-children">
            {item.children.map((child) => (
              <Item
                key={child.id}
                item={child}
                onReply={onReply}
                replyTo={replyTo}
                depth={depth + 1}
              />
            ))}
          </ul>
        ) : null}
        {depth === 0 && (item.replyCount || 0) > (item.children?.length || 0) ? (
          <p className="van-comment-more-hint">
            {t("comment.repliesSummary", "共 {count} 条回复，仅显示前 {shown} 条", {
              count: item.replyCount,
              shown: item.children?.length || 0,
            })}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function CommentSection({
  path,
  setting,
}: {
  path: string;
  setting: PublicCommentSetting;
}) {
  // 🔴 期 10 第九批：表单、提示、按钮全部走 i18n 接缝；`t` 也传给 `timeAgo()`（纯函数）
  const t = useT();
  const [items, setItems] = useState<PublicCommentItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [replyTo, setReplyTo] = useState<PublicCommentItem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const identity = useRef(readIdentity());
  const [nick, setNick] = useState(identity.current.nick);
  const [email, setEmail] = useState(identity.current.email);
  const [site, setSite] = useState(identity.current.site);
  const [content, setContent] = useState("");
  // 蜜罐：真人看不到（CSS 移出视口 + aria-hidden + tabIndex=-1），脚本会填
  const [hp, setHp] = useState("");
  const formRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(
    async (target: number, append: boolean) => {
      setLoading(true);
      setListError("");
      try {
        const res = await fetchComments(path, target, PAGE_SIZE);
        setTotal(res.total);
        setPage(res.page);
        setItems((prev) => (append ? [...prev, ...res.data] : res.data));
      } catch (err: any) {
        // 🔴 `err?.message` 是服务端消息 ⇒ 走 `translateServerMessage()`（有码就按码翻，翻不了原样中文）
        setListError(translateServerMessage(err) || t("comment.loadFailed", "评论加载失败"));
      } finally {
        setLoading(false);
      }
    },
    [path],
  );

  useEffect(() => {
    load(1, false);
  }, [load]);

  const onReply = (target: PublicCommentItem) => {
    setReplyTo((prev) => (prev?.id === target.id ? null : target));
    if (formRef.current && replyTo?.id !== target.id) {
      formRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  const maxLen = Math.max(1, Math.min(Number(setting.maxContentLength) || 2000, 20000));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) {
      return;
    }
    const text = content.trim();
    if (!text) {
      setNotice({ kind: "err", text: t("comment.emptyContent", "先写点内容吧") });
      return;
    }
    if (text.length > maxLen) {
      setNotice({ kind: "err", text: t("comment.tooLong", "内容不能超过 {max} 个字符", { max: maxLen }) });
      return;
    }
    if (!nick.trim()) {
      setNotice({ kind: "err", text: t("comment.nickRequired", "昵称必填") });
      return;
    }
    if (setting.requireEmail && !email.trim()) {
      setNotice({ kind: "err", text: t("comment.emailRequired", "本站要求填写邮箱（不会公开显示）") });
      return;
    }
    setSubmitting(true);
    setNotice(null);
    try {
      const res = await createComment({
        path,
        parentId: replyTo ? replyTo.id : undefined,
        nick: nick.trim(),
        email: email.trim(),
        site: site.trim(),
        content: text,
        hp,
      });
      try {
        window.localStorage.setItem(
          IDENTITY_KEY,
          JSON.stringify({ nick: nick.trim(), email: email.trim(), site: site.trim() }),
        );
      } catch {
        // 隐私模式下 localStorage 可能不可用，忽略
      }
      setContent("");
      setHp("");
      setReplyTo(null);
      setNotice({
        kind: "ok",
        // 🔴 `res.message` 是服务端消息 ⇒ 先过 `translateServerMessage()`（服务端有码就按码翻）
        text: res.pending
          ? translateServerMessage(res) || t("comment.pendingNotice", "评论已提交，审核通过后显示")
          : t("comment.success", "评论成功"),
      });
      if (!res.pending) {
        await load(1, false);
      }
    } catch (err: any) {
      setNotice({ kind: "err", text: translateServerMessage(err) || t("comment.submitFailed", "提交失败，请稍后再试") });
    } finally {
      setSubmitting(false);
    }
  };

  const hasMore = items.length < total;

  return (
    <section className="van-comment" id="van-comment">
      <h3 className="van-comment-title">
        {t("comment.title", "评论")}{" "}
        <span className="van-comment-total">{total ? `(${total})` : ""}</span>
      </h3>

      <div className="van-comment-form" ref={formRef}>
        <form onSubmit={submit}>
          <div className="van-comment-fields">
            <input
              value={nick}
              onChange={(e) => setNick(e.target.value.slice(0, 30))}
              placeholder={t("comment.nickPlaceholder", "昵称（必填）")}
              maxLength={30}
              autoComplete="nickname"
              aria-label={t("comment.nickLabel", "昵称")}
            />
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value.slice(0, 100))}
              placeholder={
                setting.requireEmail
                  ? t("comment.emailPlaceholderRequired", "邮箱（必填，不会公开）")
                  : t("comment.emailPlaceholderOptional", "邮箱（选填，不会公开）")
              }
              type="email"
              maxLength={100}
              autoComplete="email"
              aria-label={t("comment.emailLabel", "邮箱")}
            />
            <input
              value={site}
              onChange={(e) => setSite(e.target.value.slice(0, 200))}
              placeholder={t("comment.sitePlaceholder", "个人主页（选填，http/https）")}
              maxLength={200}
              autoComplete="url"
              aria-label={t("comment.siteLabel", "个人主页")}
            />
          </div>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value.slice(0, maxLen + 200))}
            placeholder={
              replyTo
                ? t("comment.textareaReplyPlaceholder", "回复 @{nick}…（支持基础 Markdown，原始 HTML 会按字面显示）", {
                    nick: replyTo.nick,
                  })
                : t(
                    "comment.textareaPlaceholder",
                    "写下你的评论…（支持基础 Markdown，原始 HTML 会按字面显示）"
                  )
            }
            rows={4}
            aria-label={t("comment.contentLabel", "评论内容")}
          />
          {/* 蜜罐字段：视觉上不可见、不可聚焦、无障碍树里也没有，只有脚本会填 */}
          <div className="van-comment-hp" aria-hidden="true">
            <label>
              {/* 🔴 **蜜罐**字段：这句是给"会填它的脚本"看的诱饵文案，人类用户看不见
                  （视觉上不可见、不可聚焦、无障碍树里也没有）⇒ 它仍然过接缝，
                  但译文**必须保持"请留空这一项"这种人话**，
                  🔴 绝不能翻成 "honeypot" / "anti-spam field"（那等于告诉垃圾脚本"这一项别填"）。 */}
              {t("comment.honeypotLabel", "请留空这一项")}
              <input
                value={hp}
                onChange={(e) => setHp(e.target.value)}
                tabIndex={-1}
                autoComplete="off"
                name="website_url"
              />
            </label>
          </div>
          <div className="van-comment-submit">
            {replyTo ? (
              <span className="van-comment-replying">
                {t("comment.replyingTo", "正在回复 @{nick}", { nick: replyTo.nick })}
                <button type="button" onClick={() => setReplyTo(null)}>
                  {t("comment.cancel", "取消")}
                </button>
              </span>
            ) : (
              <span className="van-comment-hint">
                {setting.moderation === "pre"
                  ? t("comment.moderationNotice", "本站评论需审核后显示")
                  : t("comment.markdownNotice", "支持基础 Markdown；含外链或敏感词会转人工审核")}
              </span>
            )}
            <button type="submit" disabled={submitting}>
              {submitting ? t("comment.submitting", "提交中…") : t("comment.submit", "发表评论")}
            </button>
          </div>
          {notice ? (
            <p className={`van-comment-notice van-comment-notice-${notice.kind}`}>{notice.text}</p>
          ) : null}
        </form>
      </div>

      {listError ? <p className="van-comment-notice van-comment-notice-err">{listError}</p> : null}

      {items.length > 0 ? (
        <ul className="van-comment-list">
          {items.map((item) => (
            <Item key={item.id} item={item} onReply={onReply} replyTo={replyTo} depth={0} />
          ))}
        </ul>
      ) : (
        !loading && <p className="van-comment-empty">{t("comment.empty", "还没有评论，来说两句吧。")}</p>
      )}

      {loading ? <p className="van-comment-loading">{t("comment.loading", "加载中…")}</p> : null}
      {!loading && hasMore ? (
        <div className="van-comment-pager">
          <button type="button" onClick={() => load(page + 1, true)}>
            {t("comment.loadMore", "加载更多评论（还有 {count} 条）", { count: total - items.length })}
          </button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * 文章页评论区。
 *
 * 评论系统有三种：`builtin`（本站内置）/ `waline`（外挂子进程，走 components/WaLine）/ `off`。
 * 这里只负责内置那一种；设置是客户端取的（评论本来就要客户端渲染），
 * SSR 阶段返回 null，因此不会有水合不一致。
 */
export default function Comment({ path, enable }: { path: string; enable: boolean }) {
  const [setting, setSetting] = useState<PublicCommentSetting | null>(null);

  useEffect(() => {
    if (!enable) {
      return;
    }
    let alive = true;
    loadCommentSetting()
      .then((value) => {
        if (alive) {
          setSetting(value);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [enable]);

  if (!enable || !setting || setting.provider !== "builtin" || !path) {
    return null;
  }
  return <CommentSection path={path} setting={setting} />;
}
