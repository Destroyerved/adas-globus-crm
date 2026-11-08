import { type IncomingMessage, type ServerResponse } from 'node:http';
import type { SessionUser } from '@adas/shared';
import { DomainError } from '../errors/index.js';

/**
 * A small path router for signed-in API routes (PRD 6.7). Routes are registered by each
 * module's routes file; main.ts resolves the session first and then dispatches here.
 * Path patterns use `:name` segments, for example `/api/v1/leads/:id`.
 */

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  user: SessionUser;
  params: Record<string, string>;
  query: URLSearchParams;
  /** Reads and parses the JSON body (size-limited). */
  body(): Promise<Record<string, unknown>>;
  json(status: number, data: unknown, headers?: Record<string, string | string[]>): void;
  /** Raw body, for file uploads. */
  raw(maxBytes: number): Promise<Buffer>;
  send(
    status: number,
    contentType: string,
    payload: string | Buffer,
    headers?: Record<string, string>,
  ): void;
  ip: string | null;
}

export type RouteHandler = (ctx: RouteContext) => Promise<void>;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: RouteHandler;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: RouteHandler): this {
    const keys: string[] = [];
    const source = pattern
      .split('/')
      .map((segment) => {
        if (segment.startsWith(':')) {
          keys.push(segment.slice(1));
          return '([^/]+)';
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({ method, regex: new RegExp(`^${source}$`), keys, handler });
    return this;
  }

  get(pattern: string, handler: RouteHandler): this {
    return this.add('GET', pattern, handler);
  }
  post(pattern: string, handler: RouteHandler): this {
    return this.add('POST', pattern, handler);
  }
  patch(pattern: string, handler: RouteHandler): this {
    return this.add('PATCH', pattern, handler);
  }
  put(pattern: string, handler: RouteHandler): this {
    return this.add('PUT', pattern, handler);
  }
  delete(pattern: string, handler: RouteHandler): this {
    return this.add('DELETE', pattern, handler);
  }

  match(
    method: string,
    pathname: string,
  ): { handler: RouteHandler; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.regex.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => {
        try {
          params[key] = decodeURIComponent(m[i + 1] ?? '');
        } catch {
          throw new DomainError({
            status: 400,
            code: 'INVALID_PATH',
            title: 'Invalid path',
            detail: 'The request path is not valid.',
          });
        }
      });
      return { handler: route.handler, params };
    }
    return null;
  }
}
