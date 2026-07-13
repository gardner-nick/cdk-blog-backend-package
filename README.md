# cdk-blog-backend

A reusable AWS CDK construct for a serverless blog backend: an API Gateway
HTTP API in front of a single Lambda router, backed by a DynamoDB
single-table design, with an optional S3 assets bucket for image/file
uploads via presigned URLs.

```ts
import { App, Stack } from 'aws-cdk-lib';
import { BlogBackend } from '@gardner-nick/cdk-blog-backend';

const app = new App();
const stack = new Stack(app, 'MyBlogStack');

const blog = new BlogBackend(stack, 'Blog');

console.log(blog.apiUrl);
```

That's it — you get a DynamoDB table, a Lambda function, and an HTTP API
with the full route set below. No `CfnOutput`s are created (this is a
library, not an app); read `blog.apiUrl`, `blog.table`, etc. from the
construct instance and export what you need from your own stack.

## Install

```sh
npm install @gardner-nick/cdk-blog-backend aws-cdk-lib constructs
```

`aws-cdk-lib` and `constructs` are peer dependencies — this package ships
with **zero runtime dependencies** of its own (the Lambda bundle is
pre-built with esbuild at publish time).

## Routes

| Method & Path | Auth | Notes |
|---|---|---|
| `GET /posts` | public | `?tag=&cursor=&limit=` (max 100, default 20). Published posts only, newest first. |
| `GET /posts/{slug}` | public | 404 if the post is a draft. |
| `POST /posts` | write | Creates a post. Slug is auto-generated from the title if omitted. |
| `PUT /posts/{slug}` | write | Partial update. |
| `DELETE /posts/{slug}` | write | Deletes the post and all its comments. |
| `GET /admin/posts` | write | `?status=draft\|published`. Omit `status` to see both. |
| `GET /admin/posts/{slug}` | write | Returns drafts too (the public route 404s on drafts). |
| `GET /posts/{slug}/comments` | public* | Only if `enableComments` (default true). |
| `POST /posts/{slug}/comments` | public* | Only if `enableComments`. See `requireAuthForComments`. |
| `DELETE /posts/{slug}/comments/{id}` | write | Only if `enableComments`. |
| `POST /assets/presign-upload` | write | Only if `enableAssets` / `assetsBucket` is set. Returns a presigned PUT URL. |

\* `requireAuthForComments: true` moves comment **creation** behind the
write authorizer; comment **reads** stay public whenever comments are
enabled. HTTP API authorizers are all-or-nothing per route, which is why
drafts are served through the separate `/admin/*` read surface instead of
being folded into the public routes.

List and comment endpoints return `{ items, nextCursor }`; single-resource
endpoints (get/create/update a post, create a comment, presign) return the
resource bare. Post list items are summaries — every post field except
`content`; fetch `GET /posts/{slug}` for the full body. Errors are
`{ error: string, message: string }`
(`{ error: "validation_error", issues: [...] }` for validation failures).

## Auth

Reads are always public. Write and admin routes are protected by
`writeAuthorizer`, which defaults to **IAM (SigV4)** authentication —
callers must sign requests with AWS credentials that are allowed to invoke
the API (`execute-api:Invoke`). This is the right default for
backend-to-backend or admin-tool access, but browser clients typically
can't produce SigV4 signatures without extra tooling.

To use a JWT authorizer instead (e.g. for a browser-based admin UI backed
by Cognito or another OIDC provider):

```ts
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';

const writeAuthorizer = new HttpJwtAuthorizer('AdminAuthorizer', 'https://your-issuer.example.com', {
  jwtAudience: ['your-audience'],
});

new BlogBackend(stack, 'Blog', { writeAuthorizer });
```

Any `apigwv2.IHttpRouteAuthorizer` works here (Cognito user pools, a custom
Lambda authorizer, etc.) — see the
[apigatewayv2-authorizers module](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_apigatewayv2_authorizers-readme.html).

## Data model & BYO table

The construct creates a single DynamoDB table (`PAY_PER_REQUEST`) with a
`GSI1` global secondary index (projection `ALL`) unless you pass your own
via `table`:

| Entity | PK | SK | GSI1PK | GSI1SK |
|---|---|---|---|---|
| Post | `POST#<slug>` | `META` | `POSTS#<status>` | `<sortDate>#<slug>` |
| Post-tag | `POST#<slug>` | `TAG#<tag>` | `TAG#<tag>` | `<publishedAt>#<slug>` |
| Comment | `POST#<slug>` | `COMMENT#<createdAt>#<id>` | — | — |

Notes if you bring your own table:

- `PK`/`SK` and `GSI1PK`/`GSI1SK` must all be string attributes.
- The GSI must be named to match `BlogBackend.GSI1_NAME` (`"GSI1"`) — or
  wire your table so its GSI is discoverable under that name — and must
  project `ALL` attributes; tag-filtered list views read denormalized
  summary fields (`title`, `excerpt`, `tags`, `createdAt`, `updatedAt`,
  `publishedAt`) straight off tag items.
- Tag items exist **only while the post is published**; they're written or
  removed transactionally alongside the post's `META` item on create/update,
  so tag listings never need a draft filter.
- Deleting a post deletes its entire `PK` partition (comments included).

## Pagination

`GET /posts`, `GET /admin/posts`, and `GET /posts/{slug}/comments` accept
`?cursor=` and `?limit=` (max 100, default 20) and return
`{ items, nextCursor }`. `nextCursor` is a base64url-encoded, opaque
`LastEvaluatedKey` — pass it straight back as `?cursor=` to get the next
page; omit it (or treat `nextCursor: undefined`) to know you're on the
last page. Don't construct or decode cursors yourself; the shape is not a
public contract and may change.

`GET /admin/posts` without `?status=` queries the draft and published
partitions separately and concatenates the results. That combined view is
not paginated — passing `?cursor=` without `?status=` is rejected with a
400 — so pass `?status=draft` or `?status=published` to page through a
large admin list.

## Assets (optional)

Set `enableAssets: true` (or pass your own `assetsBucket`, or configure
`assetsCdn`) to get a private S3 bucket and a `POST /assets/presign-upload`
route:

```ts
const blog = new BlogBackend(stack, 'Blog', { enableAssets: true });
```

```
POST /assets/presign-upload
{ "fileName": "cover.png", "contentType": "image/png" }

-> {
     "uploadUrl": "https://...",
     "key": "<uuid>-cover.png",
     "expiresInSeconds": 900,
     "publicUrl": "https://<cdn-domain>/assets/<uuid>-cover.png"  // when assetsCdn is set
   }
```

`PUT` your file bytes directly to `uploadUrl` with a matching
`Content-Type` header. `presignExpiry` controls how long the URL is valid
(default 15 minutes). `fileName` must not contain path separators (`/`, `\`)
or be a dot segment — it's interpolated into the S3 key.

Without `assetsCdn`, keys are unprefixed (`<uuid>-cover.png`). Configuring
`assetsCdn` moves them under a prefix (default `assets/`, configurable via
`assetsCdn.pathPrefix`) so they line up with the CloudFront behavior.

Without `assetsCdn` the bucket is write-only — it's fully private and the
construct grants the Lambda `PutObject` only — so configure a CDN (below)
or wire your own read path if uploaded files need to be served.

## Serving assets via CloudFront

Uploads always go straight to S3 via the presigned URL; **reads** are served
through CloudFront with the bucket staying fully private (Origin Access
Control). Three modes:

**1. Create a distribution for me** — pass an empty object (implies
`enableAssets`):

```ts
const blog = new BlogBackend(stack, 'Blog', { assetsCdn: {} });
// blog.distribution  — the created cloudfront.Distribution
// blog.assetsBaseUrl — "https://dxxxx.cloudfront.net"
```

**2. Use my existing distribution** — the construct adds an
`assets/*` behavior pointing at the bucket via OAC. Must be the concrete
`cloudfront.Distribution` class (imported `IDistribution`s can't be
modified):

```ts
const blog = new BlogBackend(stack, 'Blog', {
  assetsCdn: {
    distribution: myDistribution,
    // domainName: 'cdn.example.com',  // optional: custom CNAME for publicUrl
  },
});
```

Because CloudFront forwards the full request path to the origin, the
behavior's path pattern and the S3 key prefix must match — both default to
`assets` and both follow `assetsCdn.pathPrefix` if you change it.

**3. I'll wire it myself** — pass only `domainName` (for a distribution
imported from another stack, or a non-CloudFront CDN). The construct
creates and modifies nothing; the domain is only used to build `publicUrl`:

```ts
const blog = new BlogBackend(stack, 'Blog', {
  assetsCdn: { domainName: 'cdn.example.com' },
});
```

Notes:

- Asset behaviors get `REDIRECT_TO_HTTPS`, the `CACHING_OPTIMIZED` cache
  policy, and the managed `CORS_ALLOW_ALL_ORIGINS` response headers policy
  (browser `fetch`/canvas use works cross-origin).
- **Imported buckets:** if you pass an imported `assetsBucket`
  (`Bucket.fromBucketName` etc.), CDK cannot attach the OAC bucket policy
  (`addToResourcePolicy` is a no-op with a synth warning) — add the
  `cloudfront.amazonaws.com` + `AWS:SourceArn` statement to the bucket
  policy yourself. (Same limitation as the construct's `grantPut`.)
- Objects uploaded while `assetsCdn` was unset have unprefixed keys and won't
  be matched by an `assets/*` behavior — a created distribution serves the
  bucket root, so they stay reachable there, but a BYO-distribution behavior
  won't route to them. Move them under the prefix, or serve them from
  whatever read path you had before.

## Props

| Prop | Type | Default | Notes |
|---|---|---|---|
| `table` | `dynamodb.ITable` | new table | See [Data model & BYO table](#data-model--byo-table). |
| `removalPolicy` | `RemovalPolicy` | `RETAIN` | Applied to resources this construct creates (table, assets bucket). |
| `writeAuthorizer` | `apigwv2.IHttpRouteAuthorizer` | `HttpIamAuthorizer` | See [Auth](#auth). |
| `enableComments` | `boolean` | `true` | Toggles all `/posts/{slug}/comments*` routes. |
| `requireAuthForComments` | `boolean` | `false` | Moves comment creation behind `writeAuthorizer`. |
| `enableAssets` | `boolean` | `false` (`true` if `assetsBucket` is set) | Creates the assets bucket + presign route. |
| `assetsBucket` | `s3.IBucket` | new bucket if `enableAssets` | BYO bucket; implies `enableAssets`. |
| `assetsCdn` | `AssetsCdnProps` | none (assets are write-only) | CloudFront read path; implies `enableAssets`. See [Serving assets via CloudFront](#serving-assets-via-cloudfront). |
| `presignExpiry` | `Duration` | 15 minutes | Presigned upload URL lifetime. |
| `corsPreflight` | `apigwv2.CorsPreflightOptions` | none | Passed straight to the `HttpApi`. |
| `apiName` | `string` | auto-generated | Passed straight to the `HttpApi`. |
| `memorySize` | `number` | `256` | Handler Lambda memory (MB). |
| `timeout` | `Duration` | 10 seconds | Handler Lambda timeout. |
| `logRetention` | `logs.RetentionDays` | 2 weeks | Retention for the handler's log group. |

## Construct outputs

| Member | Type | Notes |
|---|---|---|
| `api` | `apigwv2.HttpApi` | |
| `table` | `dynamodb.ITable` | The table in use (created or BYO). |
| `handler` | `lambda.Function` | The router Lambda. |
| `bucket` | `s3.IBucket \| undefined` | Set only when assets are enabled. |
| `distribution` | `cloudfront.IDistribution \| undefined` | The distribution serving assets (created or passed in); unset in `domainName`-only mode. |
| `assetsBaseUrl` | `string \| undefined` | `https://<domain>` for public asset reads, when a CDN is configured. |
| `apiUrl` | `string` | `api.apiEndpoint`. |
| `BlogBackend.GSI1_NAME` | `string` (static) | For BYO-table consumers wiring up their own GSI. |
