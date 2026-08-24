import { logger } from "../logger";
import { timingSafeEqual } from "crypto";

let warnedDisableAuthIgnored = false;
let loggedAuthDisabledByEnv = false;
let loggedAuthDisabledNoToken = false;
let warnedLegacyQueryAuth = false;

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function isAuthorizedAgentRequest(
  req: Request,
  url: URL,
  agentToken?: string,
): boolean {
  const disableAuth =
    String(process.env.OVERLORD_DISABLE_AGENT_AUTH || "").toLowerCase() ===
    "true";
  if (disableAuth) {
    const nodeEnv = String(process.env.NODE_ENV || "development").toLowerCase();
    if (nodeEnv === "production") {
      if (!warnedDisableAuthIgnored) {
        warnedDisableAuthIgnored = true;
        logger.warn("[auth] OVERLORD_DISABLE_AGENT_AUTH is ignored in production mode");
      }
    } else {
      if (!loggedAuthDisabledByEnv) {
        loggedAuthDisabledByEnv = true;
        logger.info("[auth] Agent auth explicitly disabled by OVERLORD_DISABLE_AGENT_AUTH=true (non-production mode)");
      }
      return true;
    }
  }

  const token = agentToken?.trim();
  if (!token) {
    if (!loggedAuthDisabledNoToken) {
      loggedAuthDisabledNoToken = true;
      logger.error("[auth] Agent auth token is missing; agent requests will be rejected");
    }
    return false;
  }

  const headerToken = req.headers.get("x-agent-token");
  if (headerToken !== null && safeCompare(headerToken, token)) return true;

  const legacyQuerySetting = String(process.env.OVERLORD_ALLOW_AGENT_TOKEN_QUERY || "").trim().toLowerCase();
  const allowLegacyQuery = legacyQuerySetting !== "false" && legacyQuerySetting !== "0";
  if (!allowLegacyQuery) return false;
  if (!warnedLegacyQueryAuth) {
    warnedLegacyQueryAuth = true;
    logger.warn("[auth] Legacy agent query-token authentication is enabled; URLs may leak credentials");
  }
  const queryToken = url.searchParams.get("token");
  const isAuthed = queryToken !== null && safeCompare(queryToken, token);

  return isAuthed;
}
