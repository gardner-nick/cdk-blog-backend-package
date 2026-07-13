import * as path from 'path';
import { Construct } from 'constructs';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpIamAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as logs from 'aws-cdk-lib/aws-logs';
import { DEFAULT_ASSETS_KEY_PREFIX, ENV_VARS, GSI1_NAME } from './constants';

export interface AssetsCdnProps {
  /**
   * An existing distribution to serve assets from. The construct adds a
   * `<pathPrefix>/*` behavior pointing at the assets bucket via Origin Access
   * Control. Must be the concrete Distribution class — imported
   * IDistributions cannot be modified; for those, wire the origin yourself
   * and pass `domainName` instead.
   * @default - a new Distribution is created unless only `domainName` is set
   */
  readonly distribution?: cloudfront.Distribution;

  /**
   * Domain that serves the assets bucket. When set without `distribution`,
   * the construct creates and modifies nothing and only uses this to build
   * public asset URLs (for fully-imported distributions or non-CloudFront
   * CDNs). When set alongside a passed or created distribution, it overrides
   * the domain used in public URLs (e.g. a custom CNAME).
   * @default - the distribution's generated domain name
   */
  readonly domainName?: string;

  /**
   * Key prefix under which uploaded assets are stored and served. Presigned
   * upload keys become `<pathPrefix>/<uuid>-<fileName>`, and the
   * BYO-distribution behavior uses path pattern `<pathPrefix>/*`. Must not
   * contain slashes.
   * @default 'assets'
   */
  readonly pathPrefix?: string;
}

export interface BlogBackendProps {
  /**
   * Bring your own DynamoDB table. Must match the documented single-table
   * schema (PK/SK string keys, a GSI1 with GSI1PK/GSI1SK string keys).
   * @default - a new table is created
   */
  readonly table?: dynamodb.ITable;

  /**
   * Removal policy applied to resources created by this construct (table,
   * assets bucket). Has no effect on BYO resources.
   * @default RemovalPolicy.RETAIN
   */
  readonly removalPolicy?: RemovalPolicy;

  /**
   * Authorizer attached to write/admin routes.
   * @default - a new HttpIamAuthorizer (SigV4)
   */
  readonly writeAuthorizer?: apigwv2.IHttpRouteAuthorizer;

  /**
   * Whether to expose the comments routes.
   * @default true
   */
  readonly enableComments?: boolean;

  /**
   * Require the write authorizer on comment creation too (public GET always
   * remains public when comments are enabled).
   * @default false
   */
  readonly requireAuthForComments?: boolean;

  /**
   * Whether to create an S3 assets bucket and expose the presign-upload route.
   * Implied by passing `assetsBucket`.
   * @default false
   */
  readonly enableAssets?: boolean;

  /**
   * Bring your own S3 bucket for asset uploads. Implies enableAssets.
   * @default - a new bucket is created when enableAssets is true
   */
  readonly assetsBucket?: s3.IBucket;

  /**
   * Expiry for presigned upload URLs.
   * @default Duration.minutes(15)
   */
  readonly presignExpiry?: Duration;

  /**
   * Serve uploaded assets through CloudFront. Implies enableAssets.
   * @default - assets are write-only (no read path)
   */
  readonly assetsCdn?: AssetsCdnProps;

  /**
   * CORS configuration for the HTTP API.
   * @default - no CORS configuration
   */
  readonly corsPreflight?: apigwv2.CorsPreflightOptions;

  /**
   * Name for the underlying HttpApi.
   * @default - auto-generated
   */
  readonly apiName?: string;

  /** @default 256 */
  readonly memorySize?: number;

  /** @default Duration.seconds(10) */
  readonly timeout?: Duration;

  /** @default logs.RetentionDays.TWO_WEEKS */
  readonly logRetention?: logs.RetentionDays;
}

export class BlogBackend extends Construct {
  /** Name of the GSI1 index, for BYO-table consumers wiring their own table. */
  static readonly GSI1_NAME = GSI1_NAME;

  readonly api: apigwv2.HttpApi;
  readonly table: dynamodb.ITable;
  readonly handler: lambda.Function;
  readonly bucket?: s3.IBucket;
  /** The distribution serving assets: the created one, or the one passed in. */
  readonly distribution?: cloudfront.IDistribution;
  /** Base URL (https://domain) for public asset reads, when a CDN is configured. */
  readonly assetsBaseUrl?: string;
  readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: BlogBackendProps = {}) {
    super(scope, id);

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.RETAIN;
    const enableComments = props.enableComments ?? true;
    const requireAuthForComments = props.requireAuthForComments ?? false;
    const enableAssets = props.enableAssets ?? Boolean(props.assetsBucket ?? props.assetsCdn);
    const presignExpiry = props.presignExpiry ?? Duration.minutes(15);
    const writeAuthorizer = props.writeAuthorizer ?? new HttpIamAuthorizer();

    this.table = props.table ?? this.createTable(removalPolicy);

    const assetsKeyPrefix = props.assetsCdn?.pathPrefix ?? DEFAULT_ASSETS_KEY_PREFIX;
    if (
      !/^[A-Za-z0-9._-]+$/.test(assetsKeyPrefix) ||
      assetsKeyPrefix === '.' ||
      assetsKeyPrefix === '..'
    ) {
      throw new Error(
        `assetsCdn.pathPrefix must match [A-Za-z0-9._-]+ (no slashes or dot segments), ` +
          `got "${assetsKeyPrefix}"`
      );
    }

    if (enableAssets) {
      this.bucket = props.assetsBucket ?? this.createAssetsBucket(removalPolicy);
      if (props.assetsCdn) {
        const { distribution, baseUrl } = this.setupAssetsCdn(
          props.assetsCdn,
          this.bucket,
          assetsKeyPrefix
        );
        this.distribution = distribution;
        this.assetsBaseUrl = baseUrl;
      }
    }

    const logGroup = new logs.LogGroup(this, 'HandlerLogGroup', {
      retention: props.logRetention ?? logs.RetentionDays.TWO_WEEKS,
      removalPolicy,
    });

    this.handler = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'dist', 'handler')),
      memorySize: props.memorySize ?? 256,
      timeout: props.timeout ?? Duration.seconds(10),
      logGroup,
      environment: {
        [ENV_VARS.TABLE_NAME]: this.table.tableName,
        [ENV_VARS.GSI1_NAME]: GSI1_NAME,
        [ENV_VARS.COMMENTS_ENABLED]: String(enableComments),
        [ENV_VARS.PRESIGN_EXPIRY_SECONDS]: String(presignExpiry.toSeconds()),
        ...(this.bucket ? { [ENV_VARS.ASSETS_BUCKET_NAME]: this.bucket.bucketName } : {}),
        // Keys are prefixed only under a CDN, where the prefix has to line up
        // with the behavior's path pattern.
        ...(props.assetsCdn ? { [ENV_VARS.ASSETS_KEY_PREFIX]: assetsKeyPrefix } : {}),
        ...(this.assetsBaseUrl ? { [ENV_VARS.ASSETS_PUBLIC_BASE_URL]: this.assetsBaseUrl } : {}),
      },
    });

    this.table.grantReadWriteData(this.handler);
    this.bucket?.grantPut(this.handler);

    this.api = new apigwv2.HttpApi(this, 'Api', {
      apiName: props.apiName,
      corsPreflight: props.corsPreflight,
    });

    const integration = new HttpLambdaIntegration('Integration', this.handler);

    // Public reads.
    this.api.addRoutes({
      path: '/posts',
      methods: [apigwv2.HttpMethod.GET],
      integration,
    });
    this.api.addRoutes({
      path: '/posts/{slug}',
      methods: [apigwv2.HttpMethod.GET],
      integration,
    });

    // Write routes.
    this.api.addRoutes({
      path: '/posts',
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: writeAuthorizer,
    });
    this.api.addRoutes({
      path: '/posts/{slug}',
      methods: [apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE],
      integration,
      authorizer: writeAuthorizer,
    });

    // Admin read surface (serves drafts), behind the write authorizer.
    this.api.addRoutes({
      path: '/admin/posts',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: writeAuthorizer,
    });
    this.api.addRoutes({
      path: '/admin/posts/{slug}',
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: writeAuthorizer,
    });

    if (enableComments) {
      this.api.addRoutes({
        path: '/posts/{slug}/comments',
        methods: [apigwv2.HttpMethod.GET],
        integration,
      });
      this.api.addRoutes({
        path: '/posts/{slug}/comments',
        methods: [apigwv2.HttpMethod.POST],
        integration,
        authorizer: requireAuthForComments ? writeAuthorizer : undefined,
      });
      this.api.addRoutes({
        path: '/posts/{slug}/comments/{id}',
        methods: [apigwv2.HttpMethod.DELETE],
        integration,
        authorizer: writeAuthorizer,
      });
    }

    if (enableAssets) {
      this.api.addRoutes({
        path: '/assets/presign-upload',
        methods: [apigwv2.HttpMethod.POST],
        integration,
        authorizer: writeAuthorizer,
      });
    }

    this.apiUrl = this.api.apiEndpoint;
  }

  private createTable(removalPolicy: RemovalPolicy): dynamodb.ITable {
    const table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
    });

    table.addGlobalSecondaryIndex({
      indexName: GSI1_NAME,
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    return table;
  }

  private setupAssetsCdn(
    cdn: AssetsCdnProps,
    bucket: s3.IBucket,
    prefix: string
  ): { distribution?: cloudfront.IDistribution; baseUrl: string } {
    if (cdn.domainName && /:\/\/|\//.test(cdn.domainName)) {
      throw new Error(
        `assetsCdn.domainName must be a bare hostname (no scheme or path), got "${cdn.domainName}"`
      );
    }

    const behaviorOptions = {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
    };

    if (cdn.distribution) {
      cdn.distribution.addBehavior(
        `${prefix}/*`,
        origins.S3BucketOrigin.withOriginAccessControl(bucket),
        behaviorOptions
      );
      const domain = cdn.domainName ?? cdn.distribution.distributionDomainName;
      return { distribution: cdn.distribution, baseUrl: `https://${domain}` };
    }

    if (cdn.domainName) {
      // Escape hatch: the consumer serves the bucket themselves (imported
      // distribution, other CDN); we only need the domain for public URLs.
      return { baseUrl: `https://${cdn.domainName}` };
    }

    const distribution = new cloudfront.Distribution(this, 'AssetsDistribution', {
      comment: 'cdk-blog-backend assets',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        ...behaviorOptions,
      },
    });
    return { distribution, baseUrl: `https://${distribution.distributionDomainName}` };
  }

  private createAssetsBucket(removalPolicy: RemovalPolicy): s3.IBucket {
    return new s3.Bucket(this, 'AssetsBucket', {
      removalPolicy,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
        },
      ],
    });
  }
}
