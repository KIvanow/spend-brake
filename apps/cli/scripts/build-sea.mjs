// Node single executable: dist/brake (or brake.exe), no Node install needed to run it.
// https://nodejs.org/api/single-executable-applications.html
// Newer Node builds it in one step (--build-sea); older ones need postject to inject the blob.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';

const out = platform() === 'win32' ? 'dist/brake.exe' : 'dist/brake';
const base = { main: 'dist/brake.cjs', disableExperimentalSEAWarning: true, useCodeCache: false };

const hasBuildSea = execFileSync(process.execPath, ['--help'], { encoding: 'utf8' }).includes(
  '--build-sea',
);

if (hasBuildSea) {
  writeFileSync('dist/sea-config.json', JSON.stringify({ ...base, output: out }));
  execFileSync(process.execPath, ['--build-sea', 'dist/sea-config.json'], { stdio: 'inherit' });
} else {
  writeFileSync('dist/sea-config.json', JSON.stringify({ ...base, output: 'dist/sea-prep.blob' }));
  execFileSync(process.execPath, ['--experimental-sea-config', 'dist/sea-config.json'], {
    stdio: 'inherit',
  });
  copyFileSync(process.execPath, out);
  if (platform() === 'darwin') execFileSync('codesign', ['--remove-signature', out]);
  execFileSync(
    'npx',
    [
      'postject',
      out,
      'NODE_SEA_BLOB',
      'dist/sea-prep.blob',
      '--sentinel-fuse',
      'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
      ...(platform() === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
    ],
    { stdio: 'inherit' },
  );
}
if (platform() === 'darwin') execFileSync('codesign', ['--sign', '-', out]);
chmodSync(out, 0o755);
console.log(`built ${out}`);
