import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getPool } from './client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(__dirname, '../../sql');

export async function runMigrations(): Promise<void> {
  const pool = getPool();

  // Ensure schema exists before creating the migrations tracker
  await pool.query(`CREATE SCHEMA IF NOT EXISTS trading`);

  // Create migrations tracking table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading._migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Get already-applied migrations
  const { rows: applied } = await pool.query<{ filename: string }>(
    'SELECT filename FROM trading._migrations ORDER BY filename'
  );
  const appliedSet = new Set(applied.map(r => r.filename));

  // Find and sort SQL files
  let files: string[];
  try {
    files = (await readdir(SQL_DIR)).filter(f => f.endsWith('.sql')).sort();
  } catch {
    console.warn(`SQL directory not found at ${SQL_DIR}, skipping migrations`);
    return;
  }

  for (const file of files) {
    if (appliedSet.has(file)) {
      continue;
    }

    const sql = await readFile(join(SQL_DIR, file), 'utf-8');
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO trading._migrations (filename) VALUES ($1)',
        [file]
      );
      await client.query('COMMIT');
      console.log(`[migrate] Applied: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration failed for ${file}: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  console.log('[migrate] All migrations up to date');
}

// Allow running directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1); });
}
