import { readPackageInfo } from '@powerhousedao/ph-clint';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const pkg = readPackageInfo(import.meta.url);

export const CLI_ROOT = pkg.root;
/** Short / binary name (`ph-porter`). `readPackageInfo` strips `@scope/`,
 *  so this is what shows up in display strings and filesystem paths. */
export const CLI_NAME = pkg.name.replace(/-cli$/, '');
export const CLI_VERSION = pkg.version;

/** Full npm package name including scope (`@powerhousedao/ph-porter`). Used
 *  for npm registry lookups and `npm install -g …` style commands — those
 *  must match the published package, not the bin name. */
export const CLI_PACKAGE_NAME: string = (() => {
  const raw = JSON.parse(
    readFileSync(path.join(pkg.root, 'package.json'), 'utf8'),
  ) as { name?: string };
  if (!raw.name) throw new Error(`No "name" in ${pkg.root}/package.json`);
  return raw.name;
})();
