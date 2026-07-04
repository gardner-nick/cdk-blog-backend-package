import { mockClient } from 'aws-sdk-client-mock';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import * as comments from '../../handler/src/db/comments';
import * as commentRoutes from '../../handler/src/routes/comments';
import { HttpError } from '../../handler/src/http';
import { buildEvent } from './events';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

describe('createComment', () => {
  it('writes a comment item keyed under the post partition with a COMMENT# SK', async () => {
    ddbMock.on(PutCommand).resolves({});

    const comment = await comments.createComment('hello', { author: 'Ada', body: 'Nice post' });

    const call = ddbMock.commandCalls(PutCommand)[0];
    expect(call.args[0].input.Item?.PK).toBe('POST#hello');
    expect((call.args[0].input.Item?.SK as string).startsWith('COMMENT#')).toBe(true);
    expect(comment.author).toBe('Ada');
  });
});

describe('listComments', () => {
  it('queries with begins_with on COMMENT#', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await comments.listComments({ slug: 'hello', limit: 10 });

    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.KeyConditionExpression).toContain('begins_with');
    expect(call.args[0].input.ExpressionAttributeValues).toMatchObject({
      ':pk': 'POST#hello',
      ':skPrefix': 'COMMENT#',
    });
  });

  it('round-trips a base-table (PK/SK only) cursor across two pages without throwing', async () => {
    const lastKey = { PK: 'POST#hello', SK: 'COMMENT#2026-01-01T00:00:00.000Z#1' };
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [], LastEvaluatedKey: lastKey })
      .resolvesOnce({ Items: [] });

    const page1 = await comments.listComments({ slug: 'hello', limit: 10 });
    expect(page1.nextCursor).toBeDefined();

    await expect(
      comments.listComments({ slug: 'hello', limit: 10, cursor: page1.nextCursor })
    ).resolves.toBeDefined();

    const secondCall = ddbMock.commandCalls(QueryCommand)[1];
    expect(secondCall.args[0].input.ExclusiveStartKey).toEqual(lastKey);
  });
});

describe('deleteComment', () => {
  it('throws 404 when no matching comment id is found', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await expect(comments.deleteComment('hello', 'missing-id')).rejects.toMatchObject({
      status: 404,
    } satisfies Partial<HttpError>);
  });

  it('deletes the matched comment item', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ PK: 'POST#hello', SK: 'COMMENT#2026-01-01#abc', id: 'abc' }],
    });
    ddbMock.on(DeleteCommand).resolves({});

    await comments.deleteComment('hello', 'abc');

    const call = ddbMock.commandCalls(DeleteCommand)[0];
    expect(call.args[0].input.Key).toEqual({ PK: 'POST#hello', SK: 'COMMENT#2026-01-01#abc' });
  });
});

describe('comments disabled via route guard (draft post 404s)', () => {
  it('listComments route 404s when the underlying post is a draft', async () => {
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
      commentRoutes.listComments(
        buildEvent({ routeKey: 'GET /posts/{slug}/comments', pathParameters: { slug: 'hello' } })
      )
    ).rejects.toMatchObject({ status: 404 } satisfies Partial<HttpError>);
  });
});
