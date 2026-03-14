import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger.js';

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  logger.error(`${req.method} ${req.path} →`, err.stack || err.message || err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
}
