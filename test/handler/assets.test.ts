jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://example-bucket.s3.amazonaws.com/signed-url'),
}));

import { HttpError } from '../../handler/src/http';

describe('presignUpload', () => {
  const originalBucket = process.env.ASSETS_BUCKET_NAME;

  afterEach(() => {
    process.env.ASSETS_BUCKET_NAME = originalBucket;
    jest.clearAllMocks();
    jest.resetModules();
  });

  it('throws 404 when assets are not enabled (no bucket configured)', async () => {
    delete process.env.ASSETS_BUCKET_NAME;
    jest.resetModules();
    const { presignUpload } = await import('../../handler/src/db/assets');

    await expect(
      presignUpload({ fileName: 'photo.png', contentType: 'image/png' })
    ).rejects.toMatchObject({ status: 404 } satisfies Partial<HttpError>);
  });

  it('returns a signed URL and generated key when assets are enabled', async () => {
    process.env.ASSETS_BUCKET_NAME = 'my-bucket';
    jest.resetModules();
    const { presignUpload } = await import('../../handler/src/db/assets');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

    const result = await presignUpload({ fileName: 'photo.png', contentType: 'image/png' });

    expect(result.uploadUrl).toBe('https://example-bucket.s3.amazonaws.com/signed-url');
    expect(result.key.endsWith('-photo.png')).toBe(true);
    expect(getSignedUrl).toHaveBeenCalled();
  });
});
