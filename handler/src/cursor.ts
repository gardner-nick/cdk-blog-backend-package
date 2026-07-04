import { HttpError } from './http';

// The shapes of LastEvaluatedKey this API ever hands back to a client:
// - base-table queries (comments): { PK, SK }
// - GSI1 queries (post list, tag list): { PK, SK, GSI1PK, GSI1SK }
export interface Cursor {
  PK: string;
  SK: string;
  GSI1PK?: string;
  GSI1SK?: string;
}

const REQUIRED_CURSOR_KEYS = ['PK', 'SK'] as const;
const OPTIONAL_CURSOR_KEYS = ['GSI1PK', 'GSI1SK'] as const;

export function encodeCursor(key: Record<string, unknown> | undefined): string | undefined {
  if (!key) return undefined;
  const json = JSON.stringify(key);
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): Cursor {
  let parsed: unknown;
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    throw new HttpError(400, 'invalid_cursor', 'Cursor is not valid.');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new HttpError(400, 'invalid_cursor', 'Cursor is not valid.');
  }

  const record = parsed as Record<string, unknown>;
  for (const key of REQUIRED_CURSOR_KEYS) {
    if (typeof record[key] !== 'string') {
      throw new HttpError(400, 'invalid_cursor', 'Cursor is not valid.');
    }
  }
  for (const key of OPTIONAL_CURSOR_KEYS) {
    if (key in record && typeof record[key] !== 'string') {
      throw new HttpError(400, 'invalid_cursor', 'Cursor is not valid.');
    }
  }

  return record as unknown as Cursor;
}

// A structurally valid cursor can still name the wrong partition (e.g. a
// nextCursor from GET /posts?tag=x replayed against GET /posts). DynamoDB
// rejects such an ExclusiveStartKey with a ValidationException; when the key
// came from a client cursor that's a bad request, not a server error.
export async function queryWithCursorGuard<T>(
  cursor: string | undefined,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (cursor && err instanceof Error && err.name === 'ValidationException') {
      throw new HttpError(400, 'invalid_cursor', 'Cursor is not valid.');
    }
    throw err;
  }
}
