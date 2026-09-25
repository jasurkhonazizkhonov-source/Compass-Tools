// Connection-ACQUISITION retry for the shared pg pool.
//
// Why this exists: a Vercel function talks to Postgres over a high-latency
// public link, so a page that issues 20-40 statements against a small
// pool queues behind itself (and behind every other in-flight request and
// every open tab's pollers). pg-pool then fails a queued caller with
// "timeout exceeded when trying to connect" — which surfaced as the CRM's
// "This page couldn't load" (Error ref) screen even though nothing was
// actually wrong with the data or the session. A brief pool/connection
// shortage is a transient, retryable condition; a hard 500 was the wrong
// response to it.
//
// Safety: this wraps ONLY `pool.connect()`. That call either hands back a
// live client or throws BEFORE any SQL has been sent on it, so retrying it
// can never duplicate or partially apply a write — reads, writes and
// transactions are all equally safe. It deliberately does NOT retry a
// query that has already been sent (an ambiguous outcome for writes), and
// it never retries authentication/permission/configuration failures,
// which retrying cannot fix and would only slow down surfacing.

type ConnectCallback = (err: Error | undefined, client: unknown, done: (release?: unknown) => void) => void;

/** The minimal pg.Pool surface this module touches (avoids importing "pg"). */
export type ConnectablePool = {
  connect: (cb?: ConnectCallback) => Promise<unknown> | void;
};

export type ConnectRetryOptions = {
  /** Extra attempts after the first (total attempts = retries + 1). */
  retries: number;
  /** Base backoff in ms; attempt n waits roughly base * 3^n plus jitter. */
  baseDelayMs: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: { attempt: number; reason: string }) => void;
  /** Called every time a checked-out client is returned to the pool. */
  onRelease?: () => void;
};

const TRANSIENT_MESSAGE_PATTERNS = [
  /timeout exceeded when trying to connect/i,
  /connection terminated/i,
  /connection timeout/i,
  /too many clients/i,
  /remaining connection slots/i,
  /the database system is (starting up|shutting down)/i,
  /cannot connect now/i,
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|EPIPE/,
];

// SQLSTATE classes/codes that mean "the server refused or dropped the
// connection right now" — 53300 too_many_connections, 57P03 cannot_connect_now,
// and the 08xxx connection-exception family.
const TRANSIENT_SQLSTATES = new Set(["53300", "53400", "57P03", "08000", "08001", "08003", "08004", "08006"]);

// Never retried: retrying cannot change the outcome.
const PERMANENT_SQLSTATES = new Set(["28000", "28P01", "3D000", "42501"]);

const TRANSIENT_NODE_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EPIPE"]);

export function isRetriableConnectError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") {
    if (PERMANENT_SQLSTATES.has(code)) return false;
    if (TRANSIENT_SQLSTATES.has(code) || TRANSIENT_NODE_CODES.has(code)) return true;
  }
  return TRANSIENT_MESSAGE_PATTERNS.some((re) => re.test(err.message));
}

export function backoffDelayMs(attempt: number, baseDelayMs: number, random: () => number = Math.random): number {
  // Doubles each attempt (250ms, 500ms, 1s, 2s, 4s, 4s...) capped at 4s, plus
  // up to 50% jitter so concurrent retriers do not all wake up and hit the
  // database in the same instant. When the DATABASE ITSELF is out of
  // connection slots (SQLSTATE 53300) the slots free up as other in-flight
  // requests finish — typically well within a couple of seconds — so a
  // patient, spread-out retry turns a burst into a short queue instead of a
  // wall of 500s.
  const exp = Math.min(baseDelayMs * Math.pow(2, attempt), 4_000);
  return Math.round(exp + random() * exp * 0.5);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const WRAPPED = new WeakSet<object>();

/**
 * Wraps pool.connect in place (idempotent per pool). pg-pool's own
 * pool.query() calls this.connect(callback) internally, and the Prisma
 * adapter calls pool.connect() for transactions — patching the instance
 * method therefore covers every path a query can take to a connection.
 */
export function wrapPoolWithConnectRetry(pool: ConnectablePool, options: ConnectRetryOptions): void {
  if (WRAPPED.has(pool)) return;
  WRAPPED.add(pool);

  const original = pool.connect.bind(pool) as (cb: ConnectCallback) => void;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  const attempt = () =>
    new Promise<{ client: unknown; done: (release?: unknown) => void }>((resolve, reject) => {
      original((err, client, done) => (err ? reject(err) : resolve({ client, done })));
    });

  // pg-pool assigns a fresh release function to the client on every
  // checkout, so it is wrapped per acquisition (both the promise and the
  // callback form hand the same function to their caller).
  function withReleaseHook(result: { client: unknown; done: (release?: unknown) => void }) {
    const onRelease = options.onRelease;
    if (!onRelease) return result;
    const original = result.done;
    const wrapped = (releaseArg?: unknown) => {
      try {
        original(releaseArg);
      } finally {
        onRelease();
      }
    };
    (result.client as { release?: unknown }).release = wrapped;
    return { client: result.client, done: wrapped };
  }

  async function acquire() {
    let lastError: unknown;
    for (let i = 0; i <= options.retries; i++) {
      try {
        return withReleaseHook(await attempt());
      } catch (err) {
        lastError = err;
        if (i === options.retries || !isRetriableConnectError(err)) throw err;
        options.onRetry?.({ attempt: i + 1, reason: err instanceof Error ? err.message.slice(0, 80) : "unknown" });
        await sleep(backoffDelayMs(i, options.baseDelayMs, random));
      }
    }
    throw lastError;
  }

  pool.connect = ((cb?: ConnectCallback) => {
    if (typeof cb === "function") {
      acquire().then(
        ({ client, done }) => cb(undefined, client, done),
        (err: Error) => cb(err, undefined, () => undefined)
      );
      return;
    }
    return acquire().then(({ client }) => client);
  }) as ConnectablePool["connect"];
}
