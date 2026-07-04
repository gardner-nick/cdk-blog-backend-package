import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function jsonResponse(
  status: number,
  body: unknown
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function ok(body: unknown): APIGatewayProxyStructuredResultV2 {
  return jsonResponse(200, body);
}

export function created(body: unknown): APIGatewayProxyStructuredResultV2 {
  return jsonResponse(201, body);
}

export function noContent(): APIGatewayProxyStructuredResultV2 {
  return { statusCode: 204, body: '' };
}
