# cdk-blog-backend

A reusable AWS CDK construct for a serverless blog backend: an API Gateway
HTTP API in front of a single Lambda router, backed by a DynamoDB
single-table design, with an optional S3 assets bucket for image/file
uploads via presigned URLs.

```ts
import { App, Stack } from 'aws-cdk-lib';
import { BlogBackend } from 'cdk-blog-backend';

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
npm install cdk-blog-backend aws-cdk-lib constructs
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

Set `enableAssets: true` (or pass your own `assetsBucket`) to get a private
S3 bucket and a `POST /assets/presign-upload` route:

```ts
const blog = new BlogBackend(stack, 'Blog', { enableAssets: true });
```

```
POST /assets/presign-upload
{ "fileName": "cover.png", "contentType": "image/png" }

-> { "uploadUrl": "https://...", "key": "...", "expiresInSeconds": 900 }
```

`PUT` your file bytes directly to `uploadUrl` with a matching
`Content-Type` header. `presignExpiry` controls how long the URL is valid
(default 15 minutes).

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
| `apiUrl` | `string` | `api.apiEndpoint`. |
| `BlogBackend.GSI1_NAME` | `string` (static) | For BYO-table consumers wiring up their own GSI. |
