import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import * as postRoutes from '../../handler/src/routes/posts';
import { HttpError } from '../../handler/src/http';
import { buildEvent } from './events';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

describe('getPublicPost', () => {
  it('returns 404 for a draft post on the public route', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        PK: 'POST#hello',
        SK: 'META',
        slug: 'hello',
        title: 'Hello',
        content: 'Body',
        status: 'draft',
        tags: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    await expect(
      postRoutes.getPublicPost(buildEvent({ routeKey: 'GET /posts/{slug}', pathParameters: { slug: 'hello' } }))
    ).rejects.toMatchObject({ status: 404 } satisfies Partial<HttpError>);
  });

  it('returns the post when published', async () => {
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

    const result = await postRoutes.getPublicPost(
      buildEvent({ routeKey: 'GET /posts/{slug}', pathParameters: { slug: 'hello' } })
    );
    expect(result.statusCode).toBe(200);
  });
});

describe('createPost route validation', () => {
  it('propagates a ZodError for an invalid body (missing content)', async () => {
    const event = buildEvent({
      routeKey: 'POST /posts',
      body: JSON.stringify({ title: 'Hello' }),
    });

    await expect(postRoutes.createPost(event)).rejects.toMatchObject({ name: 'ZodError' });
  });
});
