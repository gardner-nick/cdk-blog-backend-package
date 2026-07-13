import { DEFAULT_PRESIGN_EXPIRY_SECONDS, ENV_VARS } from '../../src/constants';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  tableName: required(ENV_VARS.TABLE_NAME),
  gsi1Name: required(ENV_VARS.GSI1_NAME),
  assetsBucketName: process.env[ENV_VARS.ASSETS_BUCKET_NAME],
  assetsPublicBaseUrl: process.env[ENV_VARS.ASSETS_PUBLIC_BASE_URL],
  // Set only when a CDN is configured; without one, keys stay unprefixed.
  assetsKeyPrefix: process.env[ENV_VARS.ASSETS_KEY_PREFIX] ?? '',
  commentsEnabled: process.env[ENV_VARS.COMMENTS_ENABLED] !== 'false',
  presignExpirySeconds: process.env[ENV_VARS.PRESIGN_EXPIRY_SECONDS]
    ? Number(process.env[ENV_VARS.PRESIGN_EXPIRY_SECONDS])
    : DEFAULT_PRESIGN_EXPIRY_SECONDS,
};
