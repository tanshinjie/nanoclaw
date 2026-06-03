import fs from 'fs';
import type Database from 'better-sqlite3';

import { isContainerRunning } from './container-runner.js';
import { getContainerState, getProcessingClaims } from './db/session-db.js';
import { ABSOLUTE_CEILING_MS, CLAIM_STUCK_MS, decideStuckAction, parseSqliteUtc } from './host-sweep.js';
import { heartbeatPath, openInboundDb, openOutboundDb } from './session-manager.js';
import type { Session } from './types.js';

export interface SessionStatusSnapshot {
  sessionId: string;
  containerRunning: boolean;
  sessionContainerStatus: Session['container_status'];
  heartbeatAgeMs: number | null;
  currentTool: string | null;
  toolAgeMs: number | null;
  toolDeclaredTimeoutMs: number | null;
  duePending: number;
  scheduledPending: number;
  processingMessages: number;
  completedMessages: number;
  failedMessages: number;
  processingClaims: number;
  oldestClaimAgeMs: number | null;
  maxTries: number;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastDeliveredAt: string | null;
  watchdog: string;
  interpretation: string;
}

export function buildSessionStatusSnapshot(session: Session, now = Date.now()): SessionStatusSnapshot {
  const inDb = openInboundDb(session.agent_group_id, session.id);
  let outDb: Database.Database | null = null;
  try {
    outDb = openOutboundDb(session.agent_group_id, session.id);
  } catch {
    outDb = null;
  }

  try {
    const inboundCounts = getInboundCounts(inDb);
    const outboundCounts = outDb ? getOutboundCounts(outDb) : emptyOutboundCounts();
    const containerState = outDb ? getContainerState(outDb) : null;
    const claims = outDb ? getProcessingClaims(outDb) : [];
    const heartbeatMtime = getHeartbeatMtimeMs(session.agent_group_id, session.id);
    const containerRunning = isContainerRunning(session.id);
    const decision = containerRunning
      ? decideStuckAction({
          now,
          heartbeatMtimeMs: heartbeatMtime ?? 0,
          containerState,
          claims,
        })
      : { action: 'ok' as const };

    const oldestClaimAgeMs = claims.reduce<number | null>((oldest, claim) => {
      const claimedAt = parseSqliteUtc(claim.status_changed);
      if (Number.isNaN(claimedAt)) return oldest;
      const age = Math.max(0, now - claimedAt);
      return oldest === null ? age : Math.max(oldest, age);
    }, null);

    const toolStartedAt = containerState?.tool_started_at ? parseSqliteUtc(containerState.tool_started_at) : NaN;
    const toolAgeMs = Number.isNaN(toolStartedAt) ? null : Math.max(0, now - toolStartedAt);
    const heartbeatAgeMs = heartbeatMtime === null ? null : Math.max(0, now - heartbeatMtime);
    const watchdog = describeWatchdog(decision, containerRunning, heartbeatAgeMs);
    const interpretation = describeInterpretation({
      containerRunning,
      duePending: inboundCounts.duePending,
      scheduledPending: inboundCounts.scheduledPending,
      processingClaims: claims.length,
      heartbeatAgeMs,
      watchdog,
    });

    return {
      sessionId: session.id,
      containerRunning,
      sessionContainerStatus: session.container_status,
      heartbeatAgeMs,
      currentTool: containerState?.current_tool ?? null,
      toolAgeMs,
      toolDeclaredTimeoutMs: containerState?.tool_declared_timeout_ms ?? null,
      duePending: inboundCounts.duePending,
      scheduledPending: inboundCounts.scheduledPending,
      processingMessages: inboundCounts.processingMessages,
      completedMessages: inboundCounts.completedMessages,
      failedMessages: inboundCounts.failedMessages,
      processingClaims: outboundCounts.processingClaims,
      oldestClaimAgeMs,
      maxTries: inboundCounts.maxTries,
      lastInboundAt: inboundCounts.lastInboundAt,
      lastOutboundAt: outboundCounts.lastOutboundAt,
      lastDeliveredAt: inboundCounts.lastDeliveredAt,
      watchdog,
      interpretation,
    };
  } finally {
    outDb?.close();
    inDb.close();
  }
}

export function formatSessionStatus(snapshot: SessionStatusSnapshot): string {
  const lines = [
    'NanoClaw status',
    '',
    `State: ${snapshot.interpretation}`,
    `Container: ${snapshot.containerRunning ? 'running' : 'not running'} (session row: ${snapshot.sessionContainerStatus})`,
    `Watchdog: ${snapshot.watchdog}`,
    `Heartbeat: ${snapshot.heartbeatAgeMs === null ? 'not written yet' : `${formatDuration(snapshot.heartbeatAgeMs)} ago`}`,
    `Current tool: ${formatTool(snapshot)}`,
    `Queue: ${snapshot.duePending} due, ${snapshot.scheduledPending} scheduled, ${snapshot.processingClaims} claimed`,
    `History: ${snapshot.completedMessages} completed, ${snapshot.failedMessages} failed, max tries ${snapshot.maxTries}`,
    `Last inbound: ${formatTimestamp(snapshot.lastInboundAt)}`,
    `Last outbound: ${formatTimestamp(snapshot.lastOutboundAt)}`,
    `Last delivered: ${formatTimestamp(snapshot.lastDeliveredAt)}`,
  ];

  if (snapshot.oldestClaimAgeMs !== null) {
    lines.push(`Oldest active claim: ${formatDuration(snapshot.oldestClaimAgeMs)}`);
  }

  lines.push('', 'No message contents were inspected for this status report.');
  return lines.join('\n');
}

function getInboundCounts(db: Database.Database): {
  duePending: number;
  scheduledPending: number;
  processingMessages: number;
  completedMessages: number;
  failedMessages: number;
  maxTries: number;
  lastInboundAt: string | null;
  lastDeliveredAt: string | null;
} {
  const counts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'pending' AND trigger = 1 AND (process_after IS NULL OR datetime(process_after) <= datetime('now')) THEN 1 ELSE 0 END) AS duePending,
         SUM(CASE WHEN status = 'pending' AND trigger = 1 AND process_after IS NOT NULL AND datetime(process_after) > datetime('now') THEN 1 ELSE 0 END) AS scheduledPending,
         SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processingMessages,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completedMessages,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedMessages,
         COALESCE(MAX(tries), 0) AS maxTries,
         MAX(timestamp) AS lastInboundAt
       FROM messages_in`,
    )
    .get() as {
    duePending: number | null;
    scheduledPending: number | null;
    processingMessages: number | null;
    completedMessages: number | null;
    failedMessages: number | null;
    maxTries: number | null;
    lastInboundAt: string | null;
  };

  const delivered = safeGet<{ lastDeliveredAt: string | null }>(
    db,
    'SELECT MAX(delivered_at) AS lastDeliveredAt FROM delivered',
  );

  return {
    duePending: counts.duePending ?? 0,
    scheduledPending: counts.scheduledPending ?? 0,
    processingMessages: counts.processingMessages ?? 0,
    completedMessages: counts.completedMessages ?? 0,
    failedMessages: counts.failedMessages ?? 0,
    maxTries: counts.maxTries ?? 0,
    lastInboundAt: counts.lastInboundAt,
    lastDeliveredAt: delivered?.lastDeliveredAt ?? null,
  };
}

function getOutboundCounts(db: Database.Database): {
  processingClaims: number;
  lastOutboundAt: string | null;
} {
  const claims = safeGet<{ processingClaims: number | null }>(
    db,
    "SELECT COUNT(*) AS processingClaims FROM processing_ack WHERE status = 'processing'",
  );
  const outbound = safeGet<{ lastOutboundAt: string | null }>(
    db,
    'SELECT MAX(timestamp) AS lastOutboundAt FROM messages_out',
  );
  return {
    processingClaims: claims?.processingClaims ?? 0,
    lastOutboundAt: outbound?.lastOutboundAt ?? null,
  };
}

function emptyOutboundCounts(): ReturnType<typeof getOutboundCounts> {
  return { processingClaims: 0, lastOutboundAt: null };
}

function safeGet<T>(db: Database.Database, sql: string): T | null {
  try {
    return db.prepare(sql).get() as T;
  } catch {
    return null;
  }
}

function getHeartbeatMtimeMs(agentGroupId: string, sessionId: string): number | null {
  try {
    return fs.statSync(heartbeatPath(agentGroupId, sessionId)).mtimeMs;
  } catch {
    return null;
  }
}

function describeWatchdog(
  decision: ReturnType<typeof decideStuckAction>,
  containerRunning: boolean,
  heartbeatAgeMs: number | null,
): string {
  if (!containerRunning) return 'not applicable; container is not running';
  if (decision.action === 'kill-ceiling') {
    return `would restart: heartbeat silent for ${formatDuration(decision.heartbeatAgeMs)} over ${formatDuration(decision.ceilingMs)} ceiling`;
  }
  if (decision.action === 'kill-claim') {
    return `would restart: claimed work silent for ${formatDuration(decision.claimAgeMs)} over ${formatDuration(decision.toleranceMs)} tolerance`;
  }
  if (heartbeatAgeMs === null) return 'healthy; waiting for first heartbeat';
  return `healthy; ceiling ${formatDuration(ABSOLUTE_CEILING_MS)}, claim tolerance ${formatDuration(CLAIM_STUCK_MS)}`;
}

function describeInterpretation(args: {
  containerRunning: boolean;
  duePending: number;
  scheduledPending: number;
  processingClaims: number;
  heartbeatAgeMs: number | null;
  watchdog: string;
}): string {
  if (args.watchdog.startsWith('would restart'))
    return 'likely stuck; host watchdog should restart it on the next sweep';
  if (args.containerRunning && args.processingClaims > 0) return 'working on a claimed message';
  if (args.containerRunning) return 'running, but no message is currently claimed';
  if (args.duePending > 0) return 'work is due; host sweep should wake the container soon';
  if (args.scheduledPending > 0) return 'idle until scheduled retry/work becomes due';
  return 'idle; no due work';
}

function formatTool(snapshot: SessionStatusSnapshot): string {
  if (!snapshot.currentTool) return 'none reported';
  const age = snapshot.toolAgeMs === null ? 'unknown duration' : formatDuration(snapshot.toolAgeMs);
  const timeout =
    snapshot.toolDeclaredTimeoutMs === null
      ? ''
      : `, declared timeout ${formatDuration(snapshot.toolDeclaredTimeoutMs)}`;
  return `${snapshot.currentTool} (${age}${timeout})`;
}

function formatTimestamp(value: string | null): string {
  return value ?? 'none';
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}
