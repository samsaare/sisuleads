import { Router } from 'express';
import { addClient, removeClient } from '../queue/sseManager.js';
import { getQueueStatus } from '../queue/jobQueue.js';

const router = Router();

router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send current queue status immediately on connect
  res.write(`data: ${JSON.stringify({ type: 'queue.status', payload: getQueueStatus() })}\n\n`);

  addClient(res);

  // Keepalive ping every 30s
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(ping); }
  }, 30000);

  req.on('close', () => {
    clearInterval(ping);
    removeClient(res);
  });
});

export default router;
