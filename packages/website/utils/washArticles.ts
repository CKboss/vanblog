export const washArticlesByKey = (
  rawArticles: any[],
  getValueFn: (val: any) => any,
  isKeyArray: boolean
) => {
  const articles = {} as any;

  const dates = Array.from(
    new Set(
      isKeyArray
        ? rawArticles.flatMap((a) => getValueFn(a))
        : rawArticles.map((a) => getValueFn(a))
    )
  );

  for (const date of dates) {
    const curArticles = rawArticles
      .filter((each) =>
        isKeyArray ? getValueFn(each).includes(date) : getValueFn(each) == date
      )
      .map((each) => ({
        title: each.title,
        id: each.id,
        // 分类页/标签页的链接由 getArticlePath() 生成（pathname || id），
        // 这里如果把 pathname 洗掉，设置了自定义路径的文章会退回 /post/<数字id>。
        pathname: each.pathname,
        createdAt: each.createdAt,
        updatedAt: each.updatedAt,
      }))
      .sort(
        (prev, next) =>
          new Date(next.createdAt).getTime() -
          new Date(prev.createdAt).getTime()
      );

    articles[String(date)] = curArticles;
  }

  return articles;
};
