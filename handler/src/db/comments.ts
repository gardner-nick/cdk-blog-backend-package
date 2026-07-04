import { randomUUID } from 'crypto';
import { DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from './client';
import { config } from '../config';
import { HttpError } from '../http';
import { encodeCursor, decodeCursor, queryWithCursorGuard } from '../cursor';
import { KEY_PREFIX } from '../../../src/constants';
import type { CreateCommentInput } from '../validation';

export interface Comment {
  id: string;
  slug: string;
  author: string;
  body: string;
  createdAt: string;
}

interface CommentItem {
  PK: string;
  SK: string;
  entityType: 'COMMENT';
  id: string;
  slug: string;
  author: string;
  body: string;
  createdAt: string;
}

function postPK(slug: string): string {
  return `${KEY_PREFIX.POST}${slug}`;
}

function commentSK(createdAt: string, id: string): string {
  return `${KEY_PREFIX.COMMENT}${createdAt}#${id}`;
}

function toComment(item: CommentItem): Comment {
  return { id: item.id, slug: item.slug, author: item.author, body: item.body, createdAt: item.createdAt };
}

export interface ListCommentsResult {
  items: Comment[];
  nextCursor?: string;
}

export async function listComments(params: {
  slug: string;
  limit: number;
  cursor?: string;
}): Promise<ListCommentsResult> {
  const result = await queryWithCursorGuard(params.cursor, () =>
    docClient.send(
      new QueryCommand({
        TableName: config.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        ExpressionAttributeValues: { ':pk': postPK(params.slug), ':skPrefix': KEY_PREFIX.COMMENT },
        ScanIndexForward: false,
        Limit: params.limit,
        ExclusiveStartKey: params.cursor ? decodeCursor(params.cursor) : undefined,
      })
    )
  );

  return {
    items: (result.Items ?? []).map((item) => toComment(item as CommentItem)),
    nextCursor: encodeCursor(result.LastEvaluatedKey),
  };
}

export async function createComment(slug: string, input: CreateCommentInput): Promise<Comment> {
  const now = new Date().toISOString();
  const id = randomUUID();

  const item: CommentItem = {
    PK: postPK(slug),
    SK: commentSK(now, id),
    entityType: 'COMMENT',
    id,
    slug,
    author: input.author,
    body: input.body,
    createdAt: now,
  };

  await docClient.send(new PutCommand({ TableName: config.tableName, Item: item }));

  return toComment(item);
}

export async function deleteComment(slug: string, id: string): Promise<void> {
  // The filter is applied after each 1MB page is read, so keep paging until
  // the id shows up — otherwise comments past the first page can never be
  // found (and so never deleted).
  let item: CommentItem | undefined;
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: config.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        FilterExpression: '#id = :id',
        ExpressionAttributeNames: { '#id': 'id' },
        ExpressionAttributeValues: { ':pk': postPK(slug), ':skPrefix': KEY_PREFIX.COMMENT, ':id': id },
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    item = (result.Items ?? [])[0] as CommentItem | undefined;
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (!item && exclusiveStartKey);

  if (!item) {
    throw new HttpError(404, 'not_found', `No comment found with id "${id}".`);
  }

  await docClient.send(
    new DeleteCommand({ TableName: config.tableName, Key: { PK: item.PK, SK: item.SK } })
  );
}
