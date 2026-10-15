import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { applySnapshot, getCheckpoint, openStore, setCheckpoint, storeEvent, transaction, validEvent, type ChangeEvent, type Snapshot, type Subject } from './core.ts';

const API_BASE = 'https://api.bango-api.jp/v1/';
const REQUEST_TIMEOUT_MS = 10_000;
const PAGE_LIMIT = 100;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const WATCH_ID = /^wt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SUBJECT_ID = /^sub_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type JsonObject = Record<string, unknown>;
type FetchLike = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

export type VerificationConfig = { organization: string; corporateNumber: string };
export type WatchInventoryEntry = { id: string; identifier: string; status: 'active' | 'stopped'; subject: { id: string; kind: string } };
export type WatchSnapshot = { id: string; status: 'active'; subject: Subject & { kind: string }; current: Snapshot };
export type IncrementalPage = { mode: 'incremental'; continuity_guaranteed: true; data: ChangeEvent[]; next_cursor: string; has_more: boolean };
export type VerificationSummary = {
  organization: string | null;
  corporateNumber: string | null;
  subjectId: string | null;
  subjectVersion: string | null;
  watchId: string | null;
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

  async watchInventory(): Promise<WatchInventoryEntry[]> {
    const data = await this.get('watch-targets?status=all&limit=100');
    if (!object(data) || !Array.isArray(data.data) || data.has_more !== false || data.data.length > PAGE_LIMIT) {
      throw new VerificationError('RemoteResponseInvalid');
    }
    const inventory = data.data.map((value) => {
      if (!object(value) || typeof value.id !== 'string' || !WATCH_ID.test(value.id) ||
          typeof value.identifier !== 'string' || !/^(?:\d{13}|T\d{13})$/.test(value.identifier) ||
          (value.status !== 'active' && value.status !== 'stopped') || !object(value.subject) ||
          typeof value.subject.id !== 'string' || !SUBJECT_ID.test(value.subject.id) || typeof value.subject.kind !== 'string') {
        throw new VerificationError('RemoteResponseInvalid');
      }
      return { id: value.id, identifier: value.identifier, status: value.status as WatchInventoryEntry['status'], subject: { id: value.subject.id, kind: value.subject.kind } };
    });
    if (new Set(inventory.map(entry => entry.id)).size !== inventory.length) throw new VerificationError('RemoteResponseInvalid');
    return inventory;
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

function requireMatchingBaseline(watch: WatchInventoryEntry, baseline: WatchSnapshot): void {
  if (baseline.id !== watch.id || baseline.subject.id !== watch.subject.id || baseline.status !== 'active' || baseline.subject.kind !== 'corporation') {
    throw new VerificationError('BaselineWatchMismatch');
  }
}

function sortedInventory(inventory: WatchInventoryEntry[]): WatchInventoryEntry[] {
  return [...inventory].sort((a, b) => a.id.localeCompare(b.id));
}

function serializeInventory(inventory: WatchInventoryEntry[]): string {
  return JSON.stringify(sortedInventory(inventory));
}

function readInventory(db: DatabaseSync, key: string): WatchInventoryEntry[] {
  const value = state(db, key);
  if (value === null) throw new VerificationError('WatchInventoryUnavailable');
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new VerificationError('WatchInventoryUnavailable'); }
  if (!Array.isArray(parsed)) throw new VerificationError('WatchInventoryUnavailable');
  for (const entry of parsed) {
    if (!object(entry) || typeof entry.id !== 'string' || !WATCH_ID.test(entry.id) ||
        typeof entry.identifier !== 'string' || !/^(?:\d{13}|T\d{13})$/.test(entry.identifier) ||
        (entry.status !== 'active' && entry.status !== 'stopped') || !object(entry.subject) ||
        typeof entry.subject.id !== 'string' || !SUBJECT_ID.test(entry.subject.id) || typeof entry.subject.kind !== 'string') {
      throw new VerificationError('WatchInventoryUnavailable');
    }
  }
  return parsed as WatchInventoryEntry[];
}

function requireUnchangedInventory(expected: WatchInventoryEntry[], actual: WatchInventoryEntry[]): void {
  if (serializeInventory(expected) !== serializeInventory(actual)) throw new VerificationError('WatchInventoryMismatch');
}

function requireOneAddedTarget(
  before: WatchInventoryEntry[],
  current: WatchInventoryEntry[],
  corporateNumber: string,
): WatchInventoryEntry {
  const beforeById = new Map(before.map(entry => [entry.id, entry]));
  const currentById = new Map(current.map(entry => [entry.id, entry]));
  if (currentById.size !== current.length || beforeById.size !== before.length) throw new VerificationError('WatchInventoryMismatch');
  for (const entry of before) {
    const now = currentById.get(entry.id);
    if (!now || JSON.stringify(now) !== JSON.stringify(entry)) throw new VerificationError('WatchInventoryMismatch');
  }
  const added = current.filter(entry => !beforeById.has(entry.id));
  if (added.length !== 1 || added[0].identifier !== corporateNumber || added[0].status !== 'active' || added[0].subject.kind !== 'corporation') {
    throw new VerificationError('WatchInventoryMismatch');
  }
  if (before.some(entry => entry.subject.id === added[0].subject.id)) throw new VerificationError('WatchSubjectCollision');
  return added[0];
}

function storeTargetPullPage(db: DatabaseSync, page: IncrementalPage, subjectId: string): { inserted: number; ignoredCount: number } {
  return transaction(db, () => {
    let inserted = 0;
    let ignoredCount = 0;
    for (const event of page.data) {
      if (event.subject.id !== subjectId) { ignoredCount++; continue; }
      inserted += Number(storeEvent(db, event));
    }
    setCheckpoint(db, page.next_cursor);
    return { inserted, ignoredCount };
  });
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
    const inventory = await this.remoteApi().watchInventory();
    if (inventory.some(entry => entry.identifier === this.config.corporateNumber || entry.identifier === `T${this.config.corporateNumber}`)) {
      throw new VerificationError('TargetAlreadyWatched');
    }
    const cursor = await this.remoteApi().startNow();
    transaction(this.db, () => {
      setState(this.db, 'organization', this.config.organization);
      setState(this.db, 'corporate_number', this.config.corporateNumber);
      setState(this.db, 'initial_inventory', serializeInventory(inventory));
      setCheckpoint(this.db, cursor);
    });
  }

  async baseline(): Promise<void> {
    requireBoundConfig(this.db, this.config);
    if (!getCheckpoint(this.db) || state(this.db, 'gap') === '1') throw new VerificationError('BaselineUnavailable');
    if (state(this.db, 'baseline_complete') === '1') throw new VerificationError('BaselineAlreadyComplete');
    const initialInventory = readInventory(this.db, 'initial_inventory');
    const currentInventory = await this.remoteApi().watchInventory();
    const watch = requireOneAddedTarget(initialInventory, currentInventory, this.config.corporateNumber);
    const baseline = await this.remoteApi().baseline(this.config.corporateNumber);
    requireMatchingBaseline(watch, baseline);
    transaction(this.db, () => {
      applySnapshot(this.db, baseline.subject, baseline.current);
      setState(this.db, 'baseline_complete', '1');
      setState(this.db, 'subject_id', baseline.subject.id);
      setState(this.db, 'subject_version', baseline.subject.version);
      setState(this.db, 'watch_id', watch.id);
      setState(this.db, 'watch_inventory', serializeInventory(currentInventory));
    });
  }

  async pull(): Promise<{ inserted: number; eventCount: number; ignoredCount: number; hasMore: boolean }> {
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
    const { inserted, ignoredCount } = storeTargetPullPage(this.db, page, subjectId);
    return { inserted, eventCount: page.data.length, ignoredCount, hasMore: page.has_more };
  }

  async recover(): Promise<void> {
    requireBoundConfig(this.db, this.config);
    if (state(this.db, 'baseline_complete') !== '1' || state(this.db, 'gap') !== '1') throw new VerificationError('RecoveryNotAvailable');
    const cursor = await this.remoteApi().startNow();
    const boundSubjectId = state(this.db, 'subject_id');
    const boundWatchId = state(this.db, 'watch_id');
    if (!boundSubjectId || !boundWatchId) throw new VerificationError('BoundSubjectMismatch');
    const watchInventory = readInventory(this.db, 'watch_inventory');
    const currentInventory = await this.remoteApi().watchInventory();
    requireUnchangedInventory(watchInventory, currentInventory);
    const watch = currentInventory.find(entry => entry.id === boundWatchId);
    if (!watch || watch.identifier !== this.config.corporateNumber || watch.status !== 'active' ||
        watch.subject.kind !== 'corporation' || watch.subject.id !== boundSubjectId) throw new VerificationError('BoundWatchMismatch');
    const baseline = await this.remoteApi().baseline(this.config.corporateNumber);
    requireMatchingBaseline(watch, baseline);
    transaction(this.db, () => {
      applySnapshot(this.db, baseline.subject, baseline.current);
      setState(this.db, 'subject_id', baseline.subject.id);
      setState(this.db, 'subject_version', baseline.subject.version);
      setState(this.db, 'watch_inventory', serializeInventory(currentInventory));
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
    watchId: safeDisplay(state(db, 'watch_id'), WATCH_ID),
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

