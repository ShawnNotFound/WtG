import express from 'express';
import request from 'supertest';
import pool from '../../src/db/pool';
import adminRouter from '../../src/routes/admin';
import { updateWorldModelWithHelper } from '../../src/world/worldModelOperationService';

jest.mock('../../src/db/pool', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));

jest.mock('../../src/world/worldModelOperationService', () => ({
  updateWorldModelWithHelper: jest.fn(),
}));

jest.mock('../../src/world/worldStateService', () => ({
  getWorldStateForJoinCode: jest.fn(),
  worldStateProcessor: {
    resetAndEnqueueInitialBuild: jest.fn(),
  },
}));

jest.mock('../../src/world/worldHelperService', () => ({
  getWorldHelperAdminHistory: jest.fn(),
}));

jest.mock('../../src/ai/aiPlayerManager', () => ({
  aiPlayerManager: {
    stopSession: jest.fn(),
  },
}));

jest.mock('../../src/game/gameLoop', () => ({
  gameLoopManager: {
    stopLoop: jest.fn(),
    pauseSession: jest.fn(),
    resumeSession: jest.fn(),
  },
}));

jest.mock('../../src/routes/evaluations', () => ({
  __esModule: true,
  default: require('express').Router(),
}));

const baseResult = {
  status: 'applied' as const,
  operation: 'CREATE' as const,
  coverage: 'MISSING' as const,
  jobId: '11111111-1111-4111-8111-111111111111',
  rationale: 'A concrete actor was missing.',
  createdNodes: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Aurora Labs',
      revisionNo: 1,
    },
  ],
  updatedNodes: [],
  reusedNodes: [],
  queuedCandidates: [],
  connectionsUpdated: 0,
  model: 'test-model',
  usage: {},
};

describe('admin future-Wikipedia operation route', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps explicit shared-world mutation behind admin authentication', async () => {
    await request(app)
      .post('/api/admin/sessions/ABC123/world-state/helper-update')
      .send({ operation: 'CREATE', query: 'Create Aurora Labs' })
      .expect(401);

    expect(updateWorldModelWithHelper).not.toHaveBeenCalled();
  });

  it('validates the discriminated operation payload', async () => {
    const response = await request(app)
      .post('/api/admin/sessions/ABC123/world-state/helper-update')
      .set('x-admin-password', 'password')
      .send({ operation: 'DELETE', query: '' })
      .expect(400);

    expect(response.body.error).toBe('Validation failed');
    expect(updateWorldModelWithHelper).not.toHaveBeenCalled();
  });

  it('returns 404 before invoking the editor when the session is absent', async () => {
    (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

    await request(app)
      .post('/api/admin/sessions/ABC123/world-state/helper-update')
      .set('x-admin-password', 'password')
      .send({ operation: 'UPDATE', query: 'Refresh OpenAI' })
      .expect(404);

    expect(updateWorldModelWithHelper).not.toHaveBeenCalled();
  });

  it('reuses the helper updater and returns its audited result', async () => {
    (pool.query as jest.Mock).mockResolvedValueOnce({
      rows: [{ id: 'session-1', join_code: 'ABC123' }],
    });
    (updateWorldModelWithHelper as jest.Mock).mockResolvedValueOnce(baseResult);

    const response = await request(app)
      .post('/api/admin/sessions/ABC123/world-state/helper-update')
      .set('x-admin-password', 'password')
      .send({ operation: 'CREATE', query: 'Create Aurora Labs' })
      .expect(200);

    expect(updateWorldModelWithHelper).toHaveBeenCalledWith({
      sessionId: 'session-1',
      query: 'Create Aurora Labs',
      operation: 'CREATE',
      source: 'admin',
      effectiveAt: undefined,
    });
    expect(response.body).toMatchObject({
      status: 'applied',
      coverage: 'MISSING',
      createdNodes: [{ name: 'Aurora Labs', revisionNo: 1 }],
    });
  });

  it('maps a recorded upstream editor failure to 502', async () => {
    (pool.query as jest.Mock).mockResolvedValueOnce({
      rows: [{ id: 'session-1', join_code: 'ABC123' }],
    });
    (updateWorldModelWithHelper as jest.Mock).mockResolvedValueOnce({
      ...baseResult,
      status: 'error',
      error: 'model unavailable',
    });

    const response = await request(app)
      .post('/api/admin/sessions/ABC123/world-state/helper-update')
      .set('x-admin-password', 'password')
      .send({ operation: 'ANSWER', query: 'Who is Aurora Labs?' })
      .expect(502);

    expect(response.body.error).toBe('model unavailable');
  });
});
