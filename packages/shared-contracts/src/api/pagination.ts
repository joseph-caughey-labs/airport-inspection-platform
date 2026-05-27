import { z, type ZodTypeAny } from "zod";

export const PaginationQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type PaginationQuery = z.infer<typeof PaginationQuery>;

export const PaginatedResponse = <T extends ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    next_cursor: z.string().nullable(),
    total: z.number().int().nonnegative().optional(),
  });

export type PaginatedResponse<T> = {
  items: T[];
  next_cursor: string | null;
  total?: number;
};
