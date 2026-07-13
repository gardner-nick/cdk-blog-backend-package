const esbuild = require('esbuild');

esbuild
  .build({
    entryPoints: ['handler/src/index.ts'],
    bundle: true,
    platform: 'node',
    target: 'node24',
    outfile: 'dist/handler/index.js',
    // Only the base @aws-sdk/client-* packages are confirmed present in the
    // Node 24 Lambda runtime's preinstalled AWS SDK v3. Utility/wrapper
    // packages (lib-dynamodb, s3-request-presigner) are NOT part of that
    // bundle and must be bundled here, or they break at cold start with
    // MODULE_NOT_FOUND.
    external: ['@aws-sdk/client-dynamodb', '@aws-sdk/client-s3'],
    sourcemap: false,
    minify: false,
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
