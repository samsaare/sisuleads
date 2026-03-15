import { Router } from 'express';
import { ulid } from 'ulid';
import { getDb } from '../db/connection.js';
import { broadcast } from '../queue/sseManager.js';

const router = Router();

function mapLead(row: any) {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    companyName: row.company_name,
    domain: row.domain,
    contactName: row.contact_name,
    contactTitle: row.contact_title,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    extractionComment: row.extraction_comment,
    found: Boolean(row.found),
    isGenericContact: Boolean(row.is_generic_contact),
    sourceUrl: row.source_url,
    status: row.status,
    statusMessage: row.status_message,
    errorMessage: row.error_message,
    retryCount: row.retry_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// List leads for a campaign
router.get('/', (req, res) => {
  const { campaignId } = req.query;
  if (!campaignId) return res.status(400).json({ error: 'campaignId is required' });

  const db = getDb();
  const leads = db.prepare(
    'SELECT * FROM leads WHERE campaign_id = ? ORDER BY created_at DESC'
  ).all(campaignId as string) as any[];

  res.json(leads.map(mapLead));
});

// Export campaign leads as CSV — must be registered before /:id to avoid route conflict
router.get('/export/csv', (req, res) => {
  const { campaignId } = req.query;
  if (!campaignId) return res.status(400).json({ error: 'campaignId is required' });

  const db = getDb();
  const leads = db.prepare(
    'SELECT * FROM leads WHERE campaign_id = ? ORDER BY created_at DESC'
  ).all(campaignId as string) as any[];

  const header = 'Yritys,Verkkosivu,Nimi,Titteli,Sähköposti,Puhelin,Kommentti,Lähde,Löytyi';
  const rows = leads.map(l =>
    [
      l.company_name, l.domain, l.contact_name, l.contact_title,
      l.contact_email, l.contact_phone, l.extraction_comment,
      l.source_url, l.found ? 'Kyllä' : 'Ei'
    ]
      .map(v => `"${String(v || '').replace(/"/g, '""')}"`)
      .join(',')
  );

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="sisulead_${campaignId}_${Date.now()}.csv"`);
  res.send([header, ...rows].join('\n'));
});

// Get single lead with logs
router.get('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id) as any;
  if (!row) return res.status(404).json({ error: 'Not found' });

  const logs = db.prepare(
    'SELECT * FROM lead_logs WHERE lead_id = ? ORDER BY timestamp ASC'
  ).all(req.params.id);

  res.json({ ...mapLead(row), logs });
});

// Import bulk leads into a campaign
router.post('/import', (req, res) => {
  const { campaignId, leads } = req.body as {
    campaignId: string;
    leads: { companyName: string; domain: string }[];
  };

  if (!campaignId || !Array.isArray(leads) || leads.length === 0) {
    return res.status(400).json({ error: 'campaignId and leads[] are required' });
  }

  const db = getDb();
  const campaign = db.prepare('SELECT id FROM campaigns WHERE id = ?').get(campaignId);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const insert = db.prepare(`
    INSERT INTO leads (id, campaign_id, company_name, domain, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const now = Date.now();
  const insertMany = db.transaction((items: { companyName: string; domain: string }[]) => {
    const created = [];
    for (const item of items) {
      if (!item.domain) continue;
      const id = ulid();
      insert.run(id, campaignId, item.companyName || item.domain, item.domain, now, now);
      created.push(id);
    }
    return created;
  });

  const ids = insertMany(leads);
  res.status(201).json({ created: ids.length, ids });
});

// Manual patch (e.g. fix a contact)
router.patch('/:id', (req, res) => {
  const db = getDb();
  const allowed = ['contact_name', 'contact_title', 'contact_email', 'contact_phone'];
  const sets: string[] = ['updated_at = ?'];
  const values: any[] = [Date.now()];

  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(req.body[key]);
    }
  }

  values.push(req.params.id);
  db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  res.json(db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id));
});

// Delete a lead (and its logs)
router.delete('/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM lead_logs WHERE lead_id = ?').run(req.params.id);
  db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
  broadcast({ type: 'lead.deleted', payload: { leadId: req.params.id } });
  res.json({ ok: true });
});

export default router;
