import { afterEach, describe, expect, test } from "bun:test";
import {
  deletePushSubscriptionsByUser,
  getAllPushSubscriptions,
  getPushSubscriptionsByUser,
  savePushSubscription,
} from "../db";
import { db } from "../db/connection";
import {
  clearRequestRateLimitsForTests,
  consumePushSubscriptionMutationRateLimit,
} from "../rateLimit";
import { settleInBoundedBatches } from "./notification-delivery";

const testUserIds = new Set<number>();
let nextTestUserId = 1_500_000_000 + Math.floor(Math.random() * 100_000_000);

afterEach(() => {
  for (const userId of testUserIds) deletePushSubscriptionsByUser(userId);
  testUserIds.clear();
  clearRequestRateLimitsForTests();
});

function uniqueUserId(): number {
  const id = nextTestUserId++;
  testUserIds.add(id);
  return id;
}

describe("Web Push subscription abuse controls", () => {
  test("transactionally caps storage, evicts only the owner's oldest entry, and prevents endpoint takeover", () => {
    const userA = uniqueUserId();
    const userB = uniqueUserId();
    const prefix = `push-security-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const endpoint = (name: string) => `https://push.example.test/${prefix}/${name}`;
    const baseline = Number(
      db.query<{ count: number }>("SELECT COUNT(*) AS count FROM push_subscriptions").get()?.count ?? 0,
    );
    const limits = { perUser: 2, global: baseline + 3 };

    expect(savePushSubscription(userA, endpoint("a1"), "key-a1", "auth-a1", limits)).toEqual({
      ok: true,
      action: "created",
    });
    expect(savePushSubscription(userA, endpoint("a2"), "key-a2", "auth-a2", limits).ok).toBe(true);

    const replacement = savePushSubscription(
      userA,
      endpoint("a3"),
      "key-a3",
      "auth-a3",
      limits,
    );
    expect(replacement).toEqual({
      ok: true,
      action: "created",
      evictedEndpoint: endpoint("a1"),
    });
    expect(getPushSubscriptionsByUser(userA).map((sub) => sub.endpoint).sort()).toEqual(
      [endpoint("a2"), endpoint("a3")].sort(),
    );

    expect(savePushSubscription(userB, endpoint("a2"), "stolen", "stolen", limits)).toEqual({
      ok: false,
      reason: "endpoint_conflict",
    });
    expect(savePushSubscription(userB, endpoint("b1"), "key-b1", "auth-b1", limits).ok).toBe(true);
    expect(savePushSubscription(userB, endpoint("b2"), "key-b2", "auth-b2", limits)).toEqual({
      ok: false,
      reason: "global_limit",
      limit: baseline + 3,
    });

    // Refreshing an endpoint already owned by this user remains possible at
    // the global cap and does not create another row.
    expect(savePushSubscription(userA, endpoint("a2"), "new-key", "new-auth", limits)).toEqual({
      ok: true,
      action: "updated",
    });
    expect(getPushSubscriptionsByUser(userA).find((sub) => sub.endpoint === endpoint("a2"))?.p256dh)
      .toBe("new-key");
    expect(getAllPushSubscriptions(2)).toHaveLength(2);
    expect(getAllPushSubscriptions(0)).toEqual([]);
  });

  test("rate-limits subscribe and unsubscribe mutations per authenticated user", () => {
    const previous = {
      max: process.env.OVERLORD_PUSH_SUBSCRIPTION_RATE_LIMIT_MAX,
      window: process.env.OVERLORD_PUSH_SUBSCRIPTION_RATE_LIMIT_WINDOW_SECONDS,
      lockout: process.env.OVERLORD_PUSH_SUBSCRIPTION_RATE_LIMIT_LOCKOUT_SECONDS,
    };
    process.env.OVERLORD_PUSH_SUBSCRIPTION_RATE_LIMIT_MAX = "2";
    process.env.OVERLORD_PUSH_SUBSCRIPTION_RATE_LIMIT_WINDOW_SECONDS = "10";
    process.env.OVERLORD_PUSH_SUBSCRIPTION_RATE_LIMIT_LOCKOUT_SECONDS = "10";
    clearRequestRateLimitsForTests();

    try {
      expect(consumePushSubscriptionMutationRateLimit(42).limited).toBe(false);
      expect(consumePushSubscriptionMutationRateLimit(42).limited).toBe(false);
      const blocked = consumePushSubscriptionMutationRateLimit(42);
      expect(blocked.limited).toBe(true);
      expect(blocked.retryAfter).toBeGreaterThan(0);
      expect(consumePushSubscriptionMutationRateLimit(43).limited).toBe(false);
    } finally {
      if (previous.max === undefined) delete process.env.OVERLORD_PUSH_SUBSCRIPTION_RATE_LIMIT_MAX;
      else process.env.OVERLORD_PUSH_SUBSCRIPTION_RATE_LIMIT_MAX = previous.max;
      if (previous.window === undefined) delete process.env.OVERLORD_PUSH_SUBSCRIPTION_RATE_LIMIT_WINDOW_SECONDS;
      else process.env.OVERLORD_PUSH_SUBSCRIPTION_RATE_LIMIT_WINDOW_SECONDS = previous.window;
      if (previous.lockout === undefined) delete process.env.OVERLORD_PUSH_SUBSCRIPTION_RATE_LIMIT_LOCKOUT_SECONDS;
      else process.env.OVERLORD_PUSH_SUBSCRIPTION_RATE_LIMIT_LOCKOUT_SECONDS = previous.lockout;
    }
  });

  test("settles delivery in bounded batches without aborting after a failure", async () => {
    const items = Array.from({ length: 11 }, (_, index) => index);
    let active = 0;
    let maxActive = 0;
    let firstBatchCompleted = 0;
    let completedWhenSecondBatchStarted = -1;
    const attempted: number[] = [];
    const errors: number[] = [];

    await settleInBoundedBatches(
      items,
      async (item) => {
        if (item === 4 && completedWhenSecondBatchStarted < 0) {
          completedWhenSecondBatchStarted = firstBatchCompleted;
        }
        attempted.push(item);
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 2));
        } finally {
          active -= 1;
          if (item < 4) firstBatchCompleted += 1;
        }
        if (item === 6) throw new Error("expected delivery failure");
      },
      {
        concurrency: 3,
        batchSize: 4,
        onError: (_error, item) => errors.push(item),
      },
    );

    expect(attempted.sort((a, b) => a - b)).toEqual(items);
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(completedWhenSecondBatchStarted).toBe(4);
    expect(errors).toEqual([6]);
  });
});
