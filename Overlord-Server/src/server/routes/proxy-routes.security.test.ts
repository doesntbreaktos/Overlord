import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateToken } from "../../auth";
import {
  createUser,
  deleteUser,
  getUserById,
  setUserExtraPermissions,
} from "../../users";
import { handleMiscRoutes } from "./misc-routes";

const createdUserIds: number[] = [];
let operatorToken = "";
let viewerToken = "";

const deps = {
  CORS_HEADERS: {},
  SERVER_VERSION: "test",
  PUBLIC_ROOT: ".",
  requestIP: () => ({ address: "127.0.0.1" }),
  getConsoleSessionCount: () => 0,
  getRdSessionCount: () => 0,
  getFileBrowserSessionCount: () => 0,
  getProcessSessionCount: () => 0,
};

beforeAll(async () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const operator = await createUser(
    `proxy_operator_${suffix}`,
    "Aa1!ProxyRouteSecurityPass123",
    "operator",
    "test",
  );
  const viewer = await createUser(
    `proxy_viewer_${suffix}`,
    "Aa1!ProxyRouteSecurityPass123",
    "viewer",
    "test",
  );
  if (!operator.success || !operator.userId || !viewer.success || !viewer.userId) {
    throw new Error("failed to create proxy route test users");
  }
  createdUserIds.push(operator.userId, viewer.userId);
  operatorToken = await generateToken(getUserById(operator.userId)!);
  setUserExtraPermissions(viewer.userId, ["clients:control"]);
  viewerToken = await generateToken(getUserById(viewer.userId)!);
});

afterAll(() => {
  for (const id of createdUserIds) deleteUser(id);
});

async function listProxies(token?: string): Promise<Response> {
  const url = new URL("https://localhost/api/proxy/list");
  const request = new Request(url, token
    ? { headers: { Authorization: `Bearer ${token}` } }
    : undefined);
  const response = await handleMiscRoutes(request, url, deps);
  if (!response) throw new Error("proxy list route was not handled");
  return response;
}

describe("SOCKS proxy route authorization", () => {
  test("requires authentication", async () => {
    expect((await listProxies()).status).toBe(401);
  });

  test("allows an operator with clients:control", async () => {
    expect((await listProxies(operatorToken)).status).toBe(200);
  });

  test("retains the non-viewer role gate even with a direct permission grant", async () => {
    expect((await listProxies(viewerToken)).status).toBe(403);
  });
});
