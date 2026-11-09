import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * File storage (PRD 6.11): one interface, a local directory for now (a Docker volume in
 * production). The database keeps only the key, size, type, checksum and owner; files are
 * served only through the API after a permission check.
 */

export interface StoredFile {
  key: string;
  size: number;
  sha256: string;
}

export interface FileStorage {
  put(prefix: string, extension: string, data: Buffer, now?: Date): Promise<StoredFile>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

const KEY_PATTERN = /^[a-z]+\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.[a-z0-9]{1,8}$/;

export class LocalFileStorage implements FileStorage {
  constructor(private readonly root: string) {}

  async put(
    prefix: string,
    extension: string,
    data: Buffer,
    now = new Date(),
  ): Promise<StoredFile> {
    if (!/^[a-z]+$/.test(prefix) || !/^[a-z0-9]{1,8}$/.test(extension)) {
      throw new Error('Bad file key.');
    }
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const key = `${prefix}/${now.getUTCFullYear()}/${month}/${randomUUID()}.${extension}`;
    const file = this.pathOf(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data, { flag: 'wx' });
    return { key, size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.pathOf(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }

  /** Keys are generated here, but are still checked so a stored key can't escape the root. */
  private pathOf(key: string): string {
    if (!KEY_PATTERN.test(key)) throw new Error('Bad file key.');
    return path.join(this.root, ...key.split('/'));
  }
}

/** Storage in memory, for tests. */
export class MemoryFileStorage implements FileStorage {
  private readonly files = new Map<string, Buffer>();

  async put(
    prefix: string,
    extension: string,
    data: Buffer,
    now = new Date(),
  ): Promise<StoredFile> {
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const key = `${prefix}/${now.getUTCFullYear()}/${month}/${randomUUID()}.${extension}`;
    this.files.set(key, Buffer.from(data));
    return { key, size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  }

  async get(key: string): Promise<Buffer> {
    const file = this.files.get(key);
    if (!file) throw new Error('File not found.');
    return file;
  }

  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }
}
