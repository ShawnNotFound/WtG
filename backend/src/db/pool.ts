import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  // close our idle connections before neondb does (~5 min). the pool will
  // create a fresh one on the next request.
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // send tcp keepalive packets so dead connections are detected before
  // a query tries to use them.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

// idle clients can be closed by neondb after sustained inactivity (this is
// expected serverless postgres behaviour). don't crash the server — just log
// it and let the pool recover by creating a fresh client on the next request.
pool.on('error', (err) => {
  console.error('[pg-pool] Idle client error (likely NeonDB closing an idle connection):', err.message);
});

export default pool;

