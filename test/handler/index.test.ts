import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { handler } from '../../handler/src/index';
import { buildEvent } from './events';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

describe('top-level handler error mapping', () => {
  it('maps HttpError to its status with an error envelope', async () => {
    ddbMock.on(GetCommand).resolves({});
    const result = await handler(
      buildEvent({ routeKey: 'GET /posts/{slug}', pathParameters: { slug: 'missing' } })
    );
    expect(result).toMatchObject({ statusCode: 404 });
    const body = JSON.parse((result as { body: string }).body);
    expect(body.error).toBe('not_found');
  });

  it('maps a ZodError to 400 with an issues array', async () => {
    const result = await handler(
      buildEvent({ routeKey: 'POST /posts', body: JSON.stringify({ title: 'x' }) })
    );
    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body);
    expect(body.error).toBe('validation_error');
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it('maps an unexpected error to a generic 500', async () => {
    ddbMock.on(GetCommand).rejects(new Error('boom'));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handler(
      buildEvent({ routeKey: 'GET /posts/{slug}', pathParameters: { slug: 'hello' } })
    );

    expect(result).toMatchObject({ statusCode: 500 });
    const body = JSON.parse((result as { body: string }).body);
    expect(body.error).toBe('internal_error');
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('returns lists as { items, nextCursor } and single items bare', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        PK: 'POST#hello',
        SK: 'META',
        slug: 'hello',
        title: 'Hello',
        content: 'Body',
        status: 'published',
        tags: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        publishedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const result = await handler(
      buildEvent({ routeKey: 'GET /posts/{slug}', pathParameters: { slug: 'hello' } })
    );
    const body = JSON.parse((result as { body: string }).body);
    expect(body.slug).toBe('hello');
    expect(body.items).toBeUndefined();
  });
});
