import { App, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
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
      Environment: { Variables: Match.objectLike({ ASSETS_BUCKET_NAME: Match.anyValue() }) },
    });
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
