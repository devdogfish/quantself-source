import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

export function readPrivatePostingFile(path: string, { maxBytes, missing, errorCode }: {
  maxBytes: number; missing?: 'allow'; errorCode: string;
}): unknown {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > maxBytes || (stat.mode & 0o077)) throw new Error(errorCode);
      const bytes = Buffer.alloc(stat.size + 1);
      let total = 0;
      while (total < bytes.length) {
        const count = readSync(fd, bytes, total, bytes.length - total, null);
        if (!count) break;
        total += count;
      }
      if (total !== stat.size) throw new Error(errorCode);
      return JSON.parse(bytes.subarray(0, total).toString('utf8'));
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (missing === 'allow' && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(errorCode);
  }
}
