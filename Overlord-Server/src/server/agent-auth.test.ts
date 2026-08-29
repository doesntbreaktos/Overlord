import { describe, expect, test, afterEach } from "bun:test";
import { isAuthorizedAgentRequest } from "./agent-auth";

function makeReq(headers: Record<string, string> = {}): Request {
  return new Request("https://localhost/ws", { headers });
}

describe("isAuthorizedAgentRequest", () => {
  const originalEnv: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string | undefined) {
    if (!(key in originalEnv)) originalEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const k of Object.keys(originalEnv)) delete originalEnv[k];
  });

  test("fails closed when agentToken is empty/undefined", () => {
    expect(isAuthorizedAgentRequest(makeReq(), "")).toBe(false);
    expect(isAuthorizedAgentRequest(makeReq(), undefined)).toBe(false);
  });

  test("authenticates via x-agent-token header", () => {
    const token = "secret-agent-token-abc123";
    const req = makeReq({ "x-agent-token": token });
    expect(isAuthorizedAgentRequest(req, token)).toBe(true);
  });

  test("rejects wrong header token", () => {
    const req = makeReq({ "x-agent-token": "wrong" });
    expect(isAuthorizedAgentRequest(req, "correct-token")).toBe(false);
  });

  test("rejects when no token is provided but agentToken is set", () => {
    expect(isAuthorizedAgentRequest(makeReq(), "required-token")).toBe(false);
  });

  test("OVERLORD_DISABLE_AGENT_AUTH bypasses in non-production", () => {
    setEnv("OVERLORD_DISABLE_AGENT_AUTH", "true");
    setEnv("NODE_ENV", "development");
    expect(isAuthorizedAgentRequest(makeReq(), "secret")).toBe(true);
  });

  test("OVERLORD_DISABLE_AGENT_AUTH is ignored in production", () => {
    setEnv("OVERLORD_DISABLE_AGENT_AUTH", "true");
    setEnv("NODE_ENV", "production");
    expect(isAuthorizedAgentRequest(makeReq(), "secret")).toBe(false);
  });

});
