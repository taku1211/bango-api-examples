const API_BASE = 'https://api.bango-api.jp/v1/';
const DEFAULT_MAX_POLLS = 10;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

type BatchConfidence = 'confident' | 'review' | 'unmatched';

type JsonObject = Record<string, unknown>;
type FetchLike = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

type BatchResultRow = {
  row_index: number;
  input_name: string;
  confidence: BatchConfidence;
  matched_corporate_number: string | null;
  candidate_count: number;
};

type LivePartnerResult = {
  inputName: string;
  confidence: BatchConfidence;
  candidateCount: number;
  linkedCorporateNumber: string | null;
  company: JsonObject | null;
  invoiceValidity: JsonObject | null;
};

type LiveReadResult = {
  mode: 'live-read';
  simulation: false;
  asOfDate: string;
  checkpointAcquired: true;
  callsMade: number;
  partners: LivePartnerResult[];
};

type LiveBangoOptions = {
  fetch?: FetchLike;
  maxPolls?: number;
  pollIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

type SafeProblem = {
  status: number;
  code: string;
  retryAfterSeconds: number | null;
};

export class BangoApiError extends Error {
  readonly problem: SafeProblem;

  constructor(problem: SafeProblem) {
    const retry = problem.retryAfterSeconds === null ? '' : `; retry_after=${problem.retryAfterSeconds}s`;
    super(`BANGO API returned HTTP ${problem.status} (${problem.code})${retry}`);
    this.name = 'BangoApiError';
    this.problem = problem;
  }
}

export class BangoTransportError extends Error {
  constructor() {
    super('BANGO API request failed before a response was received. No automatic retry was made.');
    this.name = 'BangoTransportError';
  }
}

export class BangoProtocolError extends Error {
  constructor(message = 'BANGO API response did not match the documented contract.') {
    super(message);
    this.name = 'BangoProtocolError';
  }
}

export class BangoJobFailedError extends Error {
  readonly code: string;
  readonly retryAfterSeconds: number | null;

  constructor(code: string, retryAfterSeconds: number | null) {
    const retry = retryAfterSeconds === null ? '' : `; retry_after=${retryAfterSeconds}s`;
    super(`BANGO batch job failed (${code})${retry}. It was not resubmitted.`);
    this.name = 'BangoJobFailedError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class BangoJobTimeoutError extends Error {
  constructor(maxPolls: number) {
    super(`BANGO batch job did not finish within ${maxPolls} status checks. It may still be running; it was not resubmitted.`);
    this.name = 'BangoJobTimeoutError';
  }
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeCode(value: unknown): string {
  return typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value) ? value : 'UNKNOWN_ERROR';
}

function safeRetryAfter(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function envelopeData(value: unknown): JsonObject {
  if (!isObject(value) || !isObject(value.data)) throw new BangoProtocolError();
  return value.data;
}

export function validateCompanyNames(names: string[]): string[] {
  if (!Array.isArray(names) || names.length < 1 || names.length > 3) {
    throw new Error('Provide 1 to 3 explicitly selected public company names.');
  }
  const trimmed = names.map(name => typeof name === 'string' ? name.trim() : '');
  if (trimmed.some(name => name.length < 1 || name.length > 200)) {
    throw new Error('Each company name must contain 1 to 200 non-blank characters.');
  }
  return trimmed;
}

export function validateAsOfDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Date must use YYYY-MM-DD.');
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error('Date must be a valid calendar date in YYYY-MM-DD format.');
  }
  return date;
}

function validateOptions(options: LiveBangoOptions): Required<Pick<LiveBangoOptions, 'maxPolls' | 'pollIntervalMs'>> {
  const maxPolls = options.maxPolls ?? DEFAULT_MAX_POLLS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isInteger(maxPolls) || maxPolls < 1 || maxPolls > DEFAULT_MAX_POLLS ||
      !Number.isInteger(pollIntervalMs) || pollIntervalMs < 0) {
    throw new Error('Invalid live adapter polling limits.');
  }
  return { maxPolls, pollIntervalMs };
}

export class LiveBango {
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxPolls: number;
  private readonly pollIntervalMs: number;
  private readonly requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private mutableCallsMade = 0;

  constructor(apiKey: string, options: LiveBangoOptions = {}) {
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0) throw new Error('BANGO_API_KEY is required.');
    const limits = validateOptions(options);
    this.apiKey = apiKey;
    this.fetchImpl = options.fetch ?? fetch;
    this.maxPolls = limits.maxPolls;
    this.pollIntervalMs = limits.pollIntervalMs;
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  }

  get callsMade(): number {
    return this.mutableCallsMade;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const url = new URL(path, API_BASE);
    if (url.origin !== new URL(API_BASE).origin || !url.pathname.startsWith('/v1/')) {
      throw new BangoProtocolError('Live adapter refused a request outside the fixed BANGO API origin.');
    }
    let response: Response;
    try {
      this.mutableCallsMade += 1;
      response = await this.fetchImpl(url, {
        ...init,
        headers: {
          accept: 'application/json, application/problem+json',
          'x-api-key': this.apiKey,
          ...(init.headers ?? {}),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch {
      throw new BangoTransportError();
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (response.ok) throw new BangoProtocolError();
      payload = null;
    }
    if (!response.ok) {
      const problem = isObject(payload) ? payload : {};
      const headerRetry = response.headers.get('retry-after');
      const parsedHeaderRetry = headerRetry !== null && /^\d+$/.test(headerRetry) ? Number(headerRetry) : null;
      throw new BangoApiError({
        status: response.status,
        code: safeCode(problem.code),
        retryAfterSeconds: safeRetryAfter(problem.retry_after) ?? parsedHeaderRetry,
      });
    }
    return payload;
  }

  private async match(names: string[]): Promise<BatchResultRow[]> {
    // This POST creates a remote job and consumes batch-row quota. Callers must opt in explicitly.
    const accepted = envelopeData(await this.request('batch/match', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ companies: names }),
    }));
    if (accepted.status !== 'queued' || typeof accepted.job_id !== 'string' || accepted.job_id.length === 0) {
      throw new BangoProtocolError();
    }
    const jobId = accepted.job_id;
    let completed = false;
    for (let poll = 0; poll < this.maxPolls; poll += 1) {
      if (poll > 0) await this.sleep(this.pollIntervalMs);
      const statusEnvelope = await this.request(`batch/${encodeURIComponent(jobId)}`);
      const status = envelopeData(statusEnvelope);
      if (status.job_id !== jobId) throw new BangoProtocolError();
      if (status.status === 'completed') {
        completed = true;
        break;
      }
      if (status.status === 'failed') {
        const jobError = isObject(status.error) ? status.error : {};
        throw new BangoJobFailedError(safeCode(jobError.code), safeRetryAfter(jobError.retry_after));
      }
      if (status.status !== 'queued' && status.status !== 'processing') throw new BangoProtocolError();
    }
    if (!completed) throw new BangoJobTimeoutError(this.maxPolls);

    // A 3-row input fits in the single JSON download supported by this example.
    // row_index is 1-based in the published examples and matcher implementation.
    const download = await this.request(`batch/${encodeURIComponent(jobId)}/download?format=json`);
    if (!isObject(download) || !Array.isArray(download.data) || download.has_more !== false) throw new BangoProtocolError();
    const rows = download.data.map((value, index): BatchResultRow => {
      if (!isObject(value) || value.row_index !== index + 1 || typeof value.input_name !== 'string' ||
          !['confident', 'review', 'unmatched'].includes(String(value.confidence)) ||
          !(value.matched_corporate_number === null || (typeof value.matched_corporate_number === 'string' && /^\d{13}$/.test(value.matched_corporate_number))) ||
          typeof value.candidate_count !== 'number' || !Number.isSafeInteger(value.candidate_count) || value.candidate_count < 0) {
        throw new BangoProtocolError();
      }
      return {
        row_index: value.row_index as number,
        input_name: value.input_name,
        confidence: value.confidence as BatchConfidence,
        matched_corporate_number: value.matched_corporate_number as string | null,
        candidate_count: value.candidate_count,
      };
    });
    if (rows.length !== names.length) throw new BangoProtocolError();
    return rows;
  }

  private async acquireCheckpoint(): Promise<void> {
    const page = await this.request('change-events?mode=incremental&start=now');
    if (!isObject(page) || page.mode !== 'incremental' || page.continuity_guaranteed !== true ||
        !Array.isArray(page.data) || page.data.length !== 0 || page.has_more !== false ||
        typeof page.next_cursor !== 'string' || page.next_cursor.length === 0) {
      throw new BangoProtocolError('BANGO API did not return an empty incremental start=now checkpoint.');
    }
  }

  async run(namesInput: string[], asOfDateInput: string): Promise<LiveReadResult> {
    const names = validateCompanyNames(namesInput);
    const asOfDate = validateAsOfDate(asOfDateInput);
    const rows = await this.match(names);
    const partners: LivePartnerResult[] = [];

    for (const row of rows) {
      // Only a confident result is eligible for lookup. Review candidates remain unlinked.
      const corporateNumber = row.confidence === 'confident' ? row.matched_corporate_number : null;
      if (row.confidence === 'confident' && corporateNumber === null) throw new BangoProtocolError();
      if (corporateNumber === null) {
        partners.push({
          inputName: row.input_name,
          confidence: row.confidence,
          candidateCount: row.candidate_count,
          linkedCorporateNumber: null,
          company: null,
          invoiceValidity: null,
        });
        continue;
      }

      const companyEnvelope = await this.request(`companies/${encodeURIComponent(corporateNumber)}`);
      const company = envelopeData(companyEnvelope);
      if (company.corporate_number !== corporateNumber || !Object.hasOwn(company, 'invoice') ||
          !(company.invoice === null || isObject(company.invoice))) throw new BangoProtocolError();
      const invoiceBlock = isObject(company.invoice) ? company.invoice : null;
      const registrationNumber = invoiceBlock?.registration_number;
      if (invoiceBlock && !(registrationNumber === null || (typeof registrationNumber === 'string' && /^T\d{13}$/.test(registrationNumber)))) {
        throw new BangoProtocolError();
      }
      let invoiceValidity: JsonObject | null = null;
      if (typeof registrationNumber === 'string' && /^T\d{13}$/.test(registrationNumber)) {
        const query = new URLSearchParams({ date: asOfDate });
        invoiceValidity = envelopeData(await this.request(`invoice/${encodeURIComponent(registrationNumber)}/valid?${query.toString()}`));
        if (invoiceValidity.registration_number !== registrationNumber || invoiceValidity.date !== asOfDate || typeof invoiceValidity.valid !== 'boolean') {
          throw new BangoProtocolError();
        }
      }
      partners.push({
        inputName: row.input_name,
        confidence: row.confidence,
        candidateCount: row.candidate_count,
        linkedCorporateNumber: corporateNumber,
        company,
        invoiceValidity,
      });
    }

    await this.acquireCheckpoint();
    return { mode: 'live-read', simulation: false, asOfDate, checkpointAcquired: true, callsMade: this.callsMade, partners };
  }
}
