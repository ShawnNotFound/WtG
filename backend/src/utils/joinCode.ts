import pool from '../db/pool.js';

const CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CODE_LENGTH = 6;
const MAX_RETRIES = 3;

/**
 * generates a random alphanumeric code
 */
function generateRandomCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    const randomIndex = Math.floor(Math.random() * CHARACTERS.length);
    code += CHARACTERS[randomIndex];
  }
  return code;
}

/**
 * checks if a join code already exists in the database
 */
async function isCodeUnique(code: string): Promise<boolean> {
  const result = await pool.query(
    'SELECT 1 FROM game_sessions WHERE join_code = $1',
    [code]
  );
  return result.rows.length === 0;
}

/**
 * generates a unique join code, retrying if necessary
 */
export async function generateUniqueJoinCode(): Promise<string> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const code = generateRandomCode();
    const unique = await isCodeUnique(code);

    if (unique) {
      return code;
    }

    console.warn(`Join code collision detected: ${code}, retrying...`);
  }

  throw new Error('Failed to generate unique join code after max retries');
}

