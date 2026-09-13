import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CommentContent from "./Content";
import {
  createComment,
  fetchComments,
  loadCommentSetting,
  PublicCommentItem,
  PublicCommentSetting,
} from "../../utils/commentApi";

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

function timeAgo(iso: string): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) {
    return "";
  }
  const diff = Date.now() - time;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
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
  return (
    <li className="van-comment-item" id={`comment-${item.id}`}>
      <div className="van-comment-avatar" aria-hidden="true">
        {(item.nick || "?").slice(0, 1).toUpperCase()}
      </div>
      <div className="van-comment-main">
        <div className="van-comment-meta">
          <Nick item={item} />
          {item.isAuthor && <span className="van-comment-badge">博主</span>}
          {item.replyToNick ? (
            <span className="van-comment-reply-to">回复 @{item.replyToNick}</span>
          ) : null}
          <time className="van-comment-time" dateTime={item.createdAt} title={item.createdAt}>
            {timeAgo(item.createdAt)}
          </time>
        </div>
        <CommentContent content={item.content} />
        <div className="van-comment-actions">
          <button type="button" onClick={() => onReply(item)}>
            {replyTo?.id === item.id ? "取消回复" : "回复"}
          </button>
          <a href={`#comment-${item.id}`} className="van-comment-anchor" aria-label="链接到这条评论">
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
            共 {item.replyCount} 条回复，仅显示前 {item.children?.length || 0} 条
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
        setListError(err?.message || "评论加载失败");
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
      setNotice({ kind: "err", text: "先写点内容吧" });
      return;
    }
    if (text.length > maxLen) {
      setNotice({ kind: "err", text: `内容不能超过 ${maxLen} 个字符` });
      return;
    }
    if (!nick.trim()) {
      setNotice({ kind: "err", text: "昵称必填" });
      return;
    }
    if (setting.requireEmail && !email.trim()) {
      setNotice({ kind: "err", text: "本站要求填写邮箱（不会公开显示）" });
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
        text: res.pending ? res.message || "评论已提交，审核通过后显示" : "评论成功",
      });
      if (!res.pending) {
        await load(1, false);
      }
    } catch (err: any) {
      setNotice({ kind: "err", text: err?.message || "提交失败，请稍后再试" });
    } finally {
      setSubmitting(false);
    }
  };

  const hasMore = items.length < total;

  return (
    <section className="van-comment" id="van-comment">
      <h3 className="van-comment-title">
        评论 <span className="van-comment-total">{total ? `(${total})` : ""}</span>
      </h3>

      <div className="van-comment-form" ref={formRef}>
        <form onSubmit={submit}>
          <div className="van-comment-fields">
            <input
              value={nick}
              onChange={(e) => setNick(e.target.value.slice(0, 30))}
              placeholder="昵称（必填）"
              maxLength={30}
              autoComplete="nickname"
              aria-label="昵称"
            />
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value.slice(0, 100))}
              placeholder={setting.requireEmail ? "邮箱（必填，不会公开）" : "邮箱（选填，不会公开）"}
              type="email"
              maxLength={100}
              autoComplete="email"
              aria-label="邮箱"
            />
            <input
              value={site}
              onChange={(e) => setSite(e.target.value.slice(0, 200))}
              placeholder="个人主页（选填，http/https）"
              maxLength={200}
              autoComplete="url"
              aria-label="个人主页"
            />
          </div>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value.slice(0, maxLen + 200))}
            placeholder={
              replyTo
                ? `回复 @${replyTo.nick}…（支持基础 Markdown，原始 HTML 会按字面显示）`
                : "写下你的评论…（支持基础 Markdown，原始 HTML 会按字面显示）"
            }
            rows={4}
            aria-label="评论内容"
          />
          {/* 蜜罐字段：视觉上不可见、不可聚焦、无障碍树里也没有，只有脚本会填 */}
          <div className="van-comment-hp" aria-hidden="true">
            <label>
              请留空这一项
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
                正在回复 @{replyTo.nick}
                <button type="button" onClick={() => setReplyTo(null)}>
                  取消
                </button>
              </span>
            ) : (
              <span className="van-comment-hint">
                {setting.moderation === "pre"
                  ? "本站评论需审核后显示"
                  : "支持基础 Markdown；含外链或敏感词会转人工审核"}
              </span>
            )}
            <button type="submit" disabled={submitting}>
              {submitting ? "提交中…" : "发表评论"}
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
        !loading && <p className="van-comment-empty">还没有评论，来说两句吧。</p>
      )}

      {loading ? <p className="van-comment-loading">加载中…</p> : null}
      {!loading && hasMore ? (
        <div className="van-comment-pager">
          <button type="button" onClick={() => load(page + 1, true)}>
            加载更多评论（还有 {total - items.length} 条）
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
