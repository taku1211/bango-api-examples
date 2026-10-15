import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openStore, addPartner, acceptBatch, getCheckpoint, setCheckpoint, applyBaseline,
  applySnapshot, storeEvent, processInbox, storePullPage, currentState, transaction,
} from '../src/core.ts';
import { createReceiver, signDemo, verifySignature } from '../src/webhook.ts';
import { MockBango, DEMO_SECRET, COMPANY_NUMBER, CHANGED, LATEST, changeEvent, SUBJECT_ID } from '../src/mock.ts';
import { pullAndRecover } from '../src/sync.ts';

function base() {
  const db = openStore();
  const api = new MockBango();
  for (const p of api.input) addPartner(db, p.id, p.name);
  acceptBatch(db, api.batchDownload().data);
  setCheckpoint(db, api.startNow().next_cursor);
  const w = api.watch(COMPANY_NUMBER);
  applyBaseline(db, w.subject, w.current);
  return { db, api };
}
const rows = (db: ReturnType<typeof openStore>, sql: string) => db.prepare(sql).all() as Record<string, unknown>[];

test('mocked batch is a 202 job flow; ambiguous and unmatched names are not auto-linked', () => {
  const { db, api } = base();
  try {
    assert.equal(api.batchMatch().data.status, 'queued');
    assert.equal(api.batchStatus().data.status, 'completed');
    const p = rows(db, 'SELECT local_id,confidence,corporate_number FROM partners ORDER BY local_id');
    assert.deepEqual(p.map(x => x.confidence), ['confident', 'review', 'unmatched']);
    assert.equal(p[0].corporate_number, COMPANY_NUMBER);
    assert.equal(p[1].corporate_number, null);
    assert.equal(p[2].corporate_number, null);
    const order = api.trace;
    assert.ok(order.indexOf('incremental.start=now') < order.indexOf('watch.put'));
  } finally { db.close(); }
});

test('Standard Webhooks-shaped HMAC verifies exact raw bytes and timestamp bounds', () => {
  const message = { id: 'whtest_test', type: 'endpoint.test' };
  const now = 1792026000000;
  const signed = signDemo(DEMO_SECRET, message, now);
  assert.equal(verifySignature(DEMO_SECRET, signed.body, signed.headers, now), true);
  assert.equal(verifySignature(DEMO_SECRET, signed.body, signed.headers, now + 301000), false);
  assert.equal(verifySignature(DEMO_SECRET, Buffer.from(JSON.stringify({ ...message, extra: 'tampered' })), signed.headers, now), false);
  assert.equal(verifySignature(DEMO_SECRET, signed.body, { ...signed.headers, 'webhook-signature': 'v1,broken' }, now), false);
});

test('HTTP receiver verifies test, accepts event once, rejects tampering and stores before 200', async () => {
  const { db } = base();
  const srv = createReceiver(db, DEMO_SECRET);
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  try {
    const bound = srv.address();
    if (!bound || typeof bound === 'string') throw new Error('bind failed');
    const url = `http://127.0.0.1:${bound.port}/webhooks/demo`;
    const send = (body: object) => {
      const signed = signDemo(DEMO_SECRET, body);
      return fetch(url, { method: 'POST', headers: signed.headers, body: signed.body });
    };
    assert.equal((await send({ id: 'whtest_1', type: 'endpoint.test' })).status, 200);
    assert.equal(rows(db, 'SELECT * FROM inbox').length, 0);
    const event = changeEvent('evt_1', '2', CHANGED);
    assert.equal((await send(event)).status, 200);
    assert.equal((await send(event)).status, 200);
    assert.equal(rows(db, 'SELECT * FROM inbox').length, 1);
    assert.equal((await send({ ...event, id: 'evt_2', subject: {} })).status, 400);
    const payload = signDemo(DEMO_SECRET, event);
    assert.equal((await fetch(url, { method: 'POST', headers: payload.headers,
      body: Buffer.from(JSON.stringify({ ...event, id: 'evt_modified' })) })).status, 401);
    assert.deepEqual(processInbox(db), { applied: 1, stale: 0, unsupported: 0 });
    assert.equal(rows(db, 'SELECT version FROM subjects')[0].version, '2');
  } finally {
    srv.close(); await once(srv, 'close'); db.close();
  }
});

test('old, repeated and very large versions never overwrite a newer snapshot', () => {
  const { db } = base();
  try {
    for (const [id,ver,snap] of [
      ['evt_10', '9007199254740999', CHANGED],
      ['evt_9', '9007199254740998', LATEST],
      ['evt_same', '9007199254740999', LATEST],
    ] as const) storeEvent(db, changeEvent(id, ver, snap));
    assert.deepEqual(processInbox(db), { applied: 1, stale: 2, unsupported: 0 });
    const subject = rows(db, 'SELECT * FROM subjects')[0];
    assert.equal(subject.version, '9007199254740999');
    assert.deepEqual(JSON.parse(subject.company_json as string), CHANGED.company);
  } finally { db.close(); }
});

test('company deleted with invoice retained and older event cannot resurrect it', () => {
  const { db } = base();
  try {
    storeEvent(db, changeEvent('evt_deleted', '5', { company: null, invoice: CHANGED.invoice }));
    storeEvent(db, changeEvent('evt_stale', '4', CHANGED));
    processInbox(db);
    const s = rows(db, 'SELECT * FROM subjects')[0];
    assert.equal(JSON.parse(s.company_json as string), null);
    assert.ok(JSON.parse(s.invoice_json as string));
    assert.equal(s.version, '5');
  } finally { db.close(); }
});

test('pull page checkpoint and inbox are atomic, including invalid second event', () => {
  const { db } = base();
  try {
    const good = changeEvent('evt_good', '2', CHANGED);
    assert.throws(() => storePullPage(db, { mode: 'incremental', data: [good, { id: 'bad' } as never], next_cursor: 'mock:1' }), /invalid event shape/);
    assert.equal(getCheckpoint(db), 'mock:0');
    assert.equal(rows(db, 'SELECT * FROM inbox').length, 0);
    assert.equal(storePullPage(db, { mode: 'incremental', data: [good], next_cursor: 'mock:1' }), 1);
    assert.equal(storePullPage(db, { mode: 'incremental', data: [good], next_cursor: 'mock:1' }), 0);
    assert.equal(getCheckpoint(db), 'mock:1');
  } finally { db.close(); }
});

test('incremental gap captures new checkpoint before baseline and never claims to restore history', () => {
  const { db, api } = base();
  try {
    storeEvent(db, changeEvent('evt_demo_v2', '2', CHANGED));
    processInbox(db);
    assert.deepEqual(pullAndRecover(db, api), { recovered: false, inserted: 0 });
    api.enableGap();
    assert.deepEqual(pullAndRecover(db, api), { recovered: true, inserted: 0 });
    assert.equal(getCheckpoint(db), 'mock:4');
    assert.equal(rows(db, 'SELECT version FROM subjects')[0].version, '4');
    const trace = api.trace;
    assert.ok(trace.indexOf('incremental.start=now', 3) < trace.indexOf('watch.freshBaseline'));
    assert.ok(trace.indexOf('watch.freshBaseline') < trace.indexOf('incremental.pull:mock:3'));
  } finally { db.close(); }
});

test('inbox survives closing and re-opening a file-backed SQLite database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bango-partner-example-'));
  try {
    const file = join(dir, 'example.sqlite');
    let db = openStore(file);
    storeEvent(db, changeEvent('evt_pending', '3', CHANGED));
    db.close();
    db = openStore(file);
    assert.equal(rows(db, 'SELECT * FROM inbox').length, 1);
    assert.deepEqual(processInbox(db), { applied: 1, stale: 0, unsupported: 0 });
    assert.equal(rows(db, 'SELECT version FROM subjects')[0].version, '3');
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('receiver does not acknowledge if inbox database cannot commit', async () => {
  const db = openStore();
  const srv = createReceiver(db, DEMO_SECRET);
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  try {
    const bound = srv.address();
    if (!bound || typeof bound === 'string') throw new Error('bind failed');
    db.close();
    const msg = signDemo(DEMO_SECRET, changeEvent('evt_no_commit', '2', CHANGED));
    const res = await fetch(`http://127.0.0.1:${bound.port}/webhooks/demo`, {
      method: 'POST', headers: msg.headers, body: msg.body,
    });
    assert.equal(res.status, 500);
  } finally { srv.close(); await once(srv, 'close'); }
});


test('event without corporate_number still updates an already linked subject', () => {
  const { db } = base();
  try {
    const evt = changeEvent('evt_without_company_no', '7', CHANGED);
    delete evt.subject.corporate_number;
    storeEvent(db, evt);
    assert.deepEqual(processInbox(db), { applied: 1, stale: 0, unsupported: 0 });
    const p = rows(db, "SELECT subject_version FROM partners WHERE local_id='partner-1'")[0];
    assert.equal(p.subject_version, '7');
  } finally { db.close(); }
});
