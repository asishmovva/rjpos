import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destinationDirectory = resolve(packageDirectory, 'dist');

await mkdir(destinationDirectory, { recursive: true });
await Promise.all(
  ['renderer.html', 'renderer-unavailable.html'].map((filename) =>
    copyFile(
      resolve(packageDirectory, 'src', filename),
      resolve(destinationDirectory, filename),
    ),
  ),
);
