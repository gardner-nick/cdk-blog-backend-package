import { z } from 'zod';
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, POST_STATUS } from '../../src/constants';

const slugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase alphanumeric with hyphens');

// Deduped at the schema so downstream code can write one tag item per entry:
// duplicate tags would otherwise put the same key twice in one
// TransactWriteItems, which DynamoDB rejects.
const tagsSchema = z
  .array(z.string().min(1).max(50))
  .max(50)
  .transform((tags) => Array.from(new Set(tags)));

export const createPostSchema = z.object({
  title: z.string().min(1).max(300),
  slug: slugSchema.optional(),
  excerpt: z.string().max(1000).optional(),
  content: z.string().min(1),
  status: z.enum([POST_STATUS.DRAFT, POST_STATUS.PUBLISHED]).default(POST_STATUS.DRAFT),
  tags: tagsSchema.default([]),
});

export type CreatePostInput = z.infer<typeof createPostSchema>;

export const updatePostSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  excerpt: z.string().max(1000).optional(),
  content: z.string().min(1).optional(),
  status: z.enum([POST_STATUS.DRAFT, POST_STATUS.PUBLISHED]).optional(),
  tags: tagsSchema.optional(),
});

export type UpdatePostInput = z.infer<typeof updatePostSchema>;

export const listQuerySchema = z.object({
  tag: z.string().min(1).max(50).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
});

export type ListQueryInput = z.infer<typeof listQuerySchema>;

export const adminListQuerySchema = z.object({
  status: z.enum([POST_STATUS.DRAFT, POST_STATUS.PUBLISHED]).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
});

export type AdminListQueryInput = z.infer<typeof adminListQuerySchema>;

export const createCommentSchema = z.object({
  author: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
});

export type CreateCommentInput = z.infer<typeof createCommentSchema>;

export const presignUploadSchema = z.object({
  // Slashes and dot segments would let the key escape the configured prefix,
  // which the CloudFront behavior's path pattern relies on.
  fileName: z
    .string()
    .min(1)
    .max(500)
    .regex(/^[^/\\]+$/, 'fileName must not contain path separators')
    .refine((name) => name !== '.' && name !== '..', 'fileName must not be a dot segment'),
  contentType: z.string().min(1).max(200),
});

export type PresignUploadInput = z.infer<typeof presignUploadSchema>;

export function parseJsonBody(body: string | undefined): unknown {
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
