import { BytemdPlugin } from "bytemd";
import remarkDirective from "remark-directive";
import { visit } from "unist-util-visit";

/**
 * 🔴 **站长裁定（2026-10-01）：markdown 管线保持现状（这 5 个容器标题不接多语言）。**
 *
 * 为什么当时没接（两条技术原因，都已实测）：
 * ① 这些标题是在 **remark 插件**里写进 markdown AST 的（`customContainerPlugin`），
 *    使用点**不在 React 渲染期** ⇒ 拿不到 `useT()`；
 * ② 🔴 更关键：两个消费方（`MarkdownBase.tsx`、`MarkdownPlain.tsx`）的插件数组是
 *    **`useMemo(…, [])`（空依赖）** ⇒ 插件只在**挂载时构建一次**，
 *    即使把 `t` 传进来，**切换语种也不会重建插件** ⇒ 标题会永远停在挂载时那个语种。
 *    要修就得把语种加进依赖数组，而 `__tests__/perfBudget.spec.ts` 钉着
 *    "列表页首屏不加载重型 markdown 依赖"⇒ 改依赖会让**每次切语种都重建整条 markdown 管线**，
 *    性能与那条判据都要重新评估。
 * 👉 站长裁定**保持现状** ⇒ 这 5 条在收口台账里是**永久例外**（不是欠条），
 *    并且 🔴 **译文刻意不进词典**（进了就是孤儿 key，覆盖率对账第 ② 条会红）。
 * ⚠️ 如实说明后果：英文/繁中界面下，markdown 里的 `:::note` 等容器标题**仍然显示中文**
 *    （注 / 相关信息 / 注意 / 警告 / 提示）。这是**裁定接受**的结果，不是漏翻。
 */
const CUSTOM_CONTAINER_TITLE: Record<string, string> = {
  note: "注",
  info: "相关信息",
  warning: "注意",
  danger: "警告",
  tip: "提示",
};

// FIXME: Addd Types
const customContainerPlugin = () => (tree) => {
  visit(tree, (node) => {
    if (
      node.type === "textDirective" ||
      node.type === "leafDirective" ||
      node.type === "containerDirective"
    ) {
      if (node.type == "containerDirective") {
        const { attributes, name: tagName } = node;
        const data = node.data ??= {};
        // 和后台编辑器一致：写了 title 用它，其次查内置映射，最后回落到容器名本身
        const title =
          attributes?.title || CUSTOM_CONTAINER_TITLE[tagName] || tagName;
        const cls = `custom-container ${tagName}`;

        data.hName = "div";
        data.hProperties = {
          class: cls,
          ["type"]: title,
        };
        const toAppendP = {
          type: "paragraph",
          data: {
            hProperties: {
              class: `custom-container-title ${tagName}`
            }
          },
          children: [
            {
              type: "text",
              value: title,
            }
          ]
        }
        node.children = [
          toAppendP,
          ...node.children
        ]
      }
    }
  });
};

export function customContainer(): BytemdPlugin {
  return {
    remark: (processor) =>
      processor.use(remarkDirective).use(customContainerPlugin),
  };
}
