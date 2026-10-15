import type { BatchRow, ChangeEvent, PullPage, Snapshot, Subject } from './core.ts';

export const DEMO_SECRET = 'whsec_' + Buffer.alloc(32, 7).toString('base64'); // fixture ONLY
export const COMPANY_NUMBER = '1234567890123'; // synthetic, not a registered company
export const SUBJECT_ID = 'sub_demo';
const company = { corporate_number: COMPANY_NUMBER, name: '株式会社あおぞら商事', address: '架空県架空市1-1' };
const invoice = { registration_number: `T${COMPANY_NUMBER}`, invoice: { valid: true } };
export const BASELINE: Snapshot = { company, invoice };
export const CHANGED: Snapshot = { company: { ...company, name: '株式会社あおぞら商事グループ' }, invoice };
export const LATEST: Snapshot = { company: { ...company, name: '株式会社あおぞら商事ホールディングス' }, invoice };

export function changeEvent(id: string, version: string, current: Snapshot): ChangeEvent {
  return { id, type: 'company.updated',
    subject: { id: SUBJECT_ID, version, corporate_number: COMPANY_NUMBER },
    data: { current } };
}

export class HistoryGap extends Error {
  readonly code = 'CHANGE_EVENT_HISTORY_GAP';
  constructor() { super('410 CHANGE_EVENT_HISTORY_GAP (offline fixture)'); }
}

export class MockBango {
  readonly trace: string[] = [];
  readonly input = [
    { id: 'partner-1', name: '㈱あおぞら商事' },
    { id: 'partner-2', name: 'あおぞら商事' },
    { id: 'partner-3', name: '株式会社見つからない' },
  ];
  private gap = false;
  private checkpointCount = 0;

  batchMatch() {
    this.trace.push('batch.match');
    return { data: { job_id: 'job_demo', status: 'queued' } };
  }
  batchStatus() {
    this.trace.push('batch.status');
    return { data: { status: 'completed' } };
  }
  batchDownload(): { data: BatchRow[] } {
    this.trace.push('batch.download');
    return { data: [
      { row_index: 1, confidence: 'confident', matched_corporate_number: COMPANY_NUMBER },
      { row_index: 2, confidence: 'review', matched_corporate_number: null },
      { row_index: 3, confidence: 'unmatched', matched_corporate_number: null },
    ] };
  }
  lookup() { this.trace.push('companies.lookup'); return { data: company }; }
  invoiceValid() { this.trace.push('invoice.valid'); return { data: { valid: true, date: '2026-10-15' } }; }
  startNow() {
    this.trace.push('incremental.start=now');
    return { next_cursor: this.checkpointCount++ === 0 ? 'mock:0' : 'mock:3' };
  }
  watch(identifier: string): { subject: Subject; current: Snapshot } {
    if (identifier !== COMPANY_NUMBER) throw new Error('unknown fixture number');
    this.trace.push('watch.put');
    return { subject: { id: SUBJECT_ID, version: '1', corporate_number: COMPANY_NUMBER }, current: BASELINE };
  }
  enableGap() { this.gap = true; }
  listWatches() { this.trace.push('watch.list'); return [COMPANY_NUMBER]; }
  freshBaseline(): { subject: Subject; current: Snapshot } {
    this.trace.push('watch.freshBaseline');
    return { subject: { id: SUBJECT_ID, version: '4', corporate_number: COMPANY_NUMBER }, current: LATEST };
  }
  pull(cursor: string): PullPage {
    this.trace.push(`incremental.pull:${cursor}`);
    if (this.gap && cursor === 'mock:1') throw new HistoryGap();
    if (cursor === 'mock:0') return {
      mode: 'incremental', data: [changeEvent('evt_demo_v2', '2', CHANGED)], next_cursor: 'mock:1',
    };
    if (cursor === 'mock:3') return { mode: 'incremental', data: [], next_cursor: 'mock:4' };
    return { mode: 'incremental', data: [], next_cursor: cursor };
  }
}
