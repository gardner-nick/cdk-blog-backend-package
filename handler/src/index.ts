import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ZodError } from 'zod';
import { HttpError, jsonResponse } from './http';
import { dispatch } from './router';

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  try {
    return await dispatch(event);
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonResponse(err.status, { error: err.code, message: err.message });
    }
    if (err instanceof ZodError) {
      return jsonResponse(400, { error: 'validation_error', issues: err.issues });
    }
    console.error(err);
    return jsonResponse(500, { error: 'internal_error', message: 'An unexpected error occurred.' });
  }
};
