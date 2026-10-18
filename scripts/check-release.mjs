import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const paths = execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8' }).split('\0').filter(Boolean);
if (!paths.length) throw new Error('No tracked release files to audit');
const forbidden = /(^|\/)(node_modules|data|tmp|downloads|vendor|\.aws|\.codex|\.agents)(\/|$)|(^|\/)\.env(?:\.|$)|\.(sqlite(?:-\w+)?|db|pem|key)$/;
const patterns = [
  ['private key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9_]{25,}|github_pat_[A-Za-z0-9_]{25,}/],
  ['AWS credential', /(?:AKIA|ASIA)[A-Z0-9]{16}/],
  ['Aliyun credential', /LTAI[A-Za-z0-9]{16,}/],
  ['signed object URL', /https?:\/\/[^\s"'<>]+[?&](?:OSSAccessKeyId|Signature|security-token|X-Amz-Signature)=[^\s"'<>]+/i],
  ['personal path', /\/(?:Users|home)\/(?!ubuntu(?:\/|\b)|runner(?:\/|\b)|node(?:\/|\b))[A-Za-z0-9._-]+\//],
  ['cloud account', /acs:ram::\d{10,}:/],
];
const failures = [];
for (const path of paths) {
  if (path !== '.env.example' && forbidden.test(path)) failures.push({ path, reason: 'private/generated file' });
  const bytes = await readFile(new URL(`../${path}`, import.meta.url));
  if (bytes.includes(0)) continue;
  const text = bytes.toString('utf8');
  for (const [reason, pattern] of patterns) if (pattern.test(text)) failures.push({ path, reason });
}
if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exitCode = 1;
} else console.log(`Release audit passed: ${paths.length} tracked files; no private/generated files or credential patterns found.`);
