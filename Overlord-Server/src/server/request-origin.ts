const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function configuredPublicOrigin(): string | null {
  const raw = String(process.env.OVERLORD_PUBLIC_ORIGIN || "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function expectedRequestOrigin(url: URL): string {
  const configured = configuredPublicOrigin();
  if (configured) return configured;
  const tlsOffload = ["1", "true", "yes", "on"].includes(
    String(process.env.OVERLORD_TLS_OFFLOAD || "").trim().toLowerCase(),
  );
  const protocol = tlsOffload ? "https:" : url.protocol;
  return `${protocol}//${url.host}`;
}

export function isSameOriginBrowserRequest(
  req: Request,
  url: URL,
  options: { requireOrigin?: boolean } = {},
): boolean {
  const fetchSite = (req.headers.get("sec-fetch-site") || "").trim().toLowerCase();
  if (fetchSite === "cross-site" || fetchSite === "same-site") return false;

  const rawOrigin = req.headers.get("origin");
  if (!rawOrigin) {
    return !options.requireOrigin && (fetchSite === "" || fetchSite === "none" || fetchSite === "same-origin");
  }
  if (rawOrigin === "null") return false;

  try {
    return new URL(rawOrigin).origin === expectedRequestOrigin(url);
  } catch {
    return false;
  }
}

export function rejectUnsafeCrossOriginRequest(req: Request, url: URL): Response | null {
  if (!UNSAFE_METHODS.has(req.method.toUpperCase())) return null;
  if (isSameOriginBrowserRequest(req, url)) return null;
  return new Response("Forbidden: cross-origin request rejected", { status: 403 });
}
