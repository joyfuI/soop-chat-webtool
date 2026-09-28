import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  readSavedQueries,
  savedQueriesKey,
  writeSavedQueries,
} from '../src/savedQueries.ts';

test('saved SQL round trip, invalid data and storage failures', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  assert.deepEqual(readSavedQueries(storage), []);
  const queries = [
    { name: '최근 채팅', sql: 'SELECT * FROM events LIMIT 100;' },
  ];
  writeSavedQueries(storage, queries);
  assert.deepEqual(readSavedQueries(storage), queries);
  for (const invalid of [
    '{',
    '{}',
    '[null]',
    '[{"name":"","sql":"SELECT 1"}]',
    '[{"name":"x","sql":5}]',
    JSON.stringify([...queries, ...queries]),
  ]) {
    values.set(savedQueriesKey, invalid);
    assert.throws(() => readSavedQueries(storage));
  }
  const blocked = {
    getItem: () => {
      throw new Error('access denied');
    },
    setItem: () => {
      throw new Error('quota exceeded');
    },
  };
  assert.throws(() => readSavedQueries(blocked), /access denied/);
  assert.throws(() => writeSavedQueries(blocked, queries), /quota exceeded/);
  writeSavedQueries(storage, []);
  assert.deepEqual(readSavedQueries(storage), []);
});
