import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import sessionsRouter from './routes/sessions.js';
import jurorRouter from './routes/juror.js';
import adminRouter from './routes/admin.js';
import { setupLobbyHandlers } from './socket/lobbyHandlers.js';
import { gameLoopManager } from './game/gameLoop.js';
import { aiPlayerManager } from './ai/aiPlayerManager.js';
import { worldStateProcessor } from './world/worldStateService.js';
import { evaluationCoordinator } from './evaluation/evaluationService.js';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());

// health check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// api routes
app.use('/api', sessionsRouter);
app.use('/api/juror', jurorRouter);
app.use('/api/admin', adminRouter);

gameLoopManager.setSocketIO(io);

setupLobbyHandlers(io);

worldStateProcessor.startQueuedJobs().then((count) => {
  if (count > 0) {
    console.log(`[WorldState] Resumed ${count} queued jobs in parallel`);
  }
}).catch((error) => {
  console.error('[WorldState] Failed to resume queued jobs:', error);
});

evaluationCoordinator.resumeActiveBatches().then((count) => {
  if (count > 0) {
    console.log(`[Evaluation] Resumed ${count} active evaluation batch(es)`);
  }
}).catch((error) => {
  console.error('[Evaluation] Failed to resume evaluation batches:', error);
});

// error handling middleware
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Socket.IO server ready`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});

// graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  aiPlayerManager.stopAll();
  gameLoopManager.stopAll();
  httpServer.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  aiPlayerManager.stopAll();
  gameLoopManager.stopAll();
  httpServer.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

