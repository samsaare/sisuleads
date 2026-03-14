import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
config({ path: join(dirname(fileURLToPath(import.meta.url)), '../../.env.local') });
import express from 'express';
import cors from 'cors';
import { logger } from './logger.js';

import campaignRoutes from './routes/campaigns.js';
import leadRoutes from './routes/leads.js';
import jobRoutes from './routes/jobs.js';
import eventRoutes from './routes/events.js';
import { errorHandler } from './middleware/errorHandler.js';
import { recoverStuckLeads } from './queue/jobQueue.js';
import { getDb } from './db/connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

// Initialize DB and recover any stuck leads from a previous session
getDb();
recoverStuckLeads();

const app = express();

app.use(cors({ origin: 'http://localhost:3000' }));
app.use(express.json());

// API routes
app.use('/api/campaigns', campaignRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/events', eventRoutes);

// Serve the Vite production build in production
if (process.env.NODE_ENV === 'production') {
  const distPath = join(__dirname, '../../dist');
  app.use(express.static(distPath));
  app.get('*', (_req, res) => {
    res.sendFile(join(distPath, 'index.html'));
  });
}

app.use(errorHandler);

app.listen(PORT, () => {
  logger.info(`SisuLead server running on http://localhost:${PORT}`);
  logger.info(`Log file: data/server.log`);
});
