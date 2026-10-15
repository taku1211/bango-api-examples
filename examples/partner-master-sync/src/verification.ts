import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { applySnapshot, getCheckpoint, openStore, setCheckpoint, storePullPage, transaction, validEvent, type ChangeEvent, type Snapshot, type Subject } from './core.ts';

const API_BASE = 'https://api.bango-api.jp/v1/';
const REQUEST_TIMEOUT_MS = 10_000;
const PAGE_LIMIT = 100;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const WATCH_ID = /^wt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SUBJECT_ID = /^sub_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type JsonObject = Record<string, unknown>;
type FetchLike = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

export type VerificationConfig = { organization: string; corporateNumber: string };
export type ActiveWatch = { id: string; identifier: string; subject: { id: string; kind: string } };
export type WatchSnapshot = { id: string; status: 'active'; subject: Subject & { kind: string }; current: Snapshot };
export type IncrementalPage = { mode: 'incremental'; continuity_guaranteed: true; data: ChangeEvent[]; next_cursor: string; has_more: boolean };
export type VerificationSummary = {
  organization: string | null;
  corporateNumber: string | null;
  subjectId: string | null;
  subjectVersion: string | null;
  checkpointPresent: boolean;
  gap: boolean;
  inboxCount: number;
  inboxEvents: Array<{ eventId: string; eventType: string | null; subjectId: string | null; subjectVersion: string | null }>;
};

export class VerificationError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; this.name = 'VerificationError'; }
}

export class VerificationApiError extends VerificationError {
  readonly status: number;
  constructor(status: number) { super(status === 410 ? 'CheckpointExpired' : 'RemoteRequestFailed'); this.status = status; this.name = 'VerificationApiError'; }
}

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isVersion(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
}

function isSnapshot(value: unknown): value is Snapshot {
  return object(value) && Object.hasOwn(value, 'company') && Object.hasOwn(value, 'invoice') &&
    (value.company === null || object(value.company)) && (value.invoice === null || object(value.invoice));
}

function validateConfig(config: VerificationConfig): void {
  if (!SAFE_ID.test(config.organization)) throw new VerificationError('InvalidOrganizationId');
  if (!/^\d{13}$/.test(config.corporateNumber)) throw new VerificationError('InvalidCorporateNumber');
}

export class VerificationApi {
  private readonly fetchImpl: FetchLike;
  private readonly apiKey: string;

  constructor(apiKey: string, options: { fetch?: FetchLike } = {}) {
    if (!apiKey.trim()) throw new VerificationError('ApiKeyRequired');
    this.apiKey = apiKey;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async get(path: string): Promise<unknown> {
    const url = new URL(path, API_BASE);
    if (url.origin !== new URL(API_BASE).origin || !url.pathname.startsWith('/v1/')) throw new VerificationError('InvalidRemotePath');
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json, application/problem+json', 'x-api-key': this.apiKey },
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new VerificationError('RemoteTransportFailed');
    }
    if (!response.ok) throw new VerificationApiError(response.status);
    try {
      return await response.json() as unknown;
    } catch {
      throw new VerificationError('RemoteResponseInvalid');
    }
  }

  async activeWatches(): Promise<ActiveWatch[]> {
    const data = await this.get('watch-targets?status=active&limit=2');
    if (!object(data) || !Array.isArray(data.data) || data.has_more !== false || data.data.length > 2) {
      throw new VerificationError('RemoteResponseInvalid');
    }
    return data.data.map((value) => {
      if (!object(value) || typeof value.id !== 'string' || !WATCH_ID.test(value.id) || typeof value.identifier !== 'string' ||
          !object(value.subject) || typeof value.subject.id !== 'string' || !SUBJECT_ID.test(value.subject.id) || typeof value.subject.kind !== 'string') {
        throw new VerificationError('RemoteResponseInvalid');
      }
      return { id: value.id, identifier: value.identifier, subject: { id: value.subject.id, kind: value.subject.kind } };
    });
  }

  async startNow(): Promise<string> {
    const page = await this.get('change-events?mode=incremental&start=now');
    if (!object(page) || page.mode !== 'incremental' || page.continuity_guaranteed !== true || !Array.isArray(page.data) ||
        page.data.length !== 0 || page.has_more !== false || typeof page.next_cursor !== 'string' || !page.next_cursor) {
      throw new VerificationError('RemoteResponseInvalid');
    }
    return page.next_cursor;
  }

  async baseline(corporateNumber: string): Promise<WatchSnapshot> {
    const data = await this.get(`watch-targets/${encodeURIComponent(corporateNumber)}`);
    if (!object(data)) throw new VerificationError('RemoteResponseInvalid');
    if (typeof data.id !== 'string' || !WATCH_ID.test(data.id) || data.status !== 'active' || !object(data.subject) ||
        typeof data.subject.id !== 'string' || !SUBJECT_ID.test(data.subject.id) || data.subject.kind !== 'corporation' ||
        !isVersion(data.subject.version) || !isSnapshot(data.current)) {
      throw new VerificationError('RemoteResponseInvalid');
    }
    return {
      id: data.id,
      status: 'active',
      subject: { id: data.subject.id, kind: 'corporation', version: data.subject.version, corporate_number: corporateNumber },
      current: data.current,
    };
  }

  async pull(cursor: string): Promise<IncrementalPage> {
    const query = new URLSearchParams({ mode: 'incremental', cursor, limit: String(PAGE_LIMIT) });
    const data = await this.get(`change-events?${query.toString()}`);
    if (!object(data)) throw new VerificationError('RemoteResponseInvalid');
    if (data.mode !== 'incremental' || data.continuity_guaranteed !== true || !Array.isArray(data.data) ||
        data.data.length > PAGE_LIMIT || typeof data.next_cursor !== 'string' || !data.next_cursor || typeof data.has_more !== 'boolean') {
      throw new VerificationError('RemoteResponseInvalid');
    }
    for (const event of data.data) if (!validEvent(event)) throw new VerificationError('RemoteResponseInvalid');
    return { mode: 'incremental', continuity_guaranteed: true, data: data.data as ChangeEvent[], next_cursor: data.next_cursor, has_more: data.has_more };
  }
}

export function ensureVerificationSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS verification_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
}

function state(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM verification_state WHERE key=?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setState(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO verification_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}

function requireBoundConfig(db: DatabaseSync, config: VerificationConfig): void {
  validateConfig(config);
  if (state(db, 'organization') !== config.organization || state(db, 'corporate_number') !== config.corporateNumber) {
    throw new VerificationError('OwnerAssertionDoesNotMatchStore');
  }
}

function requireOneMatchingWatch(watches: ActiveWatch[], corporateNumber: string, subjectId?: string): ActiveWatch {
  if (watches.length !== 1 || watches[0].identifier !== corporateNumber || watches[0].subject.kind !== 'corporation') {
    throw new VerificationError('ActiveWatchSetMismatch');
  }
  if (subjectId && watches[0].subject.id !== subjectId) throw new VerificationError('BoundSubjectMismatch');
  return watches[0];
}

function requireMatchingBaseline(watch: ActiveWatch, baseline: WatchSnapshot): void {
  if (baseline.id !== watch.id || baseline.subject.id !== watch.subject.id || baseline.status !== 'active' || baseline.subject.kind !== 'corporation') {
    throw new VerificationError('BaselineWatchMismatch');
  }
}

function verifyEmptyStore(db: DatabaseSync): void {
  if (state(db, 'organization') !== null || state(db, 'corporate_number') !== null ||
      getCheckpoint(db) !== null ||
      (db.prepare('SELECT COUNT(*) AS count FROM verification_state').get() as { count: number }).count !== 0 ||
      (db.prepare('SELECT COUNT(*) AS count FROM checkpoints').get() as { count: number }).count !== 0 ||
      (db.prepare('SELECT COUNT(*) AS count FROM inbox').get() as { count: number }).count !== 0 ||
      (db.prepare('SELECT COUNT(*) AS count FROM subjects').get() as { count: number }).count !== 0 ||
      (db.prepare('SELECT COUNT(*) AS count FROM partners').get() as { count: number }).count !== 0) {
    throw new VerificationError('StoreNotEmpty');
  }
}

function markGap(db: DatabaseSync): void {
  transaction(db, () => setState(db, 'gap', '1'));
}

export class VerificationHarness {
  private readonly db: DatabaseSync;
  private readonly config: VerificationConfig;
  private readonly api?: VerificationApi;

  constructor(db: DatabaseSync, config: VerificationConfig, api?: VerificationApi) {
    this.db = db;
    this.config = config;
    this.api = api;
    validateConfig(config);
    ensureVerificationSchema(db);
  }

  async init(): Promise<void> {
    verifyEmptyStore(this.db);
    const watches = await this.remoteApi().activeWatches();
    if (watches.length !== 0 || state(this.db, 'organization') !== null) throw new VerificationError('ActiveWatchSetMismatch');
    const cursor = await this.remoteApi().startNow();
    transaction(this.db, () => {
      setState(this.db, 'organization', this.config.organization);
      setState(this.db, 'corporate_number', this.config.corporateNumber);
      setCheckpoint(this.db, cursor);
    });
  }

  async baseline(): Promise<void> {
    requireBoundConfig(this.db, this.config);
    if (!getCheckpoint(this.db) || state(this.db, 'gap') === '1') throw new VerificationError('BaselineUnavailable');
    if (state(this.db, 'baseline_complete') === '1') throw new VerificationError('BaselineAlreadyComplete');
    const watch = requireOneMatchingWatch(await this.remoteApi().activeWatches(), this.config.corporateNumber);
    const baseline = await this.remoteApi().baseline(this.config.corporateNumber);
    requireMatchingBaseline(watch, baseline);
    transaction(this.db, () => {
      applySnapshot(this.db, baseline.subject, baseline.current);
      setState(this.db, 'baseline_complete', '1');
      setState(this.db, 'subject_id', baseline.subject.id);
      setState(this.db, 'subject_version', baseline.subject.version);
    });
  }

  async pull(): Promise<{ inserted: number; eventCount: number; hasMore: boolean }> {
    requireBoundConfig(this.db, this.config);
    if (state(this.db, 'baseline_complete') !== '1' || state(this.db, 'gap') === '1') throw new VerificationError('BaselineUnavailable');
    const cursor = getCheckpoint(this.db);
    const subjectId = state(this.db, 'subject_id');
    if (!cursor || !subjectId) throw new VerificationError('CheckpointUnavailable');
    let page: IncrementalPage;
    try {
      page = await this.remoteApi().pull(cursor);
    } catch (error) {
      if (error instanceof VerificationApiError && error.status === 410) {
        markGap(this.db);
        throw error;
      }
      throw error;
    }
    if (page.data.some(event => event.subject.id !== subjectId)) throw new VerificationError('EventSubjectMismatch');
    const inserted = storePullPage(this.db, { mode: page.mode, data: page.data, next_cursor: page.next_cursor });
    return { inserted, eventCount: page.data.length, hasMore: page.has_more };
  }

  async recover(): Promise<void> {
    requireBoundConfig(this.db, this.config);
    if (state(this.db, 'baseline_complete') !== '1' || state(this.db, 'gap') !== '1') throw new VerificationError('RecoveryNotAvailable');
    const cursor = await this.remoteApi().startNow();
    const boundSubjectId = state(this.db, 'subject_id');
    if (!boundSubjectId) throw new VerificationError('BoundSubjectMismatch');
    const watch = requireOneMatchingWatch(await this.remoteApi().activeWatches(), this.config.corporateNumber, boundSubjectId);
    const baseline = await this.remoteApi().baseline(this.config.corporateNumber);
    requireMatchingBaseline(watch, baseline);
    transaction(this.db, () => {
      applySnapshot(this.db, baseline.subject, baseline.current);
      setState(this.db, 'subject_id', baseline.subject.id);
      setState(this.db, 'subject_version', baseline.subject.version);
      setCheckpoint(this.db, cursor);
      setState(this.db, 'gap', '0');
    });
  }

  status(): VerificationSummary {
    return verificationStatus(this.db);
  }

  assertBoundConfiguration(): void {
    requireBoundConfig(this.db, this.config);
  }

  hasBaseline(): boolean {
    return state(this.db, 'baseline_complete') === '1';
  }

  private remoteApi(): VerificationApi {
    if (!this.api) throw new VerificationError('RemoteApiUnavailable');
    return this.api;
  }
}

export function verificationStatus(db: DatabaseSync): VerificationSummary {
  ensureVerificationSchema(db);
  const subject = db.prepare("SELECT subject_id,version FROM subjects WHERE consumer_id='accounting-demo' ORDER BY rowid DESC LIMIT 1").get() as { subject_id: string; version: string } | undefined;
  const inbox = db.prepare("SELECT COUNT(*) AS count FROM inbox WHERE consumer_id='accounting-demo'").get() as { count: number };
  const rows = db.prepare("SELECT event_id,payload FROM inbox WHERE consumer_id='accounting-demo' ORDER BY rowid DESC LIMIT 100").all() as { event_id: string; payload: string }[];
  const inboxEvents = rows.reverse().map(row => {
    try {
      const event = JSON.parse(row.payload) as { id?: unknown; type?: unknown; subject?: { id?: unknown; version?: unknown } };
      return {
        eventId: safeDisplay(event.id, /^evt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) ??
          safeDisplay(row.event_id, /^evt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) ?? 'unavailable',
        eventType: safeDisplay(event.type, /^[a-z][a-z0-9_.]{0,63}$/),
        subjectId: safeDisplay(event.subject?.id, /^sub_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
        subjectVersion: safeDisplay(event.subject?.version, /^(0|[1-9][0-9]{0,63})$/),
      };
    } catch {
      return { eventId: safeDisplay(row.event_id, /^evt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) ?? 'unavailable', eventType: null, subjectId: null, subjectVersion: null };
    }
  });
  return {
    organization: safeDisplay(state(db, 'organization'), SAFE_ID),
    corporateNumber: safeDisplay(state(db, 'corporate_number'), /^\d{13}$/),
    subjectId: safeDisplay(state(db, 'subject_id'), SUBJECT_ID) ?? safeDisplay(subject?.subject_id, SUBJECT_ID),
    subjectVersion: safeDisplay(state(db, 'subject_version'), /^(0|[1-9][0-9]{0,63})$/) ?? safeDisplay(subject?.version, /^(0|[1-9][0-9]{0,63})$/),
    checkpointPresent: getCheckpoint(db) !== null,
    gap: state(db, 'gap') === '1',
    inboxCount: inbox.count,
    inboxEvents,
  };
}

function safeDisplay(value: unknown, pattern: RegExp): string | null {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

export function openVerificationStore(stateDir: string): DatabaseSync {
  if (!isAbsolute(stateDir)) throw new VerificationError('StateDirectoryMustBeAbsolute');
  prepareVerificationDirectory(stateDir);
  const databasePath = join(stateDir, 'verification.sqlite');
  if (existsSync(databasePath) && lstatSync(databasePath).isSymbolicLink()) throw new VerificationError('UnsafeStatePath');
  const db = openStore(databasePath);
  chmodSync(databasePath, 0o600);
  ensureVerificationSchema(db);
  return db;
}

export function prepareVerificationDirectory(stateDir: string): void {
  if (!isAbsolute(stateDir)) throw new VerificationError('StateDirectoryMustBeAbsolute');
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const info = lstatSync(stateDir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new VerificationError('UnsafeStatePath');
  chmodSync(stateDir, 0o700);
}

export function acquireVerificationLock(stateDir: string): () => void {
  prepareVerificationDirectory(stateDir);
  const lockPath = join(stateDir, '.verification.lock');
  let fd: number;
  try {
    fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch {
    throw new VerificationError('VerificationAlreadyRunning');
  }
  try { writeSync(fd, `${process.pid}\n`); }
  catch {
    closeSync(fd);
    unlinkSync(lockPath);
    throw new VerificationError('VerificationLockFailed');
  }
  return () => {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(lockPath); } catch { /* lock may already be removed */ }
  };
}

