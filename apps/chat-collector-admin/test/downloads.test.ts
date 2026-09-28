import assert from 'node:assert/strict';
import { test } from 'node:test';

import { downloadTimestamp, toCsv } from '../src/downloads.ts';

test('download timestamps use local calendar dates, two-digit years and 24-hour time', () => {
  const previousTimezone = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Seoul';
    assert.equal(
      downloadTimestamp(Date.parse('2026-01-01T18:04:00Z')),
      '260102_0304',
    );
    assert.equal(
      downloadTimestamp(Date.parse('2025-12-31T15:00:00Z')),
      '260101_0000',
    );
    assert.equal(
      downloadTimestamp(Date.parse('2026-09-27T14:59:00Z')),
      '260927_2359',
    );
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test('CSV preserves columns, nulls, JSON, Korean, quotes and line breaks without executing text formulas', () => {
  assert.equal(toCsv([]), '');
  assert.equal(
    toCsv([
      {
        message: '한글, "채팅"\n다음 줄',
        empty: null,
        value: -12,
        data: { text: '안녕' },
      },
      { message: '=1+1', empty: '', value: 0, data: [1, 2] },
      { message: '  @SUM(A1)', value: false, data: undefined },
    ]),
    '\uFEFF"message","empty","value","data"\r\n' +
      '"한글, ""채팅""\n다음 줄","","-12","{""text"":""안녕""}"\r\n' +
      '"\'=1+1","","0","[1,2]"\r\n' +
      '"\'  @SUM(A1)","","false",""\r\n',
  );
  assert.equal(
    toCsv([{ '=header': '\tvalue', negative: '-text', positive: '+text' }]),
    '\uFEFF"\'=header","negative","positive"\r\n"\'\tvalue","\'-text","\'+text"\r\n',
  );
});
