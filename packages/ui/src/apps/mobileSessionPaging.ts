export const WORK_SECTION_PAGE_SIZE = 3;

export type RowPage<T> = {
  visible: readonly T[];
  hiddenCount: number;
  canShowFewer: boolean;
};

export const pageRows = <T>(rows: readonly T[], visibleCount: number | undefined, pageSize: number): RowPage<T> => {
  const visible = rows.slice(0, visibleCount ?? pageSize);
  const hiddenCount = rows.length - visible.length;
  return { visible, hiddenCount, canShowFewer: rows.length > pageSize && hiddenCount === 0 };
};
