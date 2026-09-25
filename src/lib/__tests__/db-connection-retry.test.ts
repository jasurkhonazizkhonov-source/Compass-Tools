import { describe, it, expect, vi } from "vitest";
import { isRetriableConnectError, backoffDelayMs, wrapPoolWithConnectRetry, type ConnectablePool } from "../db-connection-retry";

// Regression coverage for the pool-acquisition failure that surfaced as the
// CRM's "This page couldn't load" (Error ref) page: pg-pool throws
// "timeout exceeded when trying to connect" when its queue outruns the
// acquisition timeout. That is transient and safe to retry (nothing has
// been sent on a connection yet); real configuration errors are not.

function err(message: string, code?: string) {
  return Object.assign(new Error(message), code ? { code } : {});
}

describe("isRetriableConnectError", () => {
  it.each([
    ["pg-pool acquisition timeout", err("timeout exceeded when trying to connect")],
    ["server connection slot exhaustion (message)", err("sorry, too many clients already")],
    ["server connection slot exhaustion (SQLSTATE)", err("boom", "53300")],
    ["reserved slots", err("remaining connection slots are reserved for roles with the SUPERUSER attribute")],
    ["connection dropped during startup", err("Connection terminated unexpectedly")],
    ["network reset (code)", err("read failed", "ECONNRESET")],
    ["DB starting up", err("the database system is starting up", "57P03")],
  ])("retries: %s", (_label, e) => {
    expect(isRetriableConnectError(e)).toBe(true);
  });

  it.each([
    ["bad password", err("password authentication failed for user", "28P01")],
    ["no such database", err('database "x" does not exist', "3D000")],
    ["permission denied", err("permission denied", "42501")],
    ["unrelated error", err("something else entirely")],
  ])("does NOT retry: %s", (_label, e) => {
    expect(isRetriableConnectError(e)).toBe(false);
  });

  it("does not retry non-Error values", () => {
    expect(isRetriableConnectError("timeout exceeded when trying to connect")).toBe(false);
  });
});

describe("backoffDelayMs", () => {
  it("grows exponentially and adds bounded jitter", () => {
    expect(backoffDelayMs(0, 300, () => 0)).toBe(300);
    expect(backoffDelayMs(1, 300, () => 0)).toBe(900);
    expect(backoffDelayMs(0, 300, () => 1)).toBe(450);
    expect(backoffDelayMs(2, 300, () => 0)).toBe(2700);
  });
});

type FakeClient = { id: number };

function makePool(behaviours: Array<Error | FakeClient>): { pool: ConnectablePool; calls: () => number } {
  let n = 0;
  const pool: ConnectablePool = {
    connect(cb) {
      const next = behaviours[Math.min(n++, behaviours.length - 1)];
      const done = () => undefined;
      if (typeof cb === "function") {
        queueMicrotask(() => (next instanceof Error ? cb(next, undefined, done) : cb(undefined, next, done)));
        return;
      }
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
  return { pool, calls: () => n };
}

const noSleep = async () => undefined;

describe("wrapPoolWithConnectRetry", () => {
  it("retries a transient acquisition timeout and then succeeds (promise form)", async () => {
    const { pool, calls } = makePool([err("timeout exceeded when trying to connect"), err("timeout exceeded when trying to connect"), { id: 7 }]);
    const onRetry = vi.fn();
    wrapPoolWithConnectRetry(pool, { retries: 2, baseDelayMs: 1, sleep: noSleep, onRetry });

    // The wrapper's promise form and callback form are both used in
    // practice (pool.query() uses the callback form internally).
    const client = await (pool.connect() as Promise<FakeClient>);

    expect(client).toEqual({ id: 7 });
    expect(calls()).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("works for the callback form pg-pool's own query() uses", async () => {
    const { pool } = makePool([err("Connection terminated unexpectedly"), { id: 1 }]);
    wrapPoolWithConnectRetry(pool, { retries: 2, baseDelayMs: 1, sleep: noSleep });

    const result = await new Promise<{ e?: Error; client?: unknown }>((resolve) => {
      pool.connect((e, client) => resolve({ e, client }));
    });

    expect(result.e).toBeUndefined();
    expect(result.client).toEqual({ id: 1 });
  });

  it("gives up after the configured retries and surfaces the ORIGINAL error (never hides a real failure)", async () => {
    const failure = err("timeout exceeded when trying to connect");
    const { pool, calls } = makePool([failure]);
    wrapPoolWithConnectRetry(pool, { retries: 2, baseDelayMs: 1, sleep: noSleep });

    await expect(pool.connect() as Promise<unknown>).rejects.toBe(failure);
    expect(calls()).toBe(3);
  });

  it("does not retry a permanent failure (bad credentials) — fails immediately", async () => {
    const { pool, calls } = makePool([err("password authentication failed", "28P01"), { id: 1 }]);
    wrapPoolWithConnectRetry(pool, { retries: 2, baseDelayMs: 1, sleep: noSleep });

    await expect(pool.connect() as Promise<unknown>).rejects.toThrow(/password authentication failed/);
    expect(calls()).toBe(1);
  });

  it("is idempotent per pool: wrapping twice does not multiply retries", async () => {
    const { pool, calls } = makePool([err("timeout exceeded when trying to connect")]);
    wrapPoolWithConnectRetry(pool, { retries: 1, baseDelayMs: 1, sleep: noSleep });
    wrapPoolWithConnectRetry(pool, { retries: 1, baseDelayMs: 1, sleep: noSleep });

    await expect(pool.connect() as Promise<unknown>).rejects.toThrow();
    expect(calls()).toBe(2);
  });

  it("does not retry when there is no error (single call)", async () => {
    const { pool, calls } = makePool([{ id: 3 }]);
    wrapPoolWithConnectRetry(pool, { retries: 2, baseDelayMs: 1, sleep: noSleep });
    await pool.connect();
    expect(calls()).toBe(1);
  });
});
