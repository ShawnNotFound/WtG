import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigrations() {
  const client = await pool.connect();

  try {
    console.log('Starting migrations...');

    // create migrations tracking table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const appliedMigrations = await client.query(
      'SELECT version FROM schema_migrations ORDER BY version'
    );
    const appliedVersions = new Set(
      appliedMigrations.rows.map((row) => row.version)
    );

    const migrationsDir = path.join(__dirname, '../../db/migrations');
    const files = fs.readdirSync(migrationsDir).sort();
    
    for (const file of files) {
      if (!file.endsWith('.sql')) continue;
      
      const version = file;
      
      if (appliedVersions.has(version)) {
        console.log(`⏭️  Skipping ${version} (already applied)`);
        continue;
      }
      
      console.log(`⚙️  Running ${version}...`);
      
      const migrationSQL = fs.readFileSync(
        path.join(migrationsDir, file),
        'utf-8'
      );
      
      await client.query('BEGIN');
      try {
        await client.query(migrationSQL);
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1)',
          [version]
        );
        await client.query('COMMIT');
        console.log(`✅ Applied ${version}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    
    console.log('✅ All migrations completed successfully!');
  } catch (err) {
    console.error('❌ Migration failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations().catch((err) => {
  console.error(err);
  process.exit(1);
});

