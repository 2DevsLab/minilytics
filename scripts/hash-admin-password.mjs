import { pbkdf2Sync, randomBytes } from 'node:crypto';

const password = process.argv[2];
if (!password) {
  console.error('usage: node scripts/hash-admin-password.mjs <password>');
  process.exit(1);
}
const iterations = 600_000;
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
process.stdout.write(`$pbkdf2-sha256$i=${iterations}$${salt.toString('base64')}$${hash.toString('base64')}\n`);
