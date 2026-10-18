import { randomBytes, scryptSync } from 'node:crypto';

const value = process.argv.slice(2).join(' ').trim();
if (!value) {
  console.error('Usage: npm run hash-code -- "your shared access code"');
  process.exit(2);
}

const salt = randomBytes(16);
const digest = scryptSync(value, salt, 32, { N: 16384, r: 8, p: 1 });
console.log(`scrypt$${salt.toString('base64url')}$${digest.toString('base64url')}`);
