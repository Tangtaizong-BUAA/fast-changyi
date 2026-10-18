import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const vendor = join(root, 'public', 'vendor');
const sdk = join(root, 'node_modules', 'ali-oss');
await mkdir(vendor, { recursive: true });
await copyFile(join(sdk, 'dist', 'aliyun-oss-sdk.min.js'), join(vendor, 'aliyun-oss-sdk.min.js'));
await copyFile(join(root, 'licenses', 'ali-oss.LICENSE'), join(vendor, 'ali-oss.LICENSE'));
console.log('Prepared the browser OSS SDK and its license from the locked npm dependency.');
