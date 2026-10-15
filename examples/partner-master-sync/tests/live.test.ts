import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BangoApiError,
  BangoJobFailedError,
  BangoJobTimeoutError,
  BangoProtocolError,
  LiveBango,
  validateAsOfDate,
  validateCompanyNames,
} from '../src/live.ts';
import { parseLiveCliArgs, runLiveCli } from '../src/live-cli.ts';

const API_KEY = 'test-only-not-a-real-api-key';
const COMPANY_NUMBER = '1234567890123';
const REGISTRATION_NUMBER = `T${COMPANY_NUMBER}`;

function jsonResponse(payload: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function envelope(data: unknown) {
  return { object: 'example', schema_version: '2026-08', data };
}

function row(rowIndex: number, confidence: string, corporateNumber: string | null, candidateCount = 0) {
  return {
    object: 'batch_result_row',
    row_index: rowIndex,
    input_name: ['架空商事', '架空商事 別支店', '未一致の架空法人'][rowIndex - 1],
    prefecture_code: null,
    confidence,
    score: confidence === 'confident' ? 0.99 : 0.3,
    candidate_count: candidateCount,
    matched_corporate_number: corporateNumber,
    candidates: [],
  };
}

function completedBatchRows() {
  return {
    object: 'list',
    item: 'batch_result_row',
    schema_version: '2026-08',
    data: [
      row(1, 'confident', COMPANY_NUMBER, 1),
      row(2, 'review', null, 2),
      row(3, 'unmatched', null, 0),
    ],
    has_more: false,
    offset: 0,
    limit: 100,
    links: { self: 'https://api.bango-api.jp/v1/batch/job-test/download', docs: 'https://bango-api.jp/docs' },
    meta: {},
  };
}

function syntheticCompany() {
  return envelope({
    corporate_number: COMPANY_NUMBER,
    name: '株式会社架空商事',
    invoice: {
      found: true,
      registration_number: REGISTRATION_NUMBER,
      registered: true,
      registration_date: '2023-10-01',
      cancel_date: null,
      expire_date: null,
      valid: true,
      country: 'domestic',
    },
  });
}

test('live contract posts once, polls the job, downloads 1-based rows, and only looks up confident matches', async () => {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const statuses = ['queued', 'processing', 'completed'];
  const fetch = async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const url = input instanceof URL ? input : new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === '/v1/batch/match') {
      return jsonResponse(envelope({ job_id: 'job-test', status: 'queued' }), 202);
    }
    if (url.pathname === '/v1/batch/job-test') {
      const status = statuses.shift();
      if (status === undefined) throw new Error('unexpected extra poll');
      return jsonResponse(envelope({
        job_id: 'job-test', status,
        progress: { done: status === 'completed' ? 3 : 0, total: 3 },
        summary: status === 'completed' ? { confident: 1, review: 1, unmatched: 1 } : null,
        error: null,
      }));
    }
    if (url.pathname === '/v1/batch/job-test/download') return jsonResponse(completedBatchRows());
    if (url.pathname === `/v1/companies/${COMPANY_NUMBER}`) return jsonResponse(syntheticCompany());
    if (url.pathname === `/v1/invoice/${REGISTRATION_NUMBER}/valid`) {
      return jsonResponse(envelope({
        registration_number: REGISTRATION_NUMBER,
        date: '2024-10-01',
        valid: true,
        registration_date: '2023-10-01',
        cancel_date: null,
        expire_date: null,
      }));
    }
    throw new Error(`unexpected URL ${url.pathname}`);
  };

  const api = new LiveBango(API_KEY, { fetch, sleep: async () => {} });
  const result = await api.run([' 架空商事 ', '架空商事 別支店', '未一致の架空法人'], '2024-10-01');

  assert.equal(result.callsMade, 7);
  assert.equal(result.simulation, false);
  assert.equal(api.callsMade, 7);
  assert.deepEqual(result.partners.map(partner => partner.confidence), ['confident', 'review', 'unmatched']);
  assert.equal(result.partners[0].linkedCorporateNumber, COMPANY_NUMBER);
  assert.equal(result.partners[0].invoiceValidity?.date, '2024-10-01');
  assert.equal(result.partners[1].linkedCorporateNumber, null);
  assert.equal(result.partners[1].company, null);
  assert.equal(result.partners[2].linkedCorporateNumber, null);
  assert.equal(calls.filter(call => call.init.method === 'POST').length, 1);
  assert.equal(calls.filter(call => call.url.pathname.startsWith('/v1/companies/')).length, 1);
  assert.equal(calls.filter(call => call.url.pathname.startsWith('/v1/invoice/')).length, 1);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    companies: ['架空商事', '架空商事 別支店', '未一致の架空法人'],
  });
  assert.equal(calls[4].url.searchParams.get('format'), 'json');
  assert.equal(calls[4].url.searchParams.get('offset'), '0');
  assert.equal(calls[4].url.searchParams.get('limit'), '100');
  assert.equal(calls[6].url.searchParams.get('date'), '2024-10-01');
  for (const call of calls) {
    assert.equal(call.url.origin, 'https://api.bango-api.jp');
    assert.equal((call.init.headers as Record<string, string>)['x-api-key'], API_KEY);
    assert.equal(call.init.redirect, 'error');
  }
});

test('bounded polling times out without resubmitting the quota-consuming POST', async () => {
  const requests: string[] = [];
  const fetch = async (input: URL | RequestInfo) => {
    const url = input instanceof URL ? input : new URL(String(input));
    requests.push(url.pathname);
    if (url.pathname === '/v1/batch/match') return jsonResponse(envelope({ job_id: 'job-pending', status: 'queued' }), 202);
    return jsonResponse(envelope({
      job_id: 'job-pending', status: 'processing', progress: { done: 0, total: 1 }, summary: null, error: null,
    }));
  };
  const api = new LiveBango(API_KEY, { fetch, maxPolls: 2, pollIntervalMs: 0, sleep: async () => {} });

  await assert.rejects(api.run(['架空商事'], '2024-10-01'), BangoJobTimeoutError);
  assert.equal(requests.filter(path => path === '/v1/batch/match').length, 1);
  assert.deepEqual(requests, ['/v1/batch/match', '/v1/batch/job-pending', '/v1/batch/job-pending']);
  assert.equal(api.callsMade, 3);
});

test('failed jobs expose only safe error fields and are never resubmitted', async () => {
  let posts = 0;
  const fetch = async (input: URL | RequestInfo) => {
    const url = input instanceof URL ? input : new URL(String(input));
    if (url.pathname === '/v1/batch/match') {
      posts += 1;
      return jsonResponse(envelope({ job_id: 'job-failed', status: 'queued' }), 202);
    }
    return jsonResponse(envelope({
      job_id: 'job-failed', status: 'failed', progress: { done: 1, total: 1 }, summary: null,
      error: { code: 'SOURCE_UNAVAILABLE', message: API_KEY, retryable: false, retry_after: 12 },
    }));
  };
  const api = new LiveBango(API_KEY, { fetch, sleep: async () => {} });

  await assert.rejects(api.run(['架空商事'], '2024-10-01'), error => {
    assert.ok(error instanceof BangoJobFailedError);
    assert.equal(error.code, 'SOURCE_UNAVAILABLE');
    assert.equal(error.retryAfterSeconds, 12);
    assert.ok(!error.message.includes(API_KEY));
    assert.ok(!error.message.includes('job-failed'));
    return true;
  });
  assert.equal(posts, 1);
  assert.equal(api.callsMade, 2);
});

test('RFC 9457 throttling errors expose status, sanitized code, and retry_after only', async () => {
  const fetch = async () => jsonResponse({
    status: 429,
    code: 'RATE_LIMIT_EXCEEDED',
    title: API_KEY,
    detail: `Do not print ${API_KEY}`,
    retry_after: 23,
  }, 429, { 'retry-after': '23' });
  const api = new LiveBango(API_KEY, { fetch });

  await assert.rejects(api.run(['架空商事'], '2024-10-01'), error => {
    assert.ok(error instanceof BangoApiError);
    assert.deepEqual(error.problem, { status: 429, code: 'RATE_LIMIT_EXCEEDED', retryAfterSeconds: 23 });
    assert.ok(!error.message.includes(API_KEY));
    return true;
  });
  assert.equal(api.callsMade, 1);
});

test('a download row with zero-based or misordered row_index fails closed before company lookup', async () => {
  const paths: string[] = [];
  const fetch = async (input: URL | RequestInfo) => {
    const url = input instanceof URL ? input : new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === '/v1/batch/match') return jsonResponse(envelope({ job_id: 'job-test', status: 'queued' }), 202);
    if (url.pathname === '/v1/batch/job-test') {
      return jsonResponse(envelope({
        job_id: 'job-test', status: 'completed', progress: { done: 1, total: 1 },
        summary: { confident: 1, review: 0, unmatched: 0 }, error: null,
      }));
    }
    return jsonResponse({ ...completedBatchRows(), data: [row(0, 'confident', COMPANY_NUMBER, 1)] });
  };
  const api = new LiveBango(API_KEY, { fetch, sleep: async () => {} });

  await assert.rejects(api.run(['架空商事'], '2024-10-01'), BangoProtocolError);
  assert.equal(paths.includes(`/v1/companies/${COMPANY_NUMBER}`), false);
  assert.equal(api.callsMade, 3);
});

test('CLI accepts positional company names plus a transaction date', () => {
  assert.deepEqual(parseLiveCliArgs([
    '--confirm', '--date', '2024-10-01', '架空商事', '別の架空法人',
  ]), {
    companies: ['架空商事', '別の架空法人'], date: '2024-10-01', confirm: true, help: false,
  });
  assert.deepEqual(parseLiveCliArgs(['架空商事', '--date', '2024-10-01']), {
    companies: ['架空商事'], date: '2024-10-01', confirm: false, help: false,
  });
  assert.throws(() => parseLiveCliArgs(['--date', '2024-02-30', '架空商事']), /valid calendar date/);
});

test('live CLI refuses the remote job before making a request unless --confirm is present', async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  let fetchCalls = 0;
  let stderr = '';
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('network must not be touched');
  }) as typeof fetch;
  console.error = (...values: unknown[]) => { stderr += values.join(' '); };
  try {
    const exitCode = await runLiveCli(['--date', '2024-10-01', '架空商事'], { BANGO_API_KEY: API_KEY });
    assert.equal(exitCode, 2);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
  assert.equal(fetchCalls, 0);
  assert.ok(stderr.includes('ConfirmationRequired'));
  assert.ok(!stderr.includes(API_KEY));
});

test('live CLI reports a blank API key without throwing or making a request', async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  let fetchCalls = 0;
  let stderr = '';
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('network must not be touched');
  }) as typeof fetch;
  console.error = (...values: unknown[]) => { stderr += values.join(' '); };
  try {
    const exitCode = await runLiveCli([
      '--confirm', '--date', '2024-10-01', '架空商事',
    ], { BANGO_API_KEY: '   ' });
    assert.equal(exitCode, 1);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
  assert.equal(fetchCalls, 0);
  assert.ok(stderr.includes('BANGO_API_KEY is required'));
});

test('public-name count and invoice date validators reject invalid inputs', () => {
  assert.deepEqual(validateCompanyNames(['  架空商事  ']), ['架空商事']);
  assert.throws(() => validateCompanyNames([]), /1 to 3/);
  assert.throws(() => validateCompanyNames(['a', 'b', 'c', 'd']), /1 to 3/);
  assert.equal(validateAsOfDate('2024-02-29'), '2024-02-29');
  assert.throws(() => validateAsOfDate('2024-02-30'), /valid calendar date/);
});
