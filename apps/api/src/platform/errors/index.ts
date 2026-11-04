import { ZodError } from 'zod';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  instance?: string;
  fieldErrors?: Record<string, string[]>;
}

export class DomainError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly title: string;
  public readonly fieldErrors?: Record<string, string[]>;

  constructor(options: {
    status: number;
    code: string;
    title: string;
    detail: string;
    fieldErrors?: Record<string, string[]>;
  }) {
    super(options.detail);
    this.name = 'DomainError';
    this.status = options.status;
    this.code = options.code;
    this.title = options.title;
    this.fieldErrors = options.fieldErrors;
  }
}

export class NotFoundDomainError extends DomainError {
  constructor(entity: string, id: string) {
    super({
      status: 404,
      code: 'RECORD_NOT_FOUND',
      title: 'Record not found',
      detail: `${entity} '${id}' was not found or is outside your permission scope.`,
    });
  }
}

export class VersionConflictError extends DomainError {
  constructor(entity: string, id: string) {
    super({
      status: 409,
      code: 'VERSION_CONFLICT',
      title: 'Concurrent modification conflict',
      detail: `${entity} '${id}' was modified by another user. Reload the record and try again.`,
    });
  }
}

export class ForbiddenScopeError extends DomainError {
  constructor(capability: string) {
    super({
      status: 403,
      code: 'FORBIDDEN_CAPABILITY',
      title: 'Insufficient permissions',
      detail: `Your role does not grant '${capability}' for this record scope.`,
    });
  }
}

export class ValidationDomainError extends DomainError {
  constructor(detail: string, fieldErrors?: Record<string, string[]>) {
    super({
      status: 422,
      code: 'VALIDATION_FAILED',
      title: 'Validation failed',
      detail,
      fieldErrors,
    });
  }
}

/**
 * PRD §6.6 & AGENTS.md §7 — Maps any exception to RFC 9457 `application/problem+json`.
 */
export function toProblemDetails(exception: unknown, instance?: string): ProblemDetails {
  if (exception instanceof DomainError) {
    return {
      type: `https://crm.adasglobuspro.com/problems/${exception.code.toLowerCase()}`,
      title: exception.title,
      status: exception.status,
      code: exception.code,
      detail: exception.message,
      instance,
      ...(exception.fieldErrors ? { fieldErrors: exception.fieldErrors } : {}),
    };
  }

  if (exception instanceof ZodError) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of exception.issues) {
      const key = issue.path.join('.') || '_root';
      const list = fieldErrors[key] ?? [];
      list.push(issue.message);
      fieldErrors[key] = list;
    }
    return {
      type: 'https://crm.adasglobuspro.com/problems/validation_failed',
      title: 'Validation failed',
      status: 422,
      code: 'VALIDATION_FAILED',
      detail: 'One or more fields failed validation.',
      instance,
      fieldErrors,
    };
  }

  // PostgreSQL unique_violation (23505): a record with the same key already exists.
  if (
    typeof exception === 'object' &&
    exception !== null &&
    (exception as { code?: unknown }).code === '23505'
  ) {
    return {
      type: 'https://crm.adasglobuspro.com/problems/duplicate_record',
      title: 'Duplicate record',
      status: 409,
      code: 'DUPLICATE_RECORD',
      detail: 'A record with the same unique value (for example the same email) already exists.',
      instance,
    };
  }

  const detail = exception instanceof Error ? exception.message : 'Unexpected server error';
  return {
    type: 'https://crm.adasglobuspro.com/problems/internal_error',
    title: 'Internal server error',
    status: 500,
    code: 'INTERNAL_ERROR',
    detail,
    instance,
  };
}
