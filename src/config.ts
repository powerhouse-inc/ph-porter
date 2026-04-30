import { readPackageInfo } from '@powerhousedao/ph-clint';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const pkg = readPackageInfo(import.meta.url);

export const CLI_ROOT = pkg.root;
export const CLI_NAME = pkg.name.replace(/-cli$/, '');
export const CLI_VERSION = pkg.version;

export const CLI_PACKAGE_NAME: string = (() => {
  const raw = JSON.parse(
    readFileSync(path.join(pkg.root, 'package.json'), 'utf8'),
  ) as { name?: string };
  if (!raw.name) throw new Error(`No "name" in ${pkg.root}/package.json`);
  return raw.name;
})();