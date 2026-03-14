import { Router } from 'express';
import { ulid } from 'ulid';
import { getDb } from '../db/connection.js';

const router = Router();

function mapCampaign(row: any) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    personaConfig: row.persona_config ? JSON.parse(row.persona_config) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    totalLeads: row.total_leads ?? 0,
    completedLeads: row.completed_leads ?? 0,
    foundLeads: row.found_leads ?? 0,
  };
}

router.get('/', (_req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT c.*,
      COUNT(l.id) as total_leads,
      SUM(CASE WHEN l.status = 'completed' THEN 1 ELSE 0 END) as completed_leads,
      SUM(CASE WHEN l.found = 1 THEN 1 ELSE 0 END) as found_leads
    FROM campaigns c
    LEFT JOIN leads l ON l.campaign_id = c.id
    GROUP BY c.id
    ORDER BY c.created_at DESC
  `).all() as any[];
  res.json(rows.map(mapCampaign));
});

router.post('/', (req, res) => {
  const { name, description = '', personaConfig = null } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const db = getDb();
  const now = Date.now();
  const id = ulid();
  db.prepare(
    'INSERT INTO campaigns (id, name, description, persona_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, name, description, personaConfig ? JSON.stringify(personaConfig) : null, now, now);

  const row = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as any;
  res.status(201).json(mapCampaign({ ...row, total_leads: 0, completed_leads: 0, found_leads: 0 }));
});

router.delete('/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
