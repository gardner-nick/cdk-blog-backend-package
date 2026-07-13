jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://example-bucket.s3.amazonaws.com/signed-url'),
}));

import { HttpError } from '../../handler/src/http';

describe('presignUpload', () => {
  const ENV_KEYS = ['ASSETS_BUCKET_NAME', 'ASSETS_PUBLIC_BASE_URL', 'ASSETS_KEY_PREFIX'] as const;
  const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  afterEach(() => {
    // Assigning undefined to process.env coerces to the string "undefined",
    // so unset keys must be deleted rather than restored by assignment.
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
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

  it('returns a signed URL and a prefixed key when assets are enabled', async () => {
    process.env.ASSETS_BUCKET_NAME = 'my-bucket';
    delete process.env.ASSETS_PUBLIC_BASE_URL;
    jest.resetModules();
    const { presignUpload } = await import('../../handler/src/db/assets');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

    const result = await presignUpload({ fileName: 'photo.png', contentType: 'image/png' });

    expect(result.uploadUrl).toBe('https://example-bucket.s3.amazonaws.com/signed-url');
    expect(result.key).toMatch(/^assets\/.+-photo\.png$/);
    expect(result.publicUrl).toBeUndefined();
    expect(getSignedUrl).toHaveBeenCalled();
  });

  it('includes a publicUrl when a CDN base URL is configured', async () => {
    process.env.ASSETS_BUCKET_NAME = 'my-bucket';
    process.env.ASSETS_PUBLIC_BASE_URL = 'https://cdn.example.com';
    jest.resetModules();
    const { presignUpload } = await import('../../handler/src/db/assets');

    const result = await presignUpload({ fileName: 'photo.png', contentType: 'image/png' });

    expect(result.publicUrl).toBe(`https://cdn.example.com/${result.key}`);
  });

  it('URL-encodes the fileName in publicUrl but not in the key', async () => {
    process.env.ASSETS_BUCKET_NAME = 'my-bucket';
    process.env.ASSETS_PUBLIC_BASE_URL = 'https://cdn.example.com';
    jest.resetModules();
    const { presignUpload } = await import('../../handler/src/db/assets');

    const result = await presignUpload({ fileName: 'my photo.png', contentType: 'image/png' });

    expect(result.key.endsWith('-my photo.png')).toBe(true);
    expect(result.publicUrl).toContain('%20photo.png');
  });

  it('honors a custom key prefix', async () => {
    process.env.ASSETS_BUCKET_NAME = 'my-bucket';
    process.env.ASSETS_KEY_PREFIX = 'img';
    jest.resetModules();
    const { presignUpload } = await import('../../handler/src/db/assets');

    const result = await presignUpload({ fileName: 'photo.png', contentType: 'image/png' });

    expect(result.key).toMatch(/^img\//);
  });
});
