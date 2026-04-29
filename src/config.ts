import { readPackageInfo } from '@powerhousedao/ph-clint';

const pkg = readPackageInfo(import.meta.url);

export const CLI_ROOT = pkg.root;
export const CLI_NAME = pkg.name.replace(/-cli$/, '');
export const CLI_VERSION = pkg.version;
