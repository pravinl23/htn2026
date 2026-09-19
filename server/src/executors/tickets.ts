import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ExecuteJob, ExecutorMode } from "./types";

/**
 * The batch confirmation is a server-issued, single-use ticket, not a boolean the caller sets.
 * POST /v1/loop/preview hashes exactly what the user is shown (mode, program, items, baseUrl) and hands out a random token;
 * POST /v1/loop/execute must present that token with a body that hashes to the same value. A program or an item list
 * that changed after the preview, a second use (double click, retry after a timeout, worker restart) and an expired
 * token are all refused, so one confirmation starts at most one run of exactly what was previewed.
 */
export const TICKET_TTL_MS = 5 * 60_000;
const MAX_OUTSTANDING = 50;

export interface Ticket {
  runId: string;
  confirmToken: string;
  /** Epoch ms. */
  expiresAt: number;
}

export type RedeemResult = { ok: true; runId: string } | { ok: false; reason: "unknown" | "expired" | "mismatch" };

export interface TicketOffice {
  issue(jobHash: string): Ticket;
  /** Consumes the token whatever the outcome: a token is good for one attempt. */
  redeem(confirmToken: string, jobHash: string): RedeemResult;
}

/** The parsers build their objects key by key in a fixed order (vars are sorted), so equal requests serialize equally. */
export function hashJob(mode: ExecutorMode, job: ExecuteJob): string {
  const { program, items, baseUrl } = job;
  return createHash("sha256").update(JSON.stringify({ mode, baseUrl, program, items })).digest("hex");
}

export function createTicketOffice(now: () => number = Date.now, ttlMs: number = TICKET_TTL_MS): TicketOffice {
  const outstanding = new Map<string, { runId: string; jobHash: string; expiresAt: number }>();
  return {
    issue(jobHash) {
      for (const [token, ticket] of outstanding) if (ticket.expiresAt <= now()) outstanding.delete(token);
      // Oldest first: a Map keeps insertion order.
      while (outstanding.size >= MAX_OUTSTANDING) outstanding.delete(outstanding.keys().next().value as string);
      const ticket = { runId: randomUUID(), jobHash, expiresAt: now() + ttlMs };
      const confirmToken = randomBytes(32).toString("base64url");
      outstanding.set(confirmToken, ticket);
      return { runId: ticket.runId, confirmToken, expiresAt: ticket.expiresAt };
    },
    redeem(confirmToken, jobHash) {
      const ticket = outstanding.get(confirmToken);
      if (!ticket) return { ok: false, reason: "unknown" };
      outstanding.delete(confirmToken);
      if (ticket.expiresAt <= now()) return { ok: false, reason: "expired" };
      if (ticket.jobHash !== jobHash) return { ok: false, reason: "mismatch" };
      return { ok: true, runId: ticket.runId };
    },
  };
}
