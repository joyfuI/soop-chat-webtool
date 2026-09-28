export type SavedQuery = { name: string; sql: string };
export const savedQueriesKey = 'chat-collector-admin.saved-queries.v1';

export function readSavedQueries(
  storage: Pick<Storage, 'getItem'>,
): SavedQuery[] {
  const raw = storage.getItem(savedQueriesKey);
  if (raw === null) return [];
  const value: unknown = JSON.parse(raw);
  if (
    !Array.isArray(value) ||
    value.some(
      (query: unknown) =>
        !query ||
        typeof query !== 'object' ||
        !('name' in query) ||
        typeof query.name !== 'string' ||
        !query.name.trim() ||
        !('sql' in query) ||
        typeof query.sql !== 'string' ||
        !query.sql.trim(),
    )
  )
    throw new Error('저장된 쿼리 형식이 올바르지 않습니다.');
  const queries = value as SavedQuery[];
  if (new Set(queries.map((query) => query.name)).size !== queries.length)
    throw new Error('저장된 쿼리 이름이 중복되어 있습니다.');
  return queries.map(({ name, sql }) => ({ name, sql }));
}

export function writeSavedQueries(
  storage: Pick<Storage, 'setItem'>,
  queries: SavedQuery[],
) {
  storage.setItem(savedQueriesKey, JSON.stringify(queries));
}
