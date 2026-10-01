import { daysAgo } from "../../utils/relativeTime";

import useT from "../../hooks/useT";
// TODO: support expiration time
export default function (props: {
  updatedAt: Date;
  createdAt: Date;
  showExpirationReminder?: boolean;
  expirationDays?: number;
}) {
  // 🔴 期 10 第十二批：走 i18n 接缝（渲染期取）
  const t = useT();
  if (props.showExpirationReminder) {
    const diff = daysAgo(props.createdAt);

    if (diff > (props.expirationDays || 30)) {
      return (
        <div className="warning-card text-gray-600 dark:text-dark">
          <div>
            {/* 🔴 期 10 第十二批：这是"前半句 + 变量 + 中段 + 变量 + 后半句"的**拼接式**文案 ⇒
                改成**整句模板 + 两个占位符**（英文语序不同，只翻片段拼不出来；见 §7.209 B）。 */}
            {t("alert.outdatedNotice", "请注意，本文编写于 {created} 天前，最后修改于 {updated} 天前，其中某些信息可能已经过时。", {
              created: diff,
              updated: daysAgo(props.updatedAt),
            })}
          </div>
        </div>
      );
    }
  }

  return null;
}
