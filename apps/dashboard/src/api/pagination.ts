export type PageResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export function hasNextPage(
  page: Pick<PageResult<unknown>, "page" | "pageSize" | "total">,
) {
  return page.page * page.pageSize < page.total;
}

export async function fetchAllPages<T, P extends PageResult<T>>(
  fetchPage: (page: number) => Promise<P>,
): Promise<P> {
  const first = await fetchPage(1);
  if (first.pageSize <= 0) return first;
  const pageCount = Math.ceil(first.total / first.pageSize);
  if (pageCount <= 1) return first;
  const remaining = await Promise.all(
    Array.from({ length: pageCount - 1 }, (_, index) => fetchPage(index + 2)),
  );
  return {
    ...first,
    items: [first, ...remaining].flatMap((page) => page.items),
  };
}
