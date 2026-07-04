import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { HttpError, created, noContent, ok } from '../http';
import { createCommentSchema, listQuerySchema, parseJsonBody } from '../validation';
import * as comments from '../db/comments';
import * as posts from '../db/posts';
import { POST_STATUS } from '../../../src/constants';

async function assertPublishedPost(slug: string): Promise<void> {
  const post = await posts.getPost(slug);
  if (!post || post.status !== POST_STATUS.PUBLISHED) {
    throw new HttpError(404, 'not_found', `No post found with slug "${slug}".`);
  }
}

export async function listComments(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
  const slug = event.pathParameters?.slug as string;
  await assertPublishedPost(slug);
  const query = listQuerySchema.parse(event.queryStringParameters ?? {});
  const result = await comments.listComments({ slug, limit: query.limit, cursor: query.cursor });
  return ok({ items: result.items, nextCursor: result.nextCursor });
}

export async function createComment(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
  const slug = event.pathParameters?.slug as string;
  await assertPublishedPost(slug);
  const body = parseJsonBody(event.body);
  const input = createCommentSchema.parse(body);
  const comment = await comments.createComment(slug, input);
  return created(comment);
}

export async function deleteComment(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
  const slug = event.pathParameters?.slug as string;
  const id = event.pathParameters?.id as string;
  await comments.deleteComment(slug, id);
  return noContent();
}
