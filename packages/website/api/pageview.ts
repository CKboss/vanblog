const DEFAULT_PAGEVIEW_RESPONSE = { viewer: 0, visited: 0 };

export interface PageViewData {
  viewer: number;
  visited: number;
}

/**
 * 把接口回来的 payload 收敛成合法的 PageViewData。
 *
 * ⚠️ 以前两个函数都是 `return statusCode === 233 ? DEFAULT : data`：
 * 接口报错（statusCode 500、data 缺失）时会把 **undefined 原样返回**，
 * 调用方（pages/_app.tsx）`const { viewer, visited } = await updatePageview(...)`
 * 对 undefined 解构抛 TypeError —— 变成一次没人处理的 promise rejection，
 * 页脚统计静默停在旧值，日志里只有一行解构栈、看不出是统计接口的问题。
 * 现在非法 payload 一律回默认值并留下 console.warn 痕迹
 * （统计是非关键路径：让页面活着 + 留日志，比抛出去好）。
 * 网络层失败（fetch 本身抛错）仍然向上抛，由调用方决定怎么处理。
 */
export function normalizePageviewPayload(
  statusCode: unknown,
  data: unknown
): PageViewData {
  if (statusCode === 233) {
    return DEFAULT_PAGEVIEW_RESPONSE;
  }
  const candidate = data as Partial<PageViewData> | null | undefined;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    typeof candidate.viewer !== "number" ||
    typeof candidate.visited !== "number"
  ) {
    console.warn(
      "[访客统计] 接口返回了不可用的 payload（statusCode=%s）",
      statusCode
    );
    return DEFAULT_PAGEVIEW_RESPONSE;
  }
  return { viewer: candidate.viewer, visited: candidate.visited };
}

async function requestPageview(url: string, method: "GET" | "POST") {
  const res = await fetch(url, { method });
  const json = await res.json().catch(() => null);
  return normalizePageviewPayload(json?.statusCode, json?.data);
}

export const getPageview = async (
  pathname: string
): Promise<PageViewData> => {
  return requestPageview(`/api/public/viewer`, "GET");
};

export const updatePageview = async (
  pathname: string
): Promise<PageViewData> => {
  const hasVisited = window.localStorage.getItem("visited");
  const hasVisitedCurrentPath = window.localStorage.getItem(
    `visited-${pathname}`
  );

  if (!hasVisited) {
    window.localStorage.setItem("visited", "true");
  }

  if (!hasVisitedCurrentPath) {
    window.localStorage.setItem(`visited-${pathname}`, "true");
  }

  return requestPageview(
    `/api/public/viewer?isNew=${!hasVisited}&isNewByPath=${!hasVisitedCurrentPath}`,
    "POST"
  );
};
