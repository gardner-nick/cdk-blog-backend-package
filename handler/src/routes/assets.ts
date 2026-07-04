import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ok } from '../http';
import { parseJsonBody, presignUploadSchema } from '../validation';
import { presignUpload } from '../db/assets';

export async function presignAssetUpload(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
  const body = parseJsonBody(event.body);
  const input = presignUploadSchema.parse(body);
  const result = await presignUpload(input);
  return ok(result);
}
