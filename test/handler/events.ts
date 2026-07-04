import type { APIGatewayProxyEventV2 } from 'aws-lambda';

export function buildEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'GET /posts',
    rawPath: '/posts',
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      domainName: 'api-id.execute-api.us-east-1.amazonaws.com',
      domainPrefix: 'api-id',
      http: {
        method: 'GET',
        path: '/posts',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'jest',
      },
      requestId: 'request-id',
      routeKey: 'GET /posts',
      stage: '$default',
      time: '03/Jul/2026:00:00:00 +0000',
      timeEpoch: 1751500800000,
    },
    isBase64Encoded: false,
    ...overrides,
  };
}
