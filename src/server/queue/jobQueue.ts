import PQueue from 'p-queue';
import { getDb } from '../db/connection.js';
import { processLead } from './processLead.js';
import { broadcast } from './sseManager.js';

const queue = new PQueue({ concurrency: 1 });
let isRunning = false;

export function getQueueStatus() {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'queued'  THEN 1 ELSE 0 END) as queued,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error
    FROM leads
  `).get() as any;

  return {
    pending: (row.pending || 0) + (row.queued || 0),
    processing: row.processing || 0,
    completed: row.completed || 0,
    error: row.error || 0,
    isRunning,
  };
}

function broadcastStatus() {
  broadcast({ type: 'queue.status', payload: getQueueStatus() });
}

export function enqueueCampaign(campaignId: string) {
  const db = getDb();
  const leads = db.prepare(
    "SELECT id FROM leads WHERE campaign_id = ? AND status IN ('pending', 'error')"
  ).all(campaignId) as { id: string }[];

  if (leads.length === 0) return 0;

  // Mark all as queued
  db.prepare(
    "UPDATE leads SET status = 'queued', updated_at = ? WHERE campaign_id = ? AND status IN ('pending', 'error')"
  ).run(Date.now(), campaignId);

  isRunning = true;
  broadcastStatus();

  for (const { id } of leads) {
    queue.add(async () => {
      broadcastStatus();
      await processLead(id);
      broadcastStatus();
    });
  }

  queue.onIdle().then(() => {
    isRunning = false;
    broadcastStatus();
  });

  return leads.length;
}

export function stopQueue() {
  queue.clear();
  isRunning = false;
  broadcastStatus();
}

// On server startup, re-enqueue any leads stuck in 'processing' or 'queued'
export function recoverStuckLeads() {
  const db = getDb();
  db.prepare(
    "UPDATE leads SET status = 'pending', status_message = 'Palautettu jonoon', updated_at = ? WHERE status IN ('processing', 'queued')"
  ).run(Date.now());
}
