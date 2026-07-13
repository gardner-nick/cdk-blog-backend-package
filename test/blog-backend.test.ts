import { App, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { BlogBackend } from '../src';

function synth(props: ConstructorParameters<typeof BlogBackend>[2] = {}) {
  const app = new App();
  const stack = new Stack(app, 'TestStack');
  const construct = new BlogBackend(stack, 'Blog', props);
  return { stack, construct, template: Template.fromStack(stack) };
}

function routeAuth(template: Template, routeKey: string): string {
  const routes = template.findResources('AWS::ApiGatewayV2::Route', {
    Properties: { RouteKey: routeKey },
  });
  const match = Object.values(routes)[0];
  if (!match) throw new Error(`No route found for ${routeKey}`);
  return match.Properties.AuthorizationType;
}

describe('BlogBackend defaults', () => {
  const { template } = synth();

  it('creates a table with PK/SK and a GSI1 with GSI1PK/GSI1SK', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
      GlobalSecondaryIndexes: [
        Match.objectLike({
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        }),
      ],
    });
  });

  it('defaults table removal policy to Retain', () => {
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  it('creates exactly one HttpApi', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  });

  it('public reads have no authorizer; writes and admin reads use AWS_IAM', () => {
    expect(routeAuth(template, 'GET /posts')).toBe('NONE');
    expect(routeAuth(template, 'GET /posts/{slug}')).toBe('NONE');
    expect(routeAuth(template, 'POST /posts')).toBe('AWS_IAM');
    expect(routeAuth(template, 'PUT /posts/{slug}')).toBe('AWS_IAM');
    expect(routeAuth(template, 'DELETE /posts/{slug}')).toBe('AWS_IAM');
    expect(routeAuth(template, 'GET /admin/posts')).toBe('AWS_IAM');
    expect(routeAuth(template, 'GET /admin/posts/{slug}')).toBe('AWS_IAM');
  });

  it('comment routes are enabled by default: reads public, create public, delete AWS_IAM', () => {
    expect(routeAuth(template, 'GET /posts/{slug}/comments')).toBe('NONE');
    expect(routeAuth(template, 'POST /posts/{slug}/comments')).toBe('NONE');
    expect(routeAuth(template, 'DELETE /posts/{slug}/comments/{id}')).toBe('AWS_IAM');
  });

  it('does not create an assets bucket or presign route by default', () => {
    template.resourceCountIs('AWS::S3::Bucket', 0);
    const routes = template.findResources('AWS::ApiGatewayV2::Route', {
      Properties: { RouteKey: 'POST /assets/presign-upload' },
    });
    expect(Object.keys(routes)).toHaveLength(0);
  });

  it('runs the handler on the nodejs24.x runtime', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
    });
  });

  it('sets the expected env vars on the handler', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          GSI1_NAME: 'GSI1',
          COMMENTS_ENABLED: 'true',
          PRESIGN_EXPIRY_SECONDS: '900',
        }),
      },
    });
  });

  it('grants the handler read/write access to the table', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([Match.stringLikeRegexp('dynamodb:.*')]),
          }),
        ]),
      }),
    });
  });

  it('never emits a CfnOutput', () => {
    const json = template.toJSON();
    expect(json.Outputs).toBeUndefined();
  });
});

describe('BlogBackend with enableComments: false', () => {
  it('omits all comment routes', () => {
    const { template } = synth({ enableComments: false });
    for (const key of [
      'GET /posts/{slug}/comments',
      'POST /posts/{slug}/comments',
      'DELETE /posts/{slug}/comments/{id}',
    ]) {
      const routes = template.findResources('AWS::ApiGatewayV2::Route', {
        Properties: { RouteKey: key },
      });
      expect(Object.keys(routes)).toHaveLength(0);
    }
  });
});

describe('BlogBackend with requireAuthForComments: true', () => {
  it('moves comment creation behind the write authorizer, leaving reads public', () => {
    const { template } = synth({ requireAuthForComments: true });
    expect(routeAuth(template, 'GET /posts/{slug}/comments')).toBe('NONE');
    expect(routeAuth(template, 'POST /posts/{slug}/comments')).toBe('AWS_IAM');
  });
});

describe('BlogBackend with enableAssets: true', () => {
  it('creates an assets bucket, presign route, and grants s3:PutObject', () => {
    const { template } = synth({ enableAssets: true });
    template.resourceCountIs('AWS::S3::Bucket', 1);
    expect(routeAuth(template, 'POST /assets/presign-upload')).toBe('AWS_IAM');
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: Match.arrayWith(['s3:PutObject']) }),
        ]),
      }),
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          ASSETS_BUCKET_NAME: Match.anyValue(),
          ASSETS_KEY_PREFIX: Match.absent(),
          ASSETS_PUBLIC_BASE_URL: Match.absent(),
        }),
      },
    });
  });

  it('does not create a distribution without assetsCdn', () => {
    const { template, construct } = synth({ enableAssets: true });
    template.resourceCountIs('AWS::CloudFront::Distribution', 0);
    expect(construct.distribution).toBeUndefined();
    expect(construct.assetsBaseUrl).toBeUndefined();
  });
});

describe('BlogBackend with assetsCdn: {} (created distribution)', () => {
  const { template, construct } = synth({ assetsCdn: {} });

  it('implies enableAssets: creates the bucket and presign route', () => {
    template.resourceCountIs('AWS::S3::Bucket', 1);
    expect(routeAuth(template, 'POST /assets/presign-upload')).toBe('AWS_IAM');
  });

  it('creates a distribution with an origin access control', () => {
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
  });

  it('adds a bucket policy allowing CloudFront scoped to the distribution', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 's3:GetObject',
            Principal: { Service: 'cloudfront.amazonaws.com' },
            Condition: Match.objectLike({
              StringEquals: Match.objectLike({ 'AWS:SourceArn': Match.anyValue() }),
            }),
          }),
        ]),
      }),
    });
  });

  it('exposes the distribution and base URL, and passes them to the handler', () => {
    expect(construct.distribution).toBeDefined();
    expect(construct.assetsBaseUrl).toMatch(/^https:\/\//);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          ASSETS_PUBLIC_BASE_URL: Match.anyValue(),
          ASSETS_KEY_PREFIX: 'assets',
        }),
      },
    });
  });

  it('still never emits a CfnOutput', () => {
    expect(template.toJSON().Outputs).toBeUndefined();
  });
});

describe('BlogBackend with a BYO distribution', () => {
  function synthWithDistribution(pathPrefix?: string) {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const distribution = new cloudfront.Distribution(stack, 'ExistingCdn', {
      defaultBehavior: { origin: new origins.HttpOrigin('app.example.com') },
    });
    const construct = new BlogBackend(stack, 'Blog', {
      assetsCdn: { distribution, ...(pathPrefix ? { pathPrefix } : {}) },
    });
    return { construct, distribution, template: Template.fromStack(stack) };
  }

  it('adds an assets/* behavior instead of creating a new distribution', () => {
    const { template, construct, distribution } = synthWithDistribution();
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([Match.objectLike({ PathPattern: 'assets/*' })]),
      }),
    });
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    expect(construct.distribution).toBe(distribution);
  });

  it('uses domainName as a CNAME override for public URLs', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const distribution = new cloudfront.Distribution(stack, 'ExistingCdn', {
      defaultBehavior: { origin: new origins.HttpOrigin('app.example.com') },
    });
    const construct = new BlogBackend(stack, 'Blog', {
      assetsCdn: { distribution, domainName: 'cdn.example.com' },
    });

    expect(construct.distribution).toBe(distribution);
    expect(construct.assetsBaseUrl).toBe('https://cdn.example.com');
  });

  it('honors a custom pathPrefix in the behavior and env var', () => {
    const { template } = synthWithDistribution('img');
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([Match.objectLike({ PathPattern: 'img/*' })]),
      }),
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ ASSETS_KEY_PREFIX: 'img' }) },
    });
  });
});

describe('BlogBackend with assetsCdn.domainName only', () => {
  it('creates no distribution and uses the domain for public URLs', () => {
    const { template, construct } = synth({ assetsCdn: { domainName: 'cdn.example.com' } });
    template.resourceCountIs('AWS::CloudFront::Distribution', 0);
    expect(construct.distribution).toBeUndefined();
    expect(construct.assetsBaseUrl).toBe('https://cdn.example.com');
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ ASSETS_PUBLIC_BASE_URL: 'https://cdn.example.com' }),
      },
    });
  });
});

describe('BlogBackend assetsCdn validation', () => {
  it('rejects pathPrefixes with slashes, dot segments, or empty strings', () => {
    expect(() => synth({ assetsCdn: { pathPrefix: 'a/b' } })).toThrow(/pathPrefix/);
    expect(() => synth({ assetsCdn: { pathPrefix: '' } })).toThrow(/pathPrefix/);
    expect(() => synth({ assetsCdn: { pathPrefix: '..' } })).toThrow(/pathPrefix/);
    expect(() => synth({ assetsCdn: { pathPrefix: '.' } })).toThrow(/pathPrefix/);
  });

  it('rejects a domainName with a scheme or path', () => {
    expect(() => synth({ assetsCdn: { domainName: 'https://cdn.example.com' } })).toThrow(
      /bare hostname/
    );
    expect(() => synth({ assetsCdn: { domainName: 'cdn.example.com/assets' } })).toThrow(
      /bare hostname/
    );
  });
});

describe('BlogBackend with a BYO assetsBucket', () => {
  it('implies enableAssets and does not create a new bucket', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const bucket = new s3.Bucket(stack, 'MyBucket');
    new BlogBackend(stack, 'Blog', { assetsBucket: bucket });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::S3::Bucket', 1);
    expect(routeAuth(template, 'POST /assets/presign-upload')).toBe('AWS_IAM');
  });
});

describe('BlogBackend with a BYO table', () => {
  it('does not create a new table', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const table = new dynamodb.Table(stack, 'MyTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });
    table.addGlobalSecondaryIndex({
      indexName: BlogBackend.GSI1_NAME,
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
    });

    new BlogBackend(stack, 'Blog', { table });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::DynamoDB::Table', 1);
  });
});

describe('BlogBackend removalPolicy propagation', () => {
  it('applies DESTROY to the created table when specified', () => {
    const { template } = synth({ removalPolicy: RemovalPolicy.DESTROY });
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
    });
  });
});

describe('BlogBackend with a custom writeAuthorizer', () => {
  it('uses a JWT authorizer instead of the default IAM authorizer', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const writeAuthorizer = new HttpJwtAuthorizer('JwtAuthorizer', 'https://issuer.example.com', {
      jwtAudience: ['my-audience'],
    });

    new BlogBackend(stack, 'Blog', { writeAuthorizer });
    const template = Template.fromStack(stack);

    expect(routeAuth(template, 'POST /posts')).toBe('JWT');
  });
});
