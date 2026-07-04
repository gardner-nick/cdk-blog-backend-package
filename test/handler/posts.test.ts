import { mockClient } from 'aws-sdk-client-mock';
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import * as posts from '../../handler/src/db/posts';
import { HttpError } from '../../handler/src/http';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

function existingPostItem(overrides: Record<string, unknown> = {}) {
  return {
    PK: 'POST#hello',
    SK: 'META',
    GSI1PK: 'POSTS#draft',
    GSI1SK: '2026-01-01T00:00:00.000Z#hello',
    entityType: 'POST',
    slug: 'hello',
    title: 'Hello',
    content: 'Body',
    status: 'draft',
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('createPost', () => {
  it('derives a slug from the title when not provided', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    const post = await posts.createPost({
      title: 'Hello World!',
      content: 'Body',
      status: 'draft',
      tags: [],
    });

    expect(post.slug).toBe('hello-world');
  });

  it('writes only the META item when created as a draft (no tag items)', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    await posts.createPost({
      title: 'Hello',
      slug: 'hello',
      content: 'Body',
      status: 'draft',
      tags: ['a', 'b'],
    });

    const call = ddbMock.commandCalls(TransactWriteCommand)[0];
    const items = call.args[0].input.TransactItems ?? [];
    expect(items).toHaveLength(1);
    expect(items[0].Put?.Item?.SK).toBe('META');
  });

  it('writes META + one tag item per tag when created as published', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    await posts.createPost({
      title: 'Hello',
      slug: 'hello',
      content: 'Body',
      status: 'published',
      tags: ['a', 'b'],
    });

    const call = ddbMock.commandCalls(TransactWriteCommand)[0];
    const items = call.args[0].input.TransactItems ?? [];
    expect(items).toHaveLength(3);
    const tagItems = items.filter((i) => i.Put?.Item?.entityType === 'TAG');
    expect(tagItems.map((i) => i.Put?.Item?.tag).sort()).toEqual(['a', 'b']);
  });

  it('throws 409 on slug conflict (ConditionalCheckFailedException)', async () => {
    ddbMock.on(TransactWriteCommand).rejects(
      new ConditionalCheckFailedException({ message: 'conflict', $metadata: {} })
    );

    await expect(
      posts.createPost({ title: 'Hello', slug: 'hello', content: 'Body', status: 'draft', tags: [] })
    ).rejects.toMatchObject({ status: 409 } satisfies Partial<HttpError>);
  });

  it('throws 409 on slug conflict (TransactionCanceledException wrapping a conditional failure)', async () => {
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: 'cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      })
    );

    await expect(
      posts.createPost({ title: 'Hello', slug: 'hello', content: 'Body', status: 'draft', tags: [] })
    ).rejects.toMatchObject({ status: 409 } satisfies Partial<HttpError>);
  });
});

describe('getPost', () => {
  it('returns undefined when no item exists', async () => {
    ddbMock.on(GetCommand).resolves({});
    expect(await posts.getPost('missing')).toBeUndefined();
  });
});

describe('updatePost tag-diff transitions', () => {
  it('draft -> published adds a tag item for every tag', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingPostItem({ tags: ['a', 'b'] }) });
    ddbMock.on(TransactWriteCommand).resolves({});

    await posts.updatePost('hello', { status: 'published' });

    const call = ddbMock.commandCalls(TransactWriteCommand)[0];
    const items = call.args[0].input.TransactItems ?? [];
    const puts = items.filter((i) => i.Put);
    const deletes = items.filter((i) => i.Delete);
    expect(deletes).toHaveLength(0);
    // 1 META + 2 tag items
    expect(puts).toHaveLength(3);
    const tagPuts = puts.filter((i) => i.Put?.Item?.entityType === 'TAG');
    expect(tagPuts.map((i) => i.Put?.Item?.tag).sort()).toEqual(['a', 'b']);
  });

  it('published -> draft removes every tag item', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: existingPostItem({
        status: 'published',
        tags: ['a', 'b'],
        publishedAt: '2026-01-01T00:00:00.000Z',
      }),
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    await posts.updatePost('hello', { status: 'draft' });

    const call = ddbMock.commandCalls(TransactWriteCommand)[0];
    const items = call.args[0].input.TransactItems ?? [];
    const puts = items.filter((i) => i.Put);
    const deletes = items.filter((i) => i.Delete);
    // Only the META put remains; both tag items are deleted.
    expect(puts).toHaveLength(1);
    expect(puts[0].Put?.Item?.SK).toBe('META');
    expect(deletes).toHaveLength(2);
    expect(deletes.map((i) => i.Delete?.Key?.SK).sort()).toEqual(['TAG#a', 'TAG#b']);
  });

  it('published -> published diffs tags: adds new, removes dropped, refreshes kept', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: existingPostItem({
        status: 'published',
        tags: ['a', 'b'],
        publishedAt: '2026-01-01T00:00:00.000Z',
      }),
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    await posts.updatePost('hello', { tags: ['b', 'c'] });

    const call = ddbMock.commandCalls(TransactWriteCommand)[0];
    const items = call.args[0].input.TransactItems ?? [];
    const puts = items.filter((i) => i.Put);
    const deletes = items.filter((i) => i.Delete);

    // META + tag b (kept, refreshed) + tag c (new) = 3 puts
    expect(puts).toHaveLength(3);
    const tagPuts = puts.filter((i) => i.Put?.Item?.entityType === 'TAG');
    expect(tagPuts.map((i) => i.Put?.Item?.tag).sort()).toEqual(['b', 'c']);

    // tag a (dropped) = 1 delete
    expect(deletes).toHaveLength(1);
    expect(deletes[0].Delete?.Key?.SK).toBe('TAG#a');
  });

  it('draft -> draft never touches tag items even if tags change', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingPostItem({ tags: ['a'] }) });
    ddbMock.on(TransactWriteCommand).resolves({});

    await posts.updatePost('hello', { tags: ['z'] });

    const call = ddbMock.commandCalls(TransactWriteCommand)[0];
    const items = call.args[0].input.TransactItems ?? [];
    expect(items).toHaveLength(1);
    expect(items[0].Put?.Item?.SK).toBe('META');
  });

  it('throws 404 when the post does not exist', async () => {
    ddbMock.on(GetCommand).resolves({});
    await expect(posts.updatePost('missing', { title: 'x' })).rejects.toMatchObject({
      status: 404,
    } satisfies Partial<HttpError>);
  });
});

describe('listPostsByStatus', () => {
  it('queries GSI1 with the status partition and passes through cursor/limit', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });

    await posts.listPostsByStatus({ status: 'published', limit: 10 });

    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.IndexName).toBe('GSI1');
    expect(call.args[0].input.ExpressionAttributeValues).toEqual({ ':pk': 'POSTS#published' });
    expect(call.args[0].input.Limit).toBe(10);
    expect(call.args[0].input.ScanIndexForward).toBe(false);
  });

  it('round-trips a cursor from LastEvaluatedKey to nextCursor', async () => {
    const lastKey = { PK: 'POST#x', SK: 'META', GSI1PK: 'POSTS#published', GSI1SK: '2026-01-01#x' };
    ddbMock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: lastKey });

    const result = await posts.listPostsByStatus({ status: 'published', limit: 10 });
    expect(result.nextCursor).toBeDefined();

    const decoded = JSON.parse(Buffer.from(result.nextCursor as string, 'base64url').toString('utf8'));
    expect(decoded).toEqual(lastKey);
  });
});

describe('deletePost', () => {
  it('throws 404 when the post partition is empty', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await expect(posts.deletePost('missing')).rejects.toMatchObject({
      status: 404,
    } satisfies Partial<HttpError>);
  });

  it('deletes every item found in the partition', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { PK: 'POST#hello', SK: 'META' },
        { PK: 'POST#hello', SK: 'TAG#a' },
        { PK: 'POST#hello', SK: 'COMMENT#2026-01-01#1' },
      ],
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    await posts.deletePost('hello');

    const call = ddbMock.commandCalls(TransactWriteCommand)[0];
    const items = call.args[0].input.TransactItems ?? [];
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.Delete)).toBe(true);
  });
});
