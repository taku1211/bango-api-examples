import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore, applyBaseline, storeEvent, processInbox, storePullPage, getCheckpoint, setCheckpoint, currentState, type PullPage } from '../src/core.ts';
import { changeEvent, CHANGED, SUBJECT_ID, COMPANY_NUMBER } from '../src/mock.ts';

test('individual invoice snapshots keep company null without a corporate-number link', () => {
  const db = openStore();
  try {
    const event = changeEvent('evt_individual', '1', { company: null, invoice: CHANGED.invoice });
    event.subject = { id: 'sub_individual', version: '1', corporate_number: null };
    event.type = 'invoice.updated';
    storeEvent(db, event);
    assert.deepEqual(processInbox(db), { applied: 1, stale: 0, unsupported: 0 });
    const row = db.prepare('SELECT company_json,invoice_json FROM subjects').get();
    assert.equal(row?.company_json, 'null');
    assert.deepEqual(JSON.parse(String(row?.invoice_json)), CHANGED.invoice);
  } finally { db.close(); }
});

test('invoice deletion keeps its version and an older event cannot restore the invoice', () => {
  const db = openStore();
  try {
    applyBaseline(db, { id: SUBJECT_ID, version: '1', corporate_number: COMPANY_NUMBER }, CHANGED);
    const deleted = changeEvent('evt_invoice_deleted', '3', { company: CHANGED.company, invoice: null });
    deleted.type = 'invoice.deleted';
    storeEvent(db, deleted);
    storeEvent(db, changeEvent('evt_older_invoice', '2', CHANGED));
    assert.deepEqual(processInbox(db), { applied: 1, stale: 1, unsupported: 0 });
    const row = db.prepare('SELECT version,company_json,invoice_json FROM subjects').get();
    assert.equal(row?.version, '3');
    assert.equal(row?.invoice_json, 'null');
    assert.deepEqual(JSON.parse(String(row?.company_json)), CHANGED.company);
  } finally { db.close(); }
});

test('history pages cannot replace an incremental checkpoint or enqueue events', () => {
  const db = openStore();
  try {
    setCheckpoint(db, 'incremental:existing');
    assert.throws(() => storePullPage(db, {
      mode: 'history', data: [changeEvent('evt_history', '2', CHANGED)], next_cursor: 'history:cursor',
    } as unknown as PullPage), /incremental page required/);
    assert.equal(getCheckpoint(db), 'incremental:existing');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM inbox').get()?.count, 0);
  } finally { db.close(); }
});

test('missing snapshot keys roll back while explicit null remains a valid update', () => {
  const db = openStore();
  try {
    applyBaseline(db, { id: SUBJECT_ID, version: '1' }, CHANGED);
    const before = currentState(db);
    const invalid = changeEvent('evt_missing_invoice', '2', CHANGED);
    invalid.data.current = { company: null } as never;
    assert.throws(() => storePullPage(db, { mode: 'incremental', data: [invalid], next_cursor: 'new' }), /invalid event shape/);
    assert.deepEqual(currentState(db), before);
    storeEvent(db, changeEvent('evt_nulls', '2', { company: null, invoice: null }));
    assert.deepEqual(processInbox(db), { applied: 1, stale: 0, unsupported: 0 });
  } finally { db.close(); }
});
