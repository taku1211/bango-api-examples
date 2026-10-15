import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { storeEvent, transaction, validEvent } from './core.ts';

// Demonstration of the Standard Webhooks wire format. Production receivers should
// use the official `standardwebhooks` verifier and re-run its compatibility tests.
export function verifySignature(
  secret: string, body: Buffer, headers: Record<string, string | string[] | undefined>,
  nowMillis = Date.now(),
): boolean {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signature = headers['webhook-signature'];
  if (typeof id !== 'string' || !id || typeof timestamp !== 'string' ||
      !/^[0-9]{10}$/.test(timestamp) || typeof signature !== 'string') return false;
  if (Math.abs(Math.floor(nowMillis / 1000) - Number(timestamp)) > 300) return false;
  if (!secret.startsWith('whsec_')) return false;
  const key = Buffer.from(secret.slice(6), 'base64');
  if (key.length !== 32) return false;
  const signed = createHmac('sha256', key)
    .update(`${id}.${timestamp}.`).update(body).digest();
  return signature.split(' ').some((part) => {
    if (!part.startsWith('v1,')) return false;
    const encoded = part.slice(3);
    if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(encoded)) return false;
    const received = Buffer.from(encoded, 'base64');
    return received.length === signed.length && timingSafeEqual(received, signed);
  });
}

// Used by the offline demo/test only; never for BANGO-signed production events.
export function signDemo(secret: string, payload: object, nowMillis = Date.now()) {
  if (!secret.startsWith('whsec_')) throw new Error('test secret requires whsec_');
  const id = (payload as { id?: string }).id;
  if (!id) throw new Error('payload.id required');
  const timestamp = String(Math.floor(nowMillis / 1000));
  const body = Buffer.from(JSON.stringify(payload));
  const signature = createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
    .update(`${id}.${timestamp}.`).update(body).digest('base64');
  return { body, headers: {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${signature}`,
  } };
}

export function createReceiver(db: DatabaseSync, secret: string): Server {
  return createServer(async (req, res) => {
    if (req.url !== '/webhooks/demo') { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 64 * 1024) { res.writeHead(413).end(); return; }
        chunks.push(bytes);
      }
      const raw = Buffer.concat(chunks);
      if (!verifySignature(secret, raw, req.headers)) { res.writeHead(401).end(); return; }
      let payload: unknown;
      try { payload = JSON.parse(raw.toString('utf8')); }
      catch { res.writeHead(400).end(); return; }
      const id = (payload as { id?: unknown })?.id;
      const type = (payload as { type?: unknown })?.type;
      if (id !== req.headers['webhook-id'] || typeof type !== 'string') {
        res.writeHead(400).end(); return;
      }
      if (type === 'endpoint.test') {
        // A connectivity test has no business snapshot and must not update a master.
        res.writeHead(200).end(); return;
      }
      if (!validEvent(payload)) { res.writeHead(400).end(); return; }
      // Acknowledge only after a durable inbox transaction commits.
      transaction(db, () => storeEvent(db, payload));
      res.writeHead(200).end();
    } catch {
      // Do not log the body, signature, URL secret, or database credentials.
      res.writeHead(500).end();
    }
  });
}
