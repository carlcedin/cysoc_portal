// Report files on a mounted volume, one folder per tenant. Files are never served directly:
// downloads go through the API, which checks the tenant and logs the download.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import type http from 'node:http';
import { config } from '../config.js';
import { HttpError } from '../http/core.js';

const ALLOWED: Record<string, { mime: string; magic: (b: Buffer) => boolean }> = {
  pdf: { mime: 'application/pdf', magic: b => b.subarray(0, 5).toString() === '%PDF-' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: b => b[0] === 0x50 && b[1] === 0x4b },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: b => b[0] === 0x50 && b[1] === 0x4b },
  zip: { mime: 'application/zip', magic: b => b[0] === 0x50 && b[1] === 0x4b },
  csv: { mime: 'text/csv', magic: b => !b.subarray(0, 512).includes(0) },
};
export const ALLOWED_EXT = Object.keys(ALLOWED);

const root = () => path.resolve(config.storageDir);
const tenantDir = (tenantId: string) => {
  if (!/^[0-9a-f-]{36}$/.test(tenantId)) throw new Error('Bad tenant id');
  return path.join(root(), tenantId);
};

export interface StoredFile { storageKey: string; size: number; sha256: string; mime: string; ext: string; }

/** Streams the request body to disk with size, type and (optional) malware checks. */
export async function saveUpload(req: http.IncomingMessage, tenantId: string, filename: string): Promise<StoredFile> {
  const ext = path.extname(filename).slice(1).toLowerCase();
  const rule = ALLOWED[ext];
  if (!rule) throw new HttpError(400, `Upload a ${ALLOWED_EXT.join(', ')} file.`, 'bad_type');
  const dir = tenantDir(tenantId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  const id = crypto.randomUUID();
  const tmp = path.join(dir, `.${id}.part`);
  const limit = config.uploadMaxMb * 1024 * 1024;
  const hash = crypto.createHash('sha256');
  let size = 0; let head = Buffer.alloc(0);
  const out = fs.createWriteStream(tmp, { mode: 0o640 });
  try {
    for await (const chunk of req) {
      const c = chunk as Buffer; size += c.length;
      if (size > limit) throw new HttpError(413, `Files must be ${config.uploadMaxMb} MB or smaller.`, 'too_large');
      if (head.length < 512) head = Buffer.concat([head, c]).subarray(0, 512);
      hash.update(c);
      if (!out.write(c)) await new Promise(r => out.once('drain', r));
    }
    await new Promise<void>((res, rej) => out.end((e?: Error | null) => e ? rej(e) : res()));
    if (size === 0) throw new HttpError(400, 'The file is empty.', 'empty');
    if (!rule.magic(head)) throw new HttpError(400, `The file content does not match a .${ext} file.`, 'bad_type');
    await scan(tmp);
    const key = `${tenantId}/${id}.${ext}`;
    fs.renameSync(tmp, path.join(root(), key));
    return { storageKey: key, size, sha256: hash.digest('hex'), mime: rule.mime, ext };
  } catch (e) {
    out.destroy(); fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export function openDownload(storageKey: string) {
  const file = path.resolve(root(), storageKey);
  if (!file.startsWith(root() + path.sep) || !fs.existsSync(file)) throw new HttpError(404, 'The file is missing from storage.', 'missing_file');
  return fs.createReadStream(file);
}

/** ClamAV INSTREAM scan when CLAMAV_HOST is set. Rejects infected files. */
async function scan(file: string): Promise<void> {
  if (!config.clamavHost) return;
  const verdict = await new Promise<string>((resolve, reject) => {
    const sock = net.connect(config.clamavPort, config.clamavHost);
    let reply = '';
    sock.setTimeout(60_000, () => { sock.destroy(); reject(new Error('Malware scanner timed out')); });
    sock.on('error', reject);
    sock.on('data', d => { reply += d.toString(); });
    sock.on('end', () => resolve(reply.replace(/\0/g, '').trim()));
    sock.on('connect', async () => {
      sock.write('zINSTREAM\0');
      for await (const chunk of fs.createReadStream(file, { highWaterMark: 64 * 1024 })) {
        const len = Buffer.alloc(4); len.writeUInt32BE((chunk as Buffer).length); sock.write(len); sock.write(chunk);
      }
      sock.end(Buffer.alloc(4));
    });
  });
  if (/FOUND$/.test(verdict)) throw new HttpError(422, 'The malware scanner rejected this file.', 'infected');
  if (!/OK$/.test(verdict)) throw new HttpError(503, 'The malware scanner could not check this file. Try again later.', 'scan_failed');
}
