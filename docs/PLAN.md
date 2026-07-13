# Plan: `cdk-blog-backend` — reusable CDK construct for a serverless blog backend

## Context

Greenfield npm package. Goal: a TypeScript CDK construct library where a consumer writes `new BlogBackend(this, 'Blog', {...})` and gets a complete blog API. Decisions confirmed:

- **Storage**: DynamoDB single-table for posts/comments; **optional** S3 assets bucket (presigned upload URLs) behind a prop.
- **API**: API Gateway **HTTP API** (apigatewayv2).
- **Compute**: **one Lambda** with an internal router for all routes.
- **Auth**: pluggable `writeAuthorizer` prop; default **IAM auth** on write/admin routes, reads public. Authed callers can see drafts.
- **Features v1**: posts CRUD, newest-first list with cursor pagination, tags + filter-by-tag, draft/published status, comments.
- **Tooling**: plain TypeScript library (tsc), no jsii/projen. Package name `cdk-blog-backend` (rename trivially if taken on npm).

## Architecture at a glance

- Handler is **pre-bundled with esbuild at package build time** into `dist/handler/index.js`; the construct uses `lambda.Function` + `Code.fromAsset(path.join(__dirname, '..', 'dist', 'handler'))`. Works from node_modules and from local tests; consumers never need esbuild. AWS SDK v3 marked `--external` (provided by Node 20 runtime), zod bundled — so the published package has **zero runtime `dependencies`**, only `aws-cdk-lib`/`constructs` peers.
- HTTP API `routeKey` (e.g. `"GET /posts/{slug}"`) makes the router a plain `Record<string, RouteFn>` lookup — no routing lib.

## Package structure

```
package.json                 # main/types -> dist, files: ["dist"], peerDeps aws-cdk-lib+constructs
tsconfig.base.json           # shared strict options (ES2022, commonjs)
tsconfig.json                # lib build: src/ -> dist/ with declarations
jest.config.js               # ts-jest
src/
  index.ts                   # public exports
  blog-backend.ts            # the construct
  constants.ts               # GSI name, env var names, key prefixes (shared with handler)
handler/
  tsconfig.json              # noEmit typecheck (esbuild emits)
  src/
    index.ts                 # top-level handler: dispatch + error mapping
    router.ts                # routeKey -> RouteFn map
    http.ts                  # response helpers, HttpError(status, code, message)
    validation.ts            # zod schemas (createPost, updatePost, createComment, presign, list query)
    cursor.ts                # base64url cursor encode/decode + key-shape validation
    config.ts                # env var reads at cold start
    db/{client,posts,comments}.ts
    routes/{posts,comments,assets}.ts
test/
  blog-backend.test.ts       # Template.fromStack assertions
  handler/{router,posts,comments,cursor}.test.ts + events.ts factory
```

Key scripts: `build:handler` (esbuild bundle → `dist/handler/`), `build:lib` (tsc), `prepack: npm run build`, `pretest: npm run build:handler` (construct tests synth `Code.fromAsset`).

## DynamoDB data model (single table, PAY_PER_REQUEST, GSI1 projection ALL)

| Entity | PK | SK | GSI1PK | GSI1SK |
|---|---|---|---|---|
| Post | `POST#<slug>` | `META` | `POSTS#<status>` | `<sortDate>#<slug>` |
| Post-tag | `POST#<slug>` | `TAG#<tag>` | `TAG#<tag>` | `<publishedAt>#<slug>` |
| Comment | `POST#<slug>` | `COMMENT#<createdAt>#<id>` | — | — |

- Get by slug: `GetItem`. Create: `ConditionExpression attribute_not_exists(PK)` → 409 on slug conflict.
- List: Query GSI1 `POSTS#published` descending; `sortDate` = publishedAt (published) / createdAt (drafts under `POSTS#draft`). Cursor = base64url(LastEvaluatedKey), validated on decode.
- Tags: one item per post-tag pair, **existing only while post is published** (tag queries are draft-safe with no filters). Create/update computes tag diff and writes META + tag items via `TransactWriteItems` (chunked at DynamoDB's 100-op cap; the conditional META put leads the first chunk). Tag items denormalize the post-summary fields (title, excerpt, tags, createdAt, updatedAt, publishedAt) so tag listing needs no follow-up reads. List endpoints return summaries (no `content`).
- Comments: Query `begins_with(SK, 'COMMENT#')`, paginated. Post delete removes the whole partition (Query + BatchWrite; fine at blog scale).

## Routes

| Method/Path | Auth |
|---|---|
| `GET /posts` (`?tag=&cursor=&limit=` max 100, default 20) | public |
| `GET /posts/{slug}` (404 if draft) | public |
| `POST /posts`, `PUT /posts/{slug}`, `DELETE /posts/{slug}` | write |
| `GET /admin/posts` (`?status=draft\|published`), `GET /admin/posts/{slug}` | write |
| `GET/POST /posts/{slug}/comments` (if `enableComments`) | public* |
| `DELETE /posts/{slug}/comments/{id}` | write |
| `POST /assets/presign-upload` (if `enableAssets`) | write |

HTTP API authorizers are per-route all-or-nothing, so drafts are served via the `/admin` read surface behind the write authorizer. *`requireAuthForComments: true` moves comment creation behind the authorizer.

## Construct API

```ts
interface BlogBackendProps {
  table?: dynamodb.ITable;            // BYO; must match documented schema
  removalPolicy?: RemovalPolicy;      // default RETAIN (user data)
  writeAuthorizer?: apigwv2.IHttpRouteAuthorizer;  // default HttpIamAuthorizer
  enableComments?: boolean;           // default true
  requireAuthForComments?: boolean;   // default false
  enableAssets?: boolean;             // default false
  assetsBucket?: s3.IBucket;          // BYO (implies enableAssets)
  assetsCdn?: AssetsCdnProps;         // CloudFront read path (implies enableAssets)
  presignExpiry?: Duration;           // default 15 min
  corsPreflight?: apigwv2.CorsPreflightOptions;
  apiName?: string;
  memorySize?: number; timeout?: Duration; logRetention?: logs.RetentionDays;
}
interface AssetsCdnProps {
  distribution?: cloudfront.Distribution;  // BYO: gets an `<prefix>/*` behavior via OAC
  domainName?: string;                     // URL-building only (imported/external CDN), or CNAME override
  pathPrefix?: string;                     // default 'assets'; key prefix + behavior path pattern
}
class BlogBackend extends Construct {
  readonly api: apigwv2.HttpApi;
  readonly table: dynamodb.ITable;
  readonly handler: lambda.Function;
  readonly bucket?: s3.IBucket;
  readonly distribution?: cloudfront.IDistribution;  // created or passed in
  readonly assetsBaseUrl?: string;                   // https://<domain> when a CDN is configured
  readonly apiUrl: string;
  static readonly GSI1_NAME = 'GSI1';  // for BYO-table users
}
```

Wiring: create table unless provided; Function with env vars (`TABLE_NAME`, `GSI1_NAME`, `ASSETS_BUCKET_NAME`, `ASSETS_KEY_PREFIX`, `ASSETS_PUBLIC_BASE_URL`, `COMMENTS_ENABLED`, `PRESIGN_EXPIRY_SECONDS`); `table.grantReadWriteData(handler)`; `bucket.grantPut(handler)`; one `HttpLambdaIntegration` shared across `addRoutes` calls, authorizer attached per route table above. No CfnOutputs (library).

Assets read path: uploads always go direct to S3 via the presigned PUT; reads are served through CloudFront (`assetsCdn`), bucket stays private via Origin Access Control. When `assetsCdn` is set, keys are prefixed `<pathPrefix>/` (default `assets/`) so the same key works under a created distribution (default behavior) and a BYO distribution behavior (`<prefix>/*` — CloudFront forwards the full path as the S3 key); without it keys stay unprefixed, so existing asset users see no change. `fileName` is validated to contain no path separators or dot segments, which is what makes the prefix an actual boundary. Presign response gains `publicUrl` when a CDN/domain is configured.

## Handler design

- Top-level try/catch: `HttpError` → its status, `ZodError` → 400 with issues, else → 500 generic (real error logged). Lists return `{ items, nextCursor }`; single items returned bare.
- Validation via zod (bundled, costs consumers nothing).
- Slug auto-generated from title when not provided.

## Testing

- **Construct** (`Template.fromStack`): table key/GSI schema; no table when BYO; route `AuthorizationType` NONE vs AWS_IAM per route; conditional comment/asset routes per flags; env vars; IAM grants; removal policy propagation; assetsCdn modes (created distribution + OAC + bucket policy; BYO distribution gets a `<prefix>/*` behavior; domainName-only creates nothing; pathPrefix validation).
- **Handler** (`aws-sdk-client-mock` on `DynamoDBDocumentClient`): router dispatch + 404; list Query inputs + cursor round-trip + limit clamp; create → 409 on ConditionalCheckFailed; tag-item transaction contents (only when published); draft 404 on public get; comments SK format + disabled flag; presign via jest module mock of `getSignedUrl`; validation → 400 envelope.

## Implementation order

1. Scaffold: package.json, tsconfigs, jest.config.js, `npm install`; add `cdk.out/` to .gitignore.
2. `src/constants.ts` (shared names).
3. Handler data layer: `db/client.ts`, `cursor.ts`, `db/posts.ts`, `db/comments.ts`.
4. Handler HTTP layer: `http.ts`, `validation.ts`, `routes/*`, `router.ts`, `index.ts`.
5. Handler tests green.
6. Construct `src/blog-backend.ts` + `src/index.ts`.
7. Construct tests green.
8. Packaging check: `npm pack --dry-run`; install tarball into a scratch CDK app and `cdk synth` to prove the from-node_modules asset path works.
9. README (quick start, auth incl. SigV4 note + JWT example, route table, props table, data model/BYO-table contract, pagination, assets). Version 0.1.0.

## Verification

- `npm test` — handler unit tests + construct template assertions all green.
- `npm run typecheck:handler` and lib build clean.
- `npm pack --dry-run` shows only dist/ + README/LICENSE/package.json.
- End-to-end synth: scratch CDK app installing the packed tarball, `cdk synth` succeeds and template contains the HttpApi, table with GSI1, and Lambda pointing at a bundled asset.
