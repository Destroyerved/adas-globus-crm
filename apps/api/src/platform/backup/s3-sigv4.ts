import { createHash, createHmac } from 'node:crypto';

/**
 * Minimal zero-dependency AWS Signature Version 4 (`AWS4-HMAC-SHA256`) client for
 * S3-compatible off-site backup storage (Cloudflare R2, Backblaze B2, AWS S3, MinIO)
 * per `PRD 10.5` and `AGENTS.md §6` (no bloated cloud SDK dependencies).
 */

export interface S3BackupConfig {
  endpoint: string; // e.g. https://<account>.r2.cloudflarestorage.com or http://127.0.0.1:9000
  region: string; // e.g. 'auto' or 'us-east-1'
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function sha256HexBuffer(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function formatAmzDates(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

function encodeS3PathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function buildSignedS3Request(params: {
  config: S3BackupConfig;
  method: 'PUT' | 'GET' | 'HEAD';
  objectKey: string;
  body?: Buffer;
  contentType?: string;
  now?: Date;
}): { url: string; headers: Record<string, string> } {
  const { config, method, objectKey, body, contentType } = params;
  const base = config.endpoint.replace(/\/+$/, '');
  const parsedEndpoint = new URL(base);
  const encodedKey = objectKey.replace(/^\/+/, '').split('/').map(encodeS3PathSegment).join('/');
  const basePath = parsedEndpoint.pathname.replace(/\/+$/, '');
  const canonicalUri = `${basePath}/${encodeS3PathSegment(config.bucket)}/${encodedKey}`;
  const url = `${parsedEndpoint.origin}${canonicalUri}`;

  const payloadHash = sha256HexBuffer(body ?? Buffer.alloc(0));
  const { amzDate, dateStamp } = formatAmzDates(params.now ?? new Date());
  const hostHeader = parsedEndpoint.host;

  const headerMap: Record<string, string> = {
    host: hostHeader,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (contentType) {
    headerMap['content-type'] = contentType;
  }

  const sortedHeaderKeys = Object.keys(headerMap).sort();
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${headerMap[k]}\n`).join('');
  const signedHeaders = sortedHeaderKeys.join(';');

  const canonicalRequest = [
    method,
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256HexBuffer(canonicalRequest),
  ].join('\n');

  const kDate = hmacSha256(`AWS4${config.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, config.region);
  const kService = hmacSha256(kRegion, 's3');
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const outHeaders: Record<string, string> = {
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  if (contentType) {
    outHeaders['Content-Type'] = contentType;
  }

  return { url, headers: outHeaders };
}

export async function putS3Object(params: {
  config: S3BackupConfig;
  objectKey: string;
  body: Buffer;
  contentType?: string;
}): Promise<void> {
  const signed = buildSignedS3Request({
    config: params.config,
    method: 'PUT',
    objectKey: params.objectKey,
    body: params.body,
    contentType: params.contentType ?? 'application/octet-stream',
  });

  const res = await fetch(signed.url, {
    method: 'PUT',
    headers: signed.headers,
    body: new Uint8Array(params.body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`Off-site S3 upload failed with HTTP ${res.status}`);
  }
}

export async function getS3Object(params: {
  config: S3BackupConfig;
  objectKey: string;
}): Promise<Buffer> {
  const signed = buildSignedS3Request({
    config: params.config,
    method: 'GET',
    objectKey: params.objectKey,
  });

  const res = await fetch(signed.url, {
    method: 'GET',
    headers: signed.headers,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`Off-site S3 download failed with HTTP ${res.status}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}
