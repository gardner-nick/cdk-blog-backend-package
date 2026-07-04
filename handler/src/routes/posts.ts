import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { HttpError, created, noContent, ok } from '../http';
import {
  adminListQuerySchema,
  createPostSchema,
  listQuerySchema,
  parseJsonBody,
  updatePostSchema,
} from '../validation';
import * as posts from '../db/posts';
import { POST_STATUS } from '../../../src/constants';

export async function listPublicPosts(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
  const query = listQuerySchema.parse(event.queryStringParameters ?? {});

  const result = query.tag
    ? await posts.listPostsByTag({ tag: query.tag, limit: query.limit, cursor: query.cursor })
    : await posts.listPostsByStatus({
        status: POST_STATUS.PUBLISHED,
        limit: query.limit,
        cursor: query.cursor,
      });

  return ok({ items: result.items, nextCursor: result.nextCursor });
}

export async function getPublicPost(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
  const slug = event.pathParameters?.slug as string;
  const post = await posts.getPost(slug);
  if (!post || post.status !== POST_STATUS.PUBLISHED) {
    throw new HttpError(404, 'not_found', `No post found with slug "${slug}".`);
  }
  return ok(post);
}

export async function listAdminPosts(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
  const query = adminListQuerySchema.parse(event.queryStringParameters ?? {});

  if (query.status) {
    const result = await posts.listPostsByStatus({
      status: query.status,
      limit: query.limit,
      cursor: query.cursor,
    });
    return ok({ items: result.items, nextCursor: result.nextCursor });
  }

  const [draft, published] = await Promise.all([
    posts.listPostsByStatus({ status: POST_STATUS.DRAFT, limit: query.limit, cursor: query.cursor }),
    posts.listPostsByStatus({ status: POST_STATUS.PUBLISHED, limit: query.limit, cursor: query.cursor }),
  ]);

  return ok({ items: [...draft.items, ...published.items] });
}

export async function getAdminPost(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
  const slug = event.pathParameters?.slug as string;
  const post = await posts.getPost(slug);
  if (!post) {
    throw new HttpError(404, 'not_found', `No post found with slug "${slug}".`);
  }
  return ok(post);
}

export async function createPost(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
  const body = parseJsonBody(event.body);
  const input = createPostSchema.parse(body);
  const post = await posts.createPost(input);
  return created(post);
}

export async function updatePost(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
  const slug = event.pathParameters?.slug as string;
  const body = parseJsonBody(event.body);
  const input = updatePostSchema.parse(body);
  const post = await posts.updatePost(slug, input);
  return ok(post);
}

export async function deletePost(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
  const slug = event.pathParameters?.slug as string;
  await posts.deletePost(slug);
  return noContent();
}
