import { Router } from 'express';
import { enqueueCampaign, stopQueue, clearQueue, getQueueStatus } from '../queue/jobQueue.js';

const router = Router();

router.post('/start', (req, res) => {
  const { campaignId } = req.body;
  if (!campaignId) return res.status(400).json({ error: 'campaignId is required' });

  const count = enqueueCampaign(campaignId);
  res.json({ queued: count });
});

router.post('/stop', (_req, res) => {
  stopQueue();
  res.json({ ok: true });
});

router.post('/clear', (_req, res) => {
  clearQueue();
  res.json({ ok: true });
});

router.get('/status', (_req, res) => {
  res.json(getQueueStatus());
});

export default router;
