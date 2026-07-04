import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { dispatch } from '../../handler/src/router';
import { HttpError } from '../../handler/src/http';
import { buildEvent } from './events';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

describe('router dispatch', () => {
  it('throws a 404 HttpError for an unregistered routeKey', async () => {
    await expect(dispatch(buildEvent({ routeKey: 'PATCH /nope' }))).rejects.toMatchObject({
      status: 404,
    } satisfies Partial<HttpError>);
  });

  it('dispatches a registered route to its handler', async () => {
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

    const result = await dispatch(
      buildEvent({ routeKey: 'GET /posts/{slug}', pathParameters: { slug: 'hello' } })
    );

    expect(result.statusCode).toBe(200);
    const body = JSON.parse((result as { body: string }).body);
    expect(body.slug).toBe('hello');
  });
});
