import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, getCheckpoint, storeEvent, type ChangeEvent } from '../src/core.ts';
import { createReceiver, signDemo } from '../src/webhook.ts';
import {
  acquireVerificationLock,
  openVerificationStore,
  VerificationApi,
  VerificationError,
  VerificationHarness,
  verificationStatus,
  type VerificationConfig,
} from '../src/verification.ts';
import { runVerificationCli } from '../src/verification-cli.ts';

const config: VerificationConfig = { organization: 'org_demo_01', corporateNumber: '1234567890123' };
const subjectId = 'sub_123e4567-e89b-42d3-a456-426614174000';
const otherSubjectId = 'sub_123e4567-e89b-42d3-a456-426614174002';
const watchId = 'wt_123e4567-e89b-42d3-a456-426614174001';
const secret = 'whsec_' + Buffer.from('verification-test-key').toString('base64');

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'bango-verification-'));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function event(id: string, version = '2'): ChangeEvent {
  return {
    id,
    type: 'company.updated',
    subject: { id: subjectId, version, corporate_number: config.corporateNumber },
    data: { current: { company: { name: 'Example' }, invoice: null } },
  };
}

function watchList(identifier = config.corporateNumber, id = watchId, subject = subjectId) {
  return { data: [{ id, identifier, status: 'active', subject: { id: subject, kind: 'corporation' } }], has_more: false };
}

function baseline(id = watchId, subject = subjectId, version = '1') {
  return { id, status: 'active', subject: { id: subject, kind: 'corporation', version }, current: { company: { name: 'Baseline' }, invoice: null } };
}

function startNow(cursor: string) {
  return { mode: 'incremental', continuity_guaranteed: true, data: [], next_cursor: cursor, has_more: false };
}

function queueFetch(responses: Array<{ body?: unknown; status?: number }>) {
  const paths: string[] = [];
  const methods: string[] = [];
  return {
    paths,
    methods,
    fetch: async (input: URL | RequestInfo, init?: RequestInit) => {
      paths.push(String(input));
      methods.push(String(init?.method));
      const next = responses.shift();
      if (!next) throw new Error('unexpected test request');
      return jsonResponse(next.body ?? {}, next.status ?? 200);
    },
  };
}

function harness(dbPath: string, responses: Array<{ body?: unknown; status?: number }>) {
  const db = openVerificationStore(dbPath);
  const queue = queueFetch(responses);
  const api = new VerificationApi('test-api-key', { fetch: queue.fetch });
  return { db, queue, harness: new VerificationHarness(db, config, api) };
}

test('init persists the owner assertion and checkpoint across a process restart using GET only', async () => {
  const dir = tempDir();
  try {
    const stateDir = join(dir, 'state');
    const first = harness(stateDir, [
      { body: { data: [], has_more: false } },
      { body: startNow('opaque-checkpoint-secret') },
    ]);
    try {
      await first.harness.init();
      assert.deepEqual(first.queue.methods, ['GET', 'GET']);
      assert.match(first.queue.paths[0], /watch-targets\?status=active&limit=2$/);
      assert.match(first.queue.paths[1], /change-events\?mode=incremental&start=now$/);
      assert.deepEqual(verificationStatus(first.db), {
        organization: config.organization,
        corporateNumber: config.corporateNumber,
        subjectId: null,
        subjectVersion: null,
        checkpointPresent: true,
        gap: false,
        inboxCount: 0,
        inboxEvents: [],
      });
    } finally { first.db.close(); }

    const restarted = openVerificationStore(stateDir);
    try {
      assert.equal(getCheckpoint(restarted), 'opaque-checkpoint-secret');
      assert.equal(verificationStatus(restarted).organization, config.organization);
      assert.equal(verificationStatus(restarted).corporateNumber, config.corporateNumber);
    } finally { restarted.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('init refuses active watches and baseline refuses a subject mismatch without replacing the checkpoint', async () => {
  const dir = tempDir();
  try {
    const active = harness(join(dir, 'active'), [{ body: watchList() }]);
    try {
      await assert.rejects(active.harness.init(), (error: unknown) => error instanceof VerificationError && error.code === 'ActiveWatchSetMismatch');
      assert.equal(getCheckpoint(active.db), null);
      assert.equal(active.queue.paths.length, 1, 'start=now is not called when an active watch exists');
    } finally { active.db.close(); }

    const before = harness(join(dir, 'mismatch'), [
      { body: { data: [], has_more: false } },
      { body: startNow('old-cursor') },
      { body: watchList(config.corporateNumber, watchId, subjectId) },
      { body: baseline(watchId, otherSubjectId) },
    ]);
    try {
      await before.harness.init();
      await assert.rejects(before.harness.baseline(), (error: unknown) => error instanceof VerificationError && error.code === 'BaselineWatchMismatch');
      assert.equal(getCheckpoint(before.db), 'old-cursor');
      assert.equal(before.harness.hasBaseline(), false);
    } finally { before.db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('one pull page is atomic when an inbox insert fails', async () => {
  const dir = tempDir();
  try {
    const setup = harness(join(dir, 'state'), [
      { body: { data: [], has_more: false } },
      { body: startNow('checkpoint-before') },
      { body: watchList() },
      { body: baseline() },
      { body: { mode: 'incremental', continuity_guaranteed: true, data: [event('evt_page_one'), event('evt_page_two', '3')], next_cursor: 'checkpoint-after', has_more: false } },
    ]);
    try {
      await setup.harness.init();
      await setup.harness.baseline();
      setup.db.exec(`CREATE TRIGGER reject_second_event BEFORE INSERT ON inbox WHEN NEW.event_id='evt_page_two' BEGIN SELECT RAISE(ABORT, 'fixture insert failure'); END`);
      await assert.rejects(setup.harness.pull());
      assert.equal(getCheckpoint(setup.db), 'checkpoint-before');
      assert.equal((setup.db.prepare('SELECT COUNT(*) AS count FROM inbox').get() as { count: number }).count, 0);
      assert.deepEqual(setup.queue.methods, ['GET', 'GET', 'GET', 'GET', 'GET']);
      assert.match(setup.queue.paths[4], /change-events\?mode=incremental&cursor=checkpoint-before&limit=100$/);
    } finally { setup.db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a stubbed HTTP 410 records a gap; failed recovery preserves checkpoint and inbox, and successful recovery orders its GETs', async () => {
  const dir = tempDir();
  try {
    const initial = harness(join(dir, 'state'), [
      { body: { data: [], has_more: false } }, { body: startNow('checkpoint-before') },
      { body: watchList() }, { body: baseline() }, { status: 410, body: { detail: 'sensitive response detail' } },
    ]);
    try {
      await initial.harness.init();
      await initial.harness.baseline();
      storeEvent(initial.db, event('evt_saved_before_gap'));
      await assert.rejects(initial.harness.pull(), (error: unknown) => error instanceof VerificationError && error.code === 'CheckpointExpired');
      assert.equal(getCheckpoint(initial.db), 'checkpoint-before');
      assert.equal(verificationStatus(initial.db).gap, true);
      assert.equal((initial.db.prepare('SELECT COUNT(*) AS count FROM inbox').get() as { count: number }).count, 1);
    } finally { initial.db.close(); }

    const failed = harness(join(dir, 'state'), [
      { body: startNow('must-not-commit') },
      { body: { data: [{ id: watchId, identifier: config.corporateNumber, subject: { id: otherSubjectId, kind: 'corporation' } }], has_more: false } },
    ]);
    try {
      await assert.rejects(failed.harness.recover(), (error: unknown) => error instanceof VerificationError && error.code === 'BoundSubjectMismatch');
      assert.deepEqual(failed.queue.paths.map(path => new URL(path).pathname), ['/v1/change-events', '/v1/watch-targets']);
      assert.equal(getCheckpoint(failed.db), 'checkpoint-before');
      assert.equal(verificationStatus(failed.db).gap, true);
      assert.equal((failed.db.prepare('SELECT COUNT(*) AS count FROM inbox').get() as { count: number }).count, 1);
    } finally { failed.db.close(); }

    const recovered = harness(join(dir, 'state'), [
      { body: startNow('checkpoint-after-recovery') },
      { body: watchList() },
      { body: baseline(watchId, subjectId, '4') },
    ]);
    try {
      await recovered.harness.recover();
      assert.deepEqual(recovered.queue.methods, ['GET', 'GET', 'GET']);
      assert.deepEqual(recovered.queue.paths.map(path => new URL(path).pathname), [
        '/v1/change-events', '/v1/watch-targets', '/v1/watch-targets/1234567890123',
      ]);
      assert.equal(getCheckpoint(recovered.db), 'checkpoint-after-recovery');
      assert.equal(verificationStatus(recovered.db).gap, false);
      assert.equal((recovered.db.prepare('SELECT COUNT(*) AS count FROM inbox').get() as { count: number }).count, 1);
    } finally { recovered.db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pull encodes opaque cursors and only accepts a valid incremental page for the bound subject', async () => {
  const dir = tempDir();
  try {
    const setup = harness(join(dir, 'state'), [
      { body: { data: [], has_more: false } }, { body: startNow('cursor') },
      { body: watchList() }, { body: baseline() },
      { body: { mode: 'incremental', continuity_guaranteed: true, data: [event('evt_valid')], next_cursor: 'cursor+/next', has_more: true } },
    ]);
    try {
      await setup.harness.init();
      await setup.harness.baseline();
      assert.deepEqual(await setup.harness.pull(), { inserted: 1, eventCount: 1, hasMore: true });
      const requested = new URL(setup.queue.paths[4]);
      assert.equal(requested.searchParams.get('cursor'), 'cursor');
      assert.equal(requested.searchParams.get('limit'), '100');
      assert.equal(getCheckpoint(setup.db), 'cursor+/next');
    } finally { setup.db.close(); }

    const wrongSubject = harness(join(dir, 'wrong-subject'), [
      { body: { data: [], has_more: false } }, { body: startNow('before') },
      { body: watchList() }, { body: baseline() },
      { body: { mode: 'incremental', continuity_guaranteed: true, data: [{ ...event('evt_wrong_subject'), subject: { id: 'sub_foreign', version: '2' } }], next_cursor: 'after', has_more: false } },
    ]);
    try {
      await wrongSubject.harness.init();
      await wrongSubject.harness.baseline();
      await assert.rejects(wrongSubject.harness.pull(), (error: unknown) => error instanceof VerificationError && error.code === 'EventSubjectMismatch');
      assert.equal(getCheckpoint(wrongSubject.db), 'before');
      assert.equal((wrongSubject.db.prepare('SELECT COUNT(*) AS count FROM inbox').get() as { count: number }).count, 0);
    } finally { wrongSubject.db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('GET adapter strips transport details and state directory and lock have private permissions', async () => {
  const dir = tempDir();
  try {
    const stateDir = join(dir, 'private');
    const store = openVerificationStore(stateDir);
    try {
      assert.equal(statSync(stateDir).mode & 0o777, 0o700);
      assert.equal(statSync(join(stateDir, 'verification.sqlite')).mode & 0o777, 0o600);
      const release = acquireVerificationLock(stateDir);
      try {
        assert.equal(statSync(join(stateDir, '.verification.lock')).mode & 0o777, 0o600);
        let captured = '';
        const stderr: string[] = [];
        const result = await runVerificationCli(['status'], { BANGO_VERIFICATION_DIR: stateDir }, {
          stdout: line => { captured += line; }, stderr: line => stderr.push(line),
        });
        assert.equal(result, 1);
        assert.match(stderr.join(' '), /VerificationAlreadyRunning/);
        assert.doesNotMatch(captured + stderr.join(' '), /test-api-key|whsec_|opaque-checkpoint-secret/);
      } finally { release(); }
    } finally { store.close(); }

    const api = new VerificationApi('do-not-print-this-key', { fetch: async () => { throw new Error('sensitive transport error'); } });
    await assert.rejects(api.get('watch-targets?status=active&limit=2'), (error: unknown) => {
      assert.ok(error instanceof VerificationError);
      assert.doesNotMatch(String(error), /do-not-print-this-key|sensitive transport error/);
      return true;
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('serve refuses a changed owner assertion before opening the webhook listener', async () => {
  const dir = tempDir();
  try {
    const stateDir = join(dir, 'state');
    const prepared = harness(stateDir, [
      { body: { data: [], has_more: false } }, { body: startNow('cursor') },
      { body: watchList() }, { body: baseline() },
    ]);
    try {
      await prepared.harness.init();
      await prepared.harness.baseline();
    } finally { prepared.db.close(); }

    const output: string[] = [];
    const errors: string[] = [];
    const result = await runVerificationCli(['serve', '--confirm'], {
      BANGO_VERIFICATION_DIR: stateDir,
      BANGO_VERIFICATION_ORG: 'org_different',
      BANGO_PUBLIC_CORPORATE_NUMBER: config.corporateNumber,
      BANGO_WEBHOOK_SECRET: secret,
      BANGO_VERIFICATION_WINDOW_SECONDS: '1',
      HOST: '127.0.0.1',
      PORT: '39127',
    }, { stdout: line => output.push(line), stderr: line => errors.push(line) });
    assert.equal(result, 1);
    assert.match(errors.join(' '), /OwnerAssertionDoesNotMatchStore/);
    assert.doesNotMatch(output.join(' '), /listening|webhooks\/demo/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI reports the HTTP 410 status while keeping the response body and cursor private', async () => {
  const dir = tempDir();
  try {
    const stateDir = join(dir, 'state');
    const prepared = harness(stateDir, [
      { body: { data: [], has_more: false } }, { body: startNow('private-cursor-value') },
      { body: watchList() }, { body: baseline() },
    ]);
    try {
      await prepared.harness.init();
      await prepared.harness.baseline();
    } finally { prepared.db.close(); }

    const queue = queueFetch([{ status: 410, body: { detail: 'private response body' } }]);
    const errors: string[] = [];
    const result = await runVerificationCli(['pull', '--confirm'], {
      BANGO_VERIFICATION_DIR: stateDir,
      BANGO_VERIFICATION_ORG: config.organization,
      BANGO_PUBLIC_CORPORATE_NUMBER: config.corporateNumber,
      BANGO_API_KEY: 'private-api-key',
    }, { fetch: queue.fetch, stdout: () => {}, stderr: line => errors.push(line) });
    assert.equal(result, 1);
    assert.match(errors.join(' '), /"status": 410/);
    assert.match(errors.join(' '), /CheckpointExpired/);
    assert.doesNotMatch(errors.join(' '), /private response body|private-cursor-value|private-api-key/);
    const reopened = openVerificationStore(stateDir);
    try {
      assert.equal(verificationStatus(reopened).gap, true);
      assert.equal(getCheckpoint(reopened), 'private-cursor-value');
    } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('serve CLI receives a signed event, rejects another subject, stops on SIGTERM, and persists evidence for status', async () => {
  const dir = tempDir();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const stateDir = join(dir, 'state');
    const prepared = harness(stateDir, [
      { body: { data: [], has_more: false } }, { body: startNow('private-cursor-value') },
      { body: watchList() }, { body: baseline() },
    ]);
    try {
      await prepared.harness.init();
      await prepared.harness.baseline();
    } finally { prepared.db.close(); }

    const probe = createServer();
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    await new Promise<void>(resolve => probe.close(() => resolve()));

    const cliPath = fileURLToPath(new URL('../src/verification-cli.ts', import.meta.url));
    const childEnv = {
      ...process.env,
      BANGO_VERIFICATION_DIR: stateDir,
      BANGO_VERIFICATION_ORG: config.organization,
      BANGO_PUBLIC_CORPORATE_NUMBER: config.corporateNumber,
      BANGO_WEBHOOK_SECRET: secret,
      BANGO_VERIFICATION_WINDOW_SECONDS: '600',
      HOST: '127.0.0.1',
      PORT: String(port),
    };
    const serverChild = spawn(process.execPath, ['--experimental-strip-types', cliPath, 'serve', '--confirm'], { env: childEnv });
    child = serverChild;
    assert.ok(serverChild.stdout && serverChild.stderr);
    let serverOutput = '';
    let serverError = '';
    serverChild.stdout.setEncoding('utf8').on('data', chunk => { serverOutput += chunk; });
    serverChild.stderr.setEncoding('utf8').on('data', chunk => { serverError += chunk; });

    const endpoint = `http://127.0.0.1:${port}/webhooks/demo`;
    const deadline = Date.now() + 10_000;
    let ready = false;
    while (!ready && Date.now() < deadline && serverChild.exitCode === null) {
      try { ready = (await fetch(endpoint)).status === 405; }
      catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.ok(ready, `verification listener did not start: ${serverOutput} ${serverError}`);
    assert.match(serverOutput, /"listening": true/);
    const acceptedId = 'evt_123e4567-e89b-42d3-a456-426614174099';
    const acceptedMessage = signDemo(secret, event(acceptedId));
    assert.equal((await fetch(endpoint, { method: 'POST', headers: acceptedMessage.headers, body: acceptedMessage.body })).status, 200);
    const foreignEvent = { ...event('evt_123e4567-e89b-42d3-a456-426614174098'), subject: { ...event('evt_unused').subject, id: otherSubjectId } };
    const foreignMessage = signDemo(secret, foreignEvent);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: foreignMessage.headers, body: foreignMessage.body })).status, 400);

    let shutdownWatchdog: NodeJS.Timeout;
    const serverClosed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      shutdownWatchdog = setTimeout(() => reject(new Error('verification listener did not stop within 20 seconds')), 20_000);
      shutdownWatchdog.unref();
      serverChild.once('close', (code, signal) => resolve({ code, signal }));
    });
    serverChild.kill('SIGTERM');
    const stopped = await serverClosed;
    clearTimeout(shutdownWatchdog!);
    assert.equal(stopped.code, 0);
    assert.match(serverOutput, /"served": true/);
    assert.doesNotMatch(serverError, /private-cursor-value|whsec_|Example/);
    child = undefined;

    const status = spawn(process.execPath, ['--experimental-strip-types', cliPath, 'status'], {
      env: { ...process.env, BANGO_VERIFICATION_DIR: stateDir },
    });
    let statusOutput = '';
    let statusError = '';
    status.stdout.setEncoding('utf8').on('data', chunk => { statusOutput += chunk; });
    status.stderr.setEncoding('utf8').on('data', chunk => { statusError += chunk; });
    const statusCode = await new Promise<number | null>(resolve => status.once('close', resolve));
    assert.equal(statusCode, 0);
    const evidence = JSON.parse(statusOutput) as ReturnType<typeof verificationStatus>;
    assert.equal(evidence.inboxCount, 1);
    assert.deepEqual(evidence.inboxEvents, [{ eventId: acceptedId, eventType: 'company.updated', subjectId, subjectVersion: '2' }]);
    assert.doesNotMatch(statusOutput + statusError, /private-cursor-value|whsec_|Example/);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the existing receiver acknowledges only after durable inbox storage and ignores endpoint.test', async () => {
  const dir = tempDir();
  const path = join(dir, 'receiver.sqlite');
  let db = openStore(path);
  const server = createReceiver(db, secret);
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/webhooks/demo`;
    const eventId = 'evt_123e4567-e89b-42d3-a456-426614174099';
    const signedEvent = signDemo(secret, event(eventId));
    const accepted = await fetch(base, { method: 'POST', headers: signedEvent.headers, body: signedEvent.body });
    assert.equal(accepted.status, 200);
    db.close();
    db = openStore(path);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM inbox WHERE event_id=?').get(eventId) as { count: number }).count, 1);
    assert.deepEqual(verificationStatus(db).inboxEvents, [{
      eventId, eventType: 'company.updated', subjectId, subjectVersion: '2',
    }]);

    const endpointTest = signDemo(secret, { id: 'whtest_123e4567-e89b-42d3-a456-426614174002', type: 'endpoint.test' });
    const tested = await fetch(base, { method: 'POST', headers: endpointTest.headers, body: endpointTest.body });
    assert.equal(tested.status, 200);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM inbox').get() as { count: number }).count, 1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
