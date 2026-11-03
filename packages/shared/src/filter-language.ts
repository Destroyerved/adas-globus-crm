import { z } from 'zod';

export const FilterOperatorSchema = z.enum([
  'eq',
  'neq',
  'in',
  'nin',
  'contains',
  'startsWith',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'before',
  'after',
  'isEmpty',
  'isNotEmpty',
  'hasAny',
  'hasAll',
]);
export type FilterOperator = z.infer<typeof FilterOperatorSchema>;

export const RelativeDateValueSchema = z.object({
  relative: z.string().regex(/^[+-]?\d+[dhmw]$/, 'Expected relative duration like -90d or +7d'),
});

export const FilterPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const FilterValueSchema = z.union([
  FilterPrimitiveSchema,
  z.array(z.union([z.string(), z.number()])),
  RelativeDateValueSchema,
]);

export const FilterConditionSchema = z.object({
  field: z.string().min(1),
  op: FilterOperatorSchema,
  value: FilterValueSchema.optional(),
});
export type FilterCondition = z.infer<typeof FilterConditionSchema>;

export type FilterClause = FilterCondition | { and: FilterClause[] } | { or: FilterClause[] };

export const FilterClauseSchema: z.ZodType<FilterClause> = z.lazy(() =>
  z.union([
    FilterConditionSchema,
    z.object({ and: z.array(FilterClauseSchema).min(1) }),
    z.object({ or: z.array(FilterClauseSchema).min(1) }),
  ]),
);
