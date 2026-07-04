import { decodeCursor, encodeCursor } from '../../handler/src/cursor';
import { HttpError } from '../../handler/src/http';

describe('cursor', () => {
  it('round-trips a key through encode/decode', () => {
    const key = { PK: 'POST#a', SK: 'META', GSI1PK: 'POSTS#published', GSI1SK: '2026-01-01#a' };
    const cursor = encodeCursor(key);
    expect(cursor).toBeDefined();
    expect(decodeCursor(cursor as string)).toEqual(key);
  });

  it('round-trips a base-table key (PK/SK only, as returned by comment queries)', () => {
    const key = { PK: 'POST#a', SK: 'COMMENT#2026-01-01T00:00:00.000Z#1' };
    const cursor = encodeCursor(key);
    expect(cursor).toBeDefined();
    expect(decodeCursor(cursor as string)).toEqual(key);
  });

  it('returns undefined when encoding an undefined key', () => {
    expect(encodeCursor(undefined)).toBeUndefined();
  });

  it('rejects a cursor that is not valid base64/JSON', () => {
    expect(() => decodeCursor('not-valid-base64url!!!')).toThrow(HttpError);
  });

  it('rejects a cursor missing required key shape', () => {
    const badCursor = Buffer.from(JSON.stringify({ PK: 'POST#a' }), 'utf8').toString('base64url');
    expect(() => decodeCursor(badCursor)).toThrow(HttpError);
  });

  it('rejects a cursor whose keys are not strings', () => {
    const badCursor = Buffer.from(
      JSON.stringify({ PK: 1, SK: 'META', GSI1PK: 'x', GSI1SK: 'y' }),
      'utf8'
    ).toString('base64url');
    expect(() => decodeCursor(badCursor)).toThrow(HttpError);
  });
});
