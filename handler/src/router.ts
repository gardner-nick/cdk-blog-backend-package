import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { config } from './config';
import { HttpError } from './http';
import * as postRoutes from './routes/posts';
import * as commentRoutes from './routes/comments';
import * as assetRoutes from './routes/assets';

export type RouteFn = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>;

function buildRoutes(): Record<string, RouteFn> {
  const routes: Record<string, RouteFn> = {
    'GET /posts': postRoutes.listPublicPosts,
    'GET /posts/{slug}': postRoutes.getPublicPost,
    'POST /posts': postRoutes.createPost,
    'PUT /posts/{slug}': postRoutes.updatePost,
    'DELETE /posts/{slug}': postRoutes.deletePost,
    'GET /admin/posts': postRoutes.listAdminPosts,
    'GET /admin/posts/{slug}': postRoutes.getAdminPost,
  };

  if (config.commentsEnabled) {
    routes['GET /posts/{slug}/comments'] = commentRoutes.listComments;
    routes['POST /posts/{slug}/comments'] = commentRoutes.createComment;
    routes['DELETE /posts/{slug}/comments/{id}'] = commentRoutes.deleteComment;
  }

  if (config.assetsBucketName) {
    routes['POST /assets/presign-upload'] = assetRoutes.presignAssetUpload;
  }

  return routes;
}

let routesCache: Record<string, RouteFn> | undefined;

function getRoutes(): Record<string, RouteFn> {
  if (!routesCache) {
    routesCache = buildRoutes();
  }
  return routesCache;
}

export async function dispatch(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
  const routeKey = event.routeKey;
  const route = getRoutes()[routeKey];
  if (!route) {
    throw new HttpError(404, 'not_found', `No route matches "${routeKey}".`);
  }
  return route(event);
}
