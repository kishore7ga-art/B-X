import pg from "pg";

/**
 * Postgres connection pool, tuned to survive a managed cloud database.
 *
 * Shared by the running app (src/lib/db.ts) and the seed script, so both
 * behave identically against local Docker Postgres and a cloud provider.
 */

const PRIVATE_IP =
  /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/;

/**
 * Is this host inside our own network rather than out on the internet?
 *
 * The reliable signal is the absence of a dot. Container and service
 * hostnames on a Docker network are single labels — `db`, `postgres`,
 * `xite-xiteb-ieymdm` — while every managed provider is a fully qualified
 * domain. An earlier version listed known-local names instead, which wrongly
 * demanded TLS from any Docker service whose name it had not been told about.
 */
function isInternalHost(host: string): boolean {
  if (!host) return false;
  if (host === "localhost" || host === "::1") return true;
  if (PRIVATE_IP.test(host)) return true;
  return !host.includes(".");
}

/**
 * Managed Postgres (Neon, Supabase, RDS, ...) requires TLS; a Postgres
 * container on the same Docker network neither offers nor needs it. An
 * explicit `sslmode` in the URL always wins; otherwise infer from the host.
 */
export function sslConfig(connectionString: string): pg.PoolConfig["ssl"] {
  let host = "";
  let sslmode: string | null = null;
  try {
    const url = new URL(connectionString);
    host = url.hostname;
    sslmode = url.searchParams.get("sslmode");
  } catch {
    // Unparseable URL: let pg surface the error rather than guessing.
    return undefined;
  }

  if (sslmode === "disable") return undefined;

  const explicitlyRequired =
    sslmode === "require" || sslmode === "verify-ca" || sslmode === "verify-full";

  if (!explicitlyRequired && isInternalHost(host)) return undefined;

  // Certificates are verified against the system CA store by default, which is
  // correct for every major managed provider. Only disable it for a provider
  // using a self-signed cert, and know that it removes MITM protection.
  return {
    rejectUnauthorized: process.env.DATABASE_SSL_NO_VERIFY !== "true",
  };
}

export function createPool(): pg.Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  const pool = new pg.Pool({
    connectionString,
    ssl: sslConfig(connectionString),

    // Cloud databases cap concurrent connections. One container with a modest
    // ceiling is far safer than an unbounded pool exhausting the limit.
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),

    // Return connections to the provider rather than holding them open.
    idleTimeoutMillis: 30_000,
    // Fail fast instead of hanging a request when the database is unreachable.
    connectionTimeoutMillis: 10_000,
    // Stops NAT gateways and load balancers silently dropping idle sockets.
    keepAlive: true,
  });

  // This listener is what keeps the app alive across network blips. `pg` emits
  // 'error' on idle clients when a managed provider recycles or drops a
  // connection; an unhandled 'error' event terminates the Node process. With it
  // handled, the pool discards the dead client and opens a new one on the next
  // query.
  pool.on("error", (error) => {
    console.error("[db] idle client error (pool will recover):", error.message);
  });

  return pool;
}
