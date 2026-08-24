import { wrapServerWithClientIp, type RequestServerLike } from "./client-ip";
import { consumeUnauthorizedRateLimit } from "../rateLimit";
import { rejectUnsafeCrossOriginRequest } from "./request-origin";

export type RouteHandler = (req: Request, url: URL, server: unknown) => Promise<Response | null>;

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_ID_SEGMENT = /^[0-9a-f]{16,}$/i;
export const MAX_HTTP_METRIC_ROUTE_LENGTH = 1_024;

function tooManyRequestsResponse(retryAfter = 60): Response {
  return new Response("Too many requests", {
    status: 429,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Retry-After": String(retryAfter),
    },
  });
}

function normalizeRouteSegment(segment: string): string {
  if (/^\d+$/.test(segment)) return ":id";
  if (UUID_SEGMENT.test(segment) || LONG_ID_SEGMENT.test(segment)) return ":id";
  if (segment.includes(".") && !segment.startsWith(".")) return ":file";
  if (segment.length >= 24 && /^[a-z0-9_-]+$/i.test(segment)) return ":id";
  return segment;
}

export function normalizeHttpRoute(req: Request, url: URL): string {
  const path = url.pathname
    .split("/")
    .filter(Boolean)
    .map(normalizeRouteSegment)
    .join("/");
  return `${req.method.toUpperCase()} /${path}`.slice(0, MAX_HTTP_METRIC_ROUTE_LENGTH);
}

export function createHttpFetchHandler(deps: {
  metrics: { withHttpMetrics: (fn: () => Promise<Response>, route?: string) => Promise<Response> };
  CORS_HEADERS: Record<string, string>;
  routes: RouteHandler[];
}) {
  return async function fetchHandler(req: Request, server: unknown): Promise<Response> {
    const url = new URL(req.url);
    const routeLabel = normalizeHttpRoute(req, url);
    return deps.metrics.withHttpMetrics(async () => {
      if (req.method === "OPTIONS") {
        return new Response("", { headers: deps.CORS_HEADERS });
      }
      const originDenied = rejectUnsafeCrossOriginRequest(req, url);
      if (originDenied) return originDenied;
      const wrapped = wrapServerWithClientIp(server as RequestServerLike);
      const ip = wrapped.requestIP(req)?.address || "unknown";

      for (const route of deps.routes) {
        const response = await route(req, url, wrapped);
        if (response) {
          if (response.status === 401) {
            const limited = consumeUnauthorizedRateLimit(ip);
            if (limited.limited) return tooManyRequestsResponse(limited.retryAfter);
          }
          return response;
        }
      }
      return new Response("Not found", { status: 404 });
    }, routeLabel);
  };
}
