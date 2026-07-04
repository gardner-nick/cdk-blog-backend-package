// Shared between the construct (src/) and the Lambda handler (handler/src/).
// Keep this module free of aws-cdk-lib/constructs imports: it is bundled into
// the handler by esbuild, and pulling in CDK would bloat the Lambda bundle.

export const GSI1_NAME = 'GSI1';

export const ENV_VARS = {
  TABLE_NAME: 'TABLE_NAME',
  GSI1_NAME: 'GSI1_NAME',
  ASSETS_BUCKET_NAME: 'ASSETS_BUCKET_NAME',
  COMMENTS_ENABLED: 'COMMENTS_ENABLED',
  REQUIRE_AUTH_FOR_COMMENTS: 'REQUIRE_AUTH_FOR_COMMENTS',
  PRESIGN_EXPIRY_SECONDS: 'PRESIGN_EXPIRY_SECONDS',
} as const;

export const KEY_PREFIX = {
  POST: 'POST#',
  META: 'META',
  TAG: 'TAG#',
  COMMENT: 'COMMENT#',
  POSTS_STATUS: 'POSTS#',
} as const;

export const POST_STATUS = {
  DRAFT: 'draft',
  PUBLISHED: 'published',
} as const;

export type PostStatus = (typeof POST_STATUS)[keyof typeof POST_STATUS];

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;
export const DEFAULT_PRESIGN_EXPIRY_SECONDS = 15 * 60;
