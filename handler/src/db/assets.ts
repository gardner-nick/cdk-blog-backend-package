import { randomUUID } from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config';
import { HttpError } from '../http';
import type { PresignUploadInput } from '../validation';

const s3Client = new S3Client({});

export interface PresignUploadResult {
  uploadUrl: string;
  key: string;
  expiresInSeconds: number;
}

export async function presignUpload(input: PresignUploadInput): Promise<PresignUploadResult> {
  if (!config.assetsBucketName) {
    throw new HttpError(404, 'assets_disabled', 'Asset uploads are not enabled.');
  }

  const key = `${randomUUID()}-${input.fileName}`;
  const command = new PutObjectCommand({
    Bucket: config.assetsBucketName,
    Key: key,
    ContentType: input.contentType,
  });

  const uploadUrl = await getSignedUrl(s3Client, command, {
    expiresIn: config.presignExpirySeconds,
  });

  return { uploadUrl, key, expiresInSeconds: config.presignExpirySeconds };
}
