import express from 'express';

import matchesRouter from './routes/matches';
import submissionsRouter from './routes/submissions';

export const app = express();

app.disable('x-powered-by');
app.use(express.json());
app.use('/api/matches', matchesRouter);
app.use('/api/matches', submissionsRouter);
app.use('/api/submissions', submissionsRouter);
app.use('/api/export/matches', matchesRouter);

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

export default app;
