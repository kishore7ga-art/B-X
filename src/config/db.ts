import mongoose from "mongoose";
import dns from "node:dns";

/**
 * Prefer A records over AAAA when resolving.
 *
 * Node 17 changed the default from `ipv4first` to `verbatim`, which breaks
 * MongoDB Atlas SRV lookups on hosts that advertise IPv6 without a working
 * route to it — a common state on Windows and on some container networks. This
 * changes ordering only; it does not change *who* answers.
 */
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {
  // Not available on this runtime. The default ordering still resolves for
  // most hosts, so this is a preference rather than a requirement.
}

/**
 * Override the system resolver. Off unless explicitly asked for.
 *
 * This module used to call `dns.setServers(["8.8.8.8", "1.1.1.1"])`
 * unconditionally at import time, as a workaround for one developer's machine
 * failing Atlas SRV lookups. `setServers` is **process-wide**: it replaces the
 * resolver for every hostname this service ever looks up, not just Atlas.
 *
 * In a container that is actively harmful. Docker and Dokploy resolve service
 * names through an embedded DNS server on the container's own resolver, and
 * 8.8.8.8 has never heard of them — so any internal hostname stops resolving
 * the moment this file is imported. It also silently routes every DNS query
 * this service makes through Google, which is a dependency and a disclosure
 * nobody chose.
 *
 * Behind a variable it can still rescue the laptop it was written for:
 *   DNS_SERVERS=8.8.8.8,1.1.1.1
 */
const dnsServers = (process.env.DNS_SERVERS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

if (dnsServers.length > 0) {
  try {
    dns.setServers(dnsServers);
    console.warn(
      `[db] DNS resolver overridden to ${dnsServers.join(", ")} for this whole process ` +
        "(DNS_SERVERS is set). Internal service hostnames will not resolve.",
    );
  } catch (error) {
    console.error("[db] DNS_SERVERS is not a usable resolver list:", (error as Error).message);
  }
}

/** The connection string, under either of the two names deployments use. */
export function mongoUri(): string | undefined {
  return process.env.MONGODB_URI || process.env.DATABASE_URL;
}

/** Whether the driver is connected and able to serve a query right now. */
export function dbReady(): boolean {
  return mongoose.connection.readyState === 1;
}

/**
 * Whether a connection has ever succeeded in this process.
 *
 * The readiness gate needs this to tell two states apart that `readyState`
 * reports identically as "connecting":
 *
 *   - a brief reconnect after a working connection dropped, where mongoose
 *     buffers the operation and will serve it in a moment;
 *   - a startup retry loop against a database that is not there, where
 *     `serverSelectionTimeoutMS` keeps the driver in "connecting" for fifteen
 *     seconds per attempt while nothing can possibly be served.
 *
 * Without the distinction, every request during an outage hangs for the full
 * selection timeout and then fails with a driver message — which is the
 * behaviour the gate was added to replace.
 */
let everConnected = false;

mongoose.connection.on("connected", () => {
  everConnected = true;
});

/**
 * Whether a request should be allowed to reach a route that touches the
 * database. `false` means answer 503 now rather than making the caller wait.
 */
export function dbServable(): boolean {
  const state = mongoose.connection.readyState;
  if (state === 1) return true;
  // Reconnecting after a working connection: mongoose buffers, so let it try.
  return state === 2 && everConnected;
}

/**
 * MongoDB Atlas connection, with retry.
 *
 * Deliberately does not exit the process on failure. A container that dies on a
 * bad Atlas IP allowlist takes its own logs with it, and the operator is left
 * with a restart loop and no message; one that stays up serves an honest 503
 * (see the readiness gate in server.ts) and keeps `/api/health` answerable.
 */
export async function connectDB(retries = 8, delayMs = 5000): Promise<typeof mongoose> {
  const uri = mongoUri();

  if (!uri) {
    console.error(
      "[db] FATAL: neither MONGODB_URI nor DATABASE_URL is set. " +
        "Set MONGODB_URI in the deployment's environment.",
    );
    return mongoose;
  }

  mongoose.set("strictQuery", false);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[db] connecting to MongoDB (attempt ${attempt}/${retries})…`);
      const conn = await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 15000,
        connectTimeoutMS: 15000,
        socketTimeoutMS: 30000,
      });

      console.log(`[db] connected: ${conn.connection.host} / ${conn.connection.name}`);
      return conn;
    } catch (error) {
      console.error(`[db] attempt ${attempt} failed:`, (error as Error).message);

      if (attempt === retries) {
        console.error(
          `[db] could not connect after ${retries} attempts. Check MONGODB_URI, and ` +
            "the Atlas Network Access allowlist for this deployment's egress address. " +
            "The API stays up and answers 503 until the watchdog reconnects.",
        );
        return mongoose;
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return mongoose;
}

mongoose.connection.on("disconnected", () => {
  console.warn("[db] connection lost.");
});

mongoose.connection.on("reconnected", () => {
  console.log("[db] reconnected.");
});

mongoose.connection.on("error", (err) => {
  console.error("[db] connection error:", err.message);
});
