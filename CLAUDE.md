# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

`cdk-blog-backend` — a TypeScript CDK construct library (plain tsc, no jsii/projen). A consumer writes `new BlogBackend(this, 'Blog', {...})` and gets a complete serverless blog API: API Gateway HTTP API (apigatewayv2) → one Lambda with an internal router → DynamoDB single-table, plus an optional S3 assets bucket with presigned uploads and an optional CloudFront read path (`assetsCdn`: create a distribution, add a behavior to a BYO one, or domainName-only for URL building; uploads always go direct to S3, keys prefixed `assets/` by default; new env vars flow through `src/constants.ts` like all the others).

**`docs/PLAN.md` is the authoritative spec** — full route table, `BlogBackendProps` interface, DynamoDB key schemas, and implementation order live there. If the repo is still pre-implementation, the structure below describes the intended layout.

## Commands

```sh
npm test                              # all tests; pretest runs build:handler first
npx jest test/handler/cursor.test.ts  # single test file
npm run build                         # build:handler (esbuild) + build:lib (tsc)
npm run build:handler                 # esbuild bundle -> dist/handler/index.js
npm run typecheck:handler             # handler tsconfig is noEmit (esbuild emits)
npm pack --dry-run                    # packaging check: only dist/ + README/LICENSE/package.json
```

`pretest` must build the handler because construct tests synth `Code.fromAsset(dist/handler)` — a missing bundle fails synth, not just runtime.

## Architecture

### Two compilation units, one shared contract

- `src/` — the construct (`blog-backend.ts`), compiled by tsc with declarations to `dist/`.
- `handler/src/` — the Lambda code, **pre-bundled by esbuild at package build time** into `dist/handler/index.js`. AWS SDK v3 is marked `--external` (provided by the Node 20 runtime); zod is bundled in. Result: the published package has **zero runtime `dependencies`** — only `aws-cdk-lib`/`constructs` peers. Keep it that way; anything the handler needs at runtime must be bundled or runtime-provided.
- The construct loads the bundle via `Code.fromAsset(path.join(__dirname, '..', 'dist', 'handler'))`, so it works from node_modules and from local tests; consumers never need esbuild.
- `src/constants.ts` holds the names shared between construct and handler (GSI name, env var names, key prefixes). Both sides import from it — never duplicate these strings.

### Routing and errors

- HTTP API `routeKey` strings (e.g. `"GET /posts/{slug}"`) key a plain `Record<string, RouteFn>` in `handler/src/router.ts` — no routing library.
- Top-level error mapping in `handler/src/index.ts`: `HttpError` → its status, `ZodError` → 400 with issues, anything else → generic 500 (real error logged). Lists return `{ items, nextCursor }`; single items are returned bare.

### Data model invariants (single table, GSI1)

- Post META: `PK=POST#<slug>, SK=META`, listed via `GSI1PK=POSTS#<status>`. Create uses `ConditionExpression attribute_not_exists(PK)` → 409 on slug conflict.
- Tag items (`SK=TAG#<tag>`, `GSI1PK=TAG#<tag>`) **exist only while the post is published**, so tag queries need no draft filters. They denormalize the post-summary fields (title, excerpt, tags, createdAt, updatedAt, publishedAt); list endpoints return summaries without `content`. Create/update computes the tag diff and writes META + tag items via `TransactWriteItems`, chunked at the 100-op cap with the conditional META put leading the first chunk.
- Comments: `SK=COMMENT#<createdAt>#<id>`, queried with `begins_with`. Post delete removes the whole partition (Query + BatchWrite).
- Pagination cursor = base64url(LastEvaluatedKey), key shape validated on decode (`handler/src/cursor.ts`).

### Auth model

HTTP API authorizers are per-route all-or-nothing. Reads are public; write/admin routes use the pluggable `writeAuthorizer` prop (default IAM). Drafts are therefore served through the `/admin/*` read routes behind the write authorizer — the public `GET /posts/{slug}` returns 404 for drafts.

### Library constraints

- No `CfnOutput`s (this is a library, not an app).
- Default `RemovalPolicy.RETAIN` on created resources (user data).
- Handler config comes from env vars set by the construct (`TABLE_NAME`, `GSI1_NAME`, etc.), read once at cold start in `handler/src/config.ts`.

## Testing

- **Construct tests** (`test/blog-backend.test.ts`): `Template.fromStack` assertions — table/GSI schema, per-route `AuthorizationType` (NONE vs AWS_IAM), conditional routes per feature flags, env vars, grants, removal policy.
- **Handler tests** (`test/handler/`): `aws-sdk-client-mock` on `DynamoDBDocumentClient`; shared event factory in `test/handler/events.ts`. Presigning is tested by jest-module-mocking `getSignedUrl`, not by hitting S3.
