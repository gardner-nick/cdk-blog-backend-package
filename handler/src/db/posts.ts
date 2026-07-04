import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { docClient } from './client';
import { config } from '../config';
import { HttpError } from '../http';
import { encodeCursor, decodeCursor } from '../cursor';
import { KEY_PREFIX, POST_STATUS, PostStatus } from '../../../src/constants';
import type { CreatePostInput, UpdatePostInput } from '../validation';

export interface Post {
  slug: string;
  title: string;
  excerpt?: string;
  content: string;
  status: PostStatus;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
}

interface PostItem {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  entityType: 'POST';
  slug: string;
  title: string;
  excerpt?: string;
  content: string;
  status: PostStatus;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
}

interface TagItem {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  entityType: 'TAG';
  slug: string;
  tag: string;
  title: string;
  excerpt?: string;
  publishedAt: string;
}

function postPK(slug: string): string {
  return `${KEY_PREFIX.POST}${slug}`;
}

function tagSK(tag: string): string {
  return `${KEY_PREFIX.TAG}${tag}`;
}

function sortDateFor(item: { status: PostStatus; publishedAt?: string; createdAt: string }): string {
  return item.status === POST_STATUS.PUBLISHED && item.publishedAt ? item.publishedAt : item.createdAt;
}

function toPost(item: PostItem): Post {
  return {
    slug: item.slug,
    title: item.title,
    excerpt: item.excerpt,
    content: item.content,
    status: item.status,
    tags: item.tags,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    publishedAt: item.publishedAt,
  };
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildPostItem(params: {
  slug: string;
  title: string;
  excerpt?: string;
  content: string;
  status: PostStatus;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
}): PostItem {
  return {
    PK: postPK(params.slug),
    SK: KEY_PREFIX.META,
    GSI1PK: `${KEY_PREFIX.POSTS_STATUS}${params.status}`,
    GSI1SK: `${sortDateFor(params)}#${params.slug}`,
    entityType: 'POST',
    slug: params.slug,
    title: params.title,
    excerpt: params.excerpt,
    content: params.content,
    status: params.status,
    tags: params.tags,
    createdAt: params.createdAt,
    updatedAt: params.updatedAt,
    publishedAt: params.publishedAt,
  };
}

function buildTagItem(post: PostItem, tag: string): TagItem {
  return {
    PK: post.PK,
    SK: tagSK(tag),
    GSI1PK: `${KEY_PREFIX.TAG}${tag}`,
    GSI1SK: `${post.publishedAt}#${post.slug}`,
    entityType: 'TAG',
    slug: post.slug,
    tag,
    title: post.title,
    excerpt: post.excerpt,
    publishedAt: post.publishedAt as string,
  };
}

export async function getPost(slug: string): Promise<Post | undefined> {
  const result = await docClient.send(
    new GetCommand({
      TableName: config.tableName,
      Key: { PK: postPK(slug), SK: KEY_PREFIX.META },
    })
  );
  if (!result.Item) return undefined;
  return toPost(result.Item as PostItem);
}

export async function createPost(input: CreatePostInput): Promise<Post> {
  const slug = input.slug ?? slugify(input.title);
  if (!slug) {
    throw new HttpError(400, 'invalid_slug', 'Could not derive a slug from the title.');
  }

  const now = new Date().toISOString();
  const status = input.status;
  const publishedAt = status === POST_STATUS.PUBLISHED ? now : undefined;

  const postItem = buildPostItem({
    slug,
    title: input.title,
    excerpt: input.excerpt,
    content: input.content,
    status,
    tags: input.tags,
    createdAt: now,
    updatedAt: now,
    publishedAt,
  });

  const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
    {
      Put: {
        TableName: config.tableName,
        Item: postItem,
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    },
  ];

  if (status === POST_STATUS.PUBLISHED) {
    for (const tag of input.tags) {
      transactItems.push({
        Put: { TableName: config.tableName, Item: buildTagItem(postItem, tag) },
      });
    }
  }

  try {
    await docClient.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (err) {
    if (isConditionalCheckFailure(err)) {
      throw new HttpError(409, 'slug_conflict', `A post with slug "${slug}" already exists.`);
    }
    throw err;
  }

  return toPost(postItem);
}

export async function updatePost(slug: string, input: UpdatePostInput): Promise<Post> {
  const existingResult = await docClient.send(
    new GetCommand({
      TableName: config.tableName,
      Key: { PK: postPK(slug), SK: KEY_PREFIX.META },
    })
  );
  const existing = existingResult.Item as PostItem | undefined;
  if (!existing) {
    throw new HttpError(404, 'not_found', `No post found with slug "${slug}".`);
  }

  const now = new Date().toISOString();
  const nextStatus = input.status ?? existing.status;
  const wasPublished = existing.status === POST_STATUS.PUBLISHED;
  const willBePublished = nextStatus === POST_STATUS.PUBLISHED;
  const publishedAt = willBePublished ? existing.publishedAt ?? now : undefined;

  const updated = buildPostItem({
    slug: existing.slug,
    title: input.title ?? existing.title,
    excerpt: input.excerpt ?? existing.excerpt,
    content: input.content ?? existing.content,
    status: nextStatus,
    tags: input.tags ?? existing.tags,
    createdAt: existing.createdAt,
    updatedAt: now,
    publishedAt,
  });

  const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
    {
      Put: {
        TableName: config.tableName,
        Item: updated,
        ConditionExpression: 'attribute_exists(PK)',
      },
    },
  ];

  const previousTags = new Set(wasPublished ? existing.tags : []);
  const nextTags = new Set(willBePublished ? updated.tags : []);

  // Put (not just add) every surviving/new tag: this also refreshes the
  // denormalized list-view fields (title, excerpt, publishedAt) on tags that
  // persisted across the update.
  for (const tag of nextTags) {
    transactItems.push({ Put: { TableName: config.tableName, Item: buildTagItem(updated, tag) } });
  }

  for (const tag of previousTags) {
    if (!nextTags.has(tag)) {
      transactItems.push({
        Delete: { TableName: config.tableName, Key: { PK: existing.PK, SK: tagSK(tag) } },
      });
    }
  }

  try {
    await docClient.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (err) {
    if (isConditionalCheckFailure(err)) {
      throw new HttpError(404, 'not_found', `No post found with slug "${slug}".`);
    }
    throw err;
  }

  return toPost(updated);
}

export async function deletePost(slug: string): Promise<void> {
  const pk = postPK(slug);
  const items: Array<{ PK: string; SK: string }> = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: config.tableName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': pk },
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    for (const item of result.Items ?? []) {
      items.push({ PK: item.PK, SK: item.SK });
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  if (items.length === 0) {
    throw new HttpError(404, 'not_found', `No post found with slug "${slug}".`);
  }

  const BATCH_SIZE = 25;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    await docClient.send(
      new TransactWriteCommand({
        TransactItems: batch.map((key) => ({
          Delete: { TableName: config.tableName, Key: key },
        })),
      })
    );
  }
}

export interface ListPostsResult {
  items: Post[];
  nextCursor?: string;
}

export async function listPostsByStatus(params: {
  status: PostStatus;
  limit: number;
  cursor?: string;
}): Promise<ListPostsResult> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: config.tableName,
      IndexName: config.gsi1Name,
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': `${KEY_PREFIX.POSTS_STATUS}${params.status}` },
      ScanIndexForward: false,
      Limit: params.limit,
      ExclusiveStartKey: params.cursor ? decodeCursor(params.cursor) : undefined,
    })
  );

  return {
    items: (result.Items ?? []).map((item) => toPost(item as PostItem)),
    nextCursor: encodeCursor(result.LastEvaluatedKey),
  };
}

export async function listPostsByTag(params: {
  tag: string;
  limit: number;
  cursor?: string;
}): Promise<ListPostsResult> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: config.tableName,
      IndexName: config.gsi1Name,
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': `${KEY_PREFIX.TAG}${params.tag}` },
      ScanIndexForward: false,
      Limit: params.limit,
      ExclusiveStartKey: params.cursor ? decodeCursor(params.cursor) : undefined,
    })
  );

  return {
    items: (result.Items ?? []).map((item) => {
      const tagItem = item as TagItem;
      return {
        slug: tagItem.slug,
        title: tagItem.title,
        excerpt: tagItem.excerpt,
        content: '',
        status: POST_STATUS.PUBLISHED,
        tags: [tagItem.tag],
        createdAt: tagItem.publishedAt,
        updatedAt: tagItem.publishedAt,
        publishedAt: tagItem.publishedAt,
      };
    }),
    nextCursor: encodeCursor(result.LastEvaluatedKey),
  };
}

function isConditionalCheckFailure(err: unknown): boolean {
  if (err instanceof ConditionalCheckFailedException) return true;
  if (err instanceof TransactionCanceledException) {
    return (err.CancellationReasons ?? []).some((r) => r.Code === 'ConditionalCheckFailed');
  }
  return false;
}
