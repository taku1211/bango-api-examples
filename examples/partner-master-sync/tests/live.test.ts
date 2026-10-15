import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const contract = JSON.parse(readFileSync(new URL('./fixtures/live-contract.json', import.meta.url), 'utf8')) as {
  responses: Record<string, Record<string, any>>;
};

function fixture(name: string) {
  return structuredClone(contract.responses[name]);
}

function jsonResponse(payload: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function acceptedJob(jobId: string) {
  const response = fixture('batchAccepted');
  response.data.job_id = jobId;
  response.links.status = `https://api.bango-api.jp/v1/batch/${jobId}`;
  return response;
}

function jobStatus(jobId: string, status: 'queued' | 'processing' | 'completed' | 'failed') {
  const response = fixture('batchStatusCompleted');
  response.data.job_id = jobId;
  response.data.status = status;
  response.data.progress = { done: status === 'completed' ? 3 : 0, total: 3 };
  response.data.summary = status === 'completed' ? { confident: 1, review: 1, unmatched: 1 } : null;
  response.data.error = null;
  response.links.self = `https://api.bango-api.jp/v1/batch/${jobId}`;
  response.links.download = `${response.links.self}/download`;
  return response;
}

function batchDownload(jobId: string, count = 3, names?: string[]) {
  const response = fixture('batchDownload');
  response.data = response.data.slice(0, count);
  response.data.forEach((row: Record<string, unknown>, index: number) => {
    row.row_index = index + 1;
    if (names?.[index] !== undefined) row.input_name = names[index];
  });
  response.limit = 100;
  response.links.self = `https://api.bango-api.jp/v1/batch/${jobId}/download`;
  return response;
}

function reviewDownload(jobId: string) {
  const response = batchDownload(jobId, 1, ['架空商事']);
  response.data[0].confidence = 'review';
  response.data[0].matched_corporate_number = null;
  return response;
}

async function assertMalformedDownloadRejected(names: string[], download: unknown) {
  const paths: string[] = [];
  const fetch = async (input: URL | RequestInfo) => {
    const url = input instanceof URL ? input : new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === '/v1/batch/match') return jsonResponse(acceptedJob('job-malformed'), 202);
    if (url.pathname === '/v1/batch/job-malformed') return jsonResponse(jobStatus('job-malformed', 'completed'));
    if (url.pathname === '/v1/batch/job-malformed/download') return jsonResponse(download);
    throw new Error(`unexpected URL ${url.pathname}`);
  };
  const api = new LiveBango(API_KEY, { fetch, sleep: async () => {} });

  await assert.rejects(api.run(names, '2024-10-01'), BangoProtocolError);
  assert.deepEqual(paths, [
    '/v1/batch/match',
    '/v1/batch/job-malformed',
    '/v1/batch/job-malformed/download',
  ]);
}

test('live contract posts once, polls the job, downloads 1-based rows, and only looks up confident matches', async () => {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const statuses = ['queued', 'processing', 'completed'];
  const fetch = async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const url = input instanceof URL ? input : new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === '/v1/batch/match') {
      return jsonResponse(acceptedJob('job-test'), 202);
    }
    if (url.pathname === '/v1/batch/job-test') {
      const status = statuses.shift();
      if (status === undefined) throw new Error('unexpected extra poll');
      return jsonResponse(jobStatus('job-test', status as 'queued' | 'processing' | 'completed'));
    }
    if (url.pathname === '/v1/batch/job-test/download') return jsonResponse(batchDownload('job-test'));
    if (url.pathname === `/v1/companies/${COMPANY_NUMBER}`) return jsonResponse(fixture('company'));
    if (url.pathname === `/v1/invoice/${REGISTRATION_NUMBER}/valid`) return jsonResponse(fixture('invoiceValidity'));
    if (url.pathname === '/v1/change-events') return jsonResponse(fixture('incrementalStartNow'));
    throw new Error(`unexpected URL ${url.pathname}`);
  };

  const api = new LiveBango(API_KEY, { fetch, sleep: async () => {} });
  const result = await api.run([' 株式会社架空商事 ', '架空商事 別支店', '未一致の架空法人'], '2024-10-01');

  assert.equal(result.callsMade, 8);
  assert.equal(result.simulation, false);
  assert.equal(result.checkpointAcquired, true);
  assert.equal(api.callsMade, 8);
  assert.equal(Object.hasOwn(result, 'next_cursor'), false);
  assert.deepEqual(result.partners.map(partner => partner.confidence), ['confident', 'review', 'unmatched']);
  assert.deepEqual(result.partners.map(partner => partner.inputName), [
    '株式会社架空商事', '架空商事 別支店', '未一致の架空法人',
  ]);
  assert.equal(result.partners[0].linkedCorporateNumber, COMPANY_NUMBER);
  assert.equal(result.partners[0].invoiceValidity?.date, '2024-10-01');
  assert.equal(result.partners[1].linkedCorporateNumber, null);
  assert.equal(result.partners[1].company, null);
  assert.equal(result.partners[2].linkedCorporateNumber, null);
  assert.equal(calls.filter(call => call.init.method === 'POST').length, 1);
  assert.equal(calls.filter(call => call.url.pathname.startsWith('/v1/companies/')).length, 1);
  assert.equal(calls.filter(call => call.url.pathname.startsWith('/v1/invoice/')).length, 1);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    companies: ['株式会社架空商事', '架空商事 別支店', '未一致の架空法人'],
  });
  assert.equal(calls[4].url.searchParams.get('format'), 'json');
  assert.equal(calls[4].url.searchParams.has('offset'), false);
  assert.equal(calls[4].url.searchParams.has('limit'), false);
  assert.equal(calls[6].url.searchParams.get('date'), '2024-10-01');
  assert.equal(calls[7].url.pathname, '/v1/change-events');
  assert.equal(calls[7].url.searchParams.get('mode'), 'incremental');
  assert.equal(calls[7].url.searchParams.get('start'), 'now');
  for (const call of calls) {
    assert.equal(call.url.origin, 'https://api.bango-api.jp');
    assert.equal((call.init.headers as Record<string, string>)['x-api-key'], API_KEY);
    assert.equal(call.init.redirect, 'error');
  }
});

test('history response cannot be used as an incremental checkpoint', async () => {
  const fetch = async (input: URL | RequestInfo) => {
    const url = input instanceof URL ? input : new URL(String(input));
    if (url.pathname === '/v1/batch/match') return jsonResponse(acceptedJob('job-history'), 202);
    if (url.pathname === '/v1/batch/job-history') return jsonResponse(jobStatus('job-history', 'completed'));
    if (url.pathname === '/v1/batch/job-history/download') return jsonResponse(reviewDownload('job-history'));
    const historyPage = fixture('incrementalStartNow');
    historyPage.mode = 'history';
    historyPage.continuity_guaranteed = false;
    return jsonResponse(historyPage);
  };
  const api = new LiveBango(API_KEY, { fetch, sleep: async () => {} });

  await assert.rejects(api.run(['架空商事'], '2024-10-01'), BangoProtocolError);
  assert.equal(api.callsMade, 4);
});

test('incremental checkpoint Problem statuses are surfaced safely without retry', async () => {
  for (const status of [410, 401, 403, 429, 503]) {
    const problem = fixture('changeEventProblems')[String(status)];
    let posts = 0;
    let checkpointCalls = 0;
    const fetch = async (input: URL | RequestInfo) => {
      const url = input instanceof URL ? input : new URL(String(input));
      if (url.pathname === '/v1/batch/match') {
        posts += 1;
        return jsonResponse(acceptedJob('job-problem'), 202);
      }
      if (url.pathname === '/v1/batch/job-problem') return jsonResponse(jobStatus('job-problem', 'completed'));
      if (url.pathname === '/v1/batch/job-problem/download') return jsonResponse(reviewDownload('job-problem'));
      checkpointCalls += 1;
      return jsonResponse(problem, status);
    };
    const api = new LiveBango(API_KEY, { fetch, sleep: async () => {} });

    await assert.rejects(api.run(['架空商事'], '2024-10-01'), error => {
      assert.ok(error instanceof BangoApiError);
      assert.deepEqual(error.problem, {
        status,
        code: problem.code,
        retryAfterSeconds: problem.retry_after,
      });
      return true;
    });
    assert.equal(posts, 1);
    assert.equal(checkpointCalls, 1);
    assert.equal(api.callsMade, 4);
  }
});

test('bounded polling times out without resubmitting the quota-consuming POST', async () => {
  const requests: string[] = [];
  const fetch = async (input: URL | RequestInfo) => {
    const url = input instanceof URL ? input : new URL(String(input));
    requests.push(url.pathname);
    if (url.pathname === '/v1/batch/match') return jsonResponse(acceptedJob('job-pending'), 202);
    return jsonResponse(jobStatus('job-pending', 'processing'));
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
      return jsonResponse(acceptedJob('job-failed'), 202);
    }
    const failed = jobStatus('job-failed', 'failed');
    failed.data.error = { code: 'SOURCE_UNAVAILABLE', message: API_KEY, retryable: false, retry_after: 12 };
    return jsonResponse(failed);
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

test('reordered result rows fail closed before company, invoice, or checkpoint reads', async () => {
  const download = batchDownload('job-malformed');
  download.data.reverse();

  await assertMalformedDownloadRejected([
    '株式会社架空商事', '架空商事 別支店', '未一致の架空法人',
  ], download);
});

test('zero-based row indices fail closed', async () => {
  const download = batchDownload('job-malformed', 1, ['架空商事']);
  download.data[0].row_index = 0;

  await assertMalformedDownloadRejected(['架空商事'], download);
});

test('correct row indices with swapped input names fail closed', async () => {
  const names = ['株式会社架空商事', '架空商事 別支店', '未一致の架空法人'];
  const download = batchDownload('job-malformed', 3, names);
  [download.data[0].input_name, download.data[1].input_name] = [
    download.data[1].input_name,
    download.data[0].input_name,
  ];

  await assertMalformedDownloadRejected(names, download);
});

test('a mismatched input name fails closed', async () => {
  const download = batchDownload('job-malformed', 1, ['別の架空法人']);

  await assertMalformedDownloadRejected(['架空商事'], download);
});

test('duplicate row indices fail closed even when input names are duplicated', async () => {
  const names = ['架空商事', '架空商事'];
  const download = batchDownload('job-malformed', 2, names);
  download.data[1].row_index = 1;

  await assertMalformedDownloadRejected(names, download);
});

test('a repeated download row fails closed', async () => {
  const names = ['架空商事', '架空商事'];
  const download = batchDownload('job-malformed', 1, names);
  download.data.push(structuredClone(download.data[0]));

  await assertMalformedDownloadRejected(names, download);
});

test('missing download rows fail closed', async () => {
  const names = ['株式会社架空商事', '架空商事 別支店'];
  const download = batchDownload('job-malformed', 1, names);

  await assertMalformedDownloadRejected(names, download);
});

test('extra download rows fail closed', async () => {
  const names = ['株式会社架空商事', '架空商事 別支店'];
  const download = batchDownload('job-malformed', 3, [
    ...names, '余分な架空法人',
  ]);

  await assertMalformedDownloadRejected(names, download);
});

test('duplicate trimmed input names with internal spelling and spacing are preserved', async () => {
  const selectedName = '株式会社 髙﨑商事　 支店';
  const names = [` ${selectedName} `, ` ${selectedName} `];
  const download = batchDownload('job-duplicates', 2, [selectedName, selectedName]);
  download.data.forEach((row: Record<string, unknown>) => {
    row.confidence = 'unmatched';
    row.matched_corporate_number = null;
  });
  const paths: string[] = [];
  let postedCompanies: unknown;
  const fetch = async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const url = input instanceof URL ? input : new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === '/v1/batch/match') {
      postedCompanies = JSON.parse(String(init.body)).companies;
      return jsonResponse(acceptedJob('job-duplicates'), 202);
    }
    if (url.pathname === '/v1/batch/job-duplicates') {
      return jsonResponse(jobStatus('job-duplicates', 'completed'));
    }
    if (url.pathname === '/v1/batch/job-duplicates/download') return jsonResponse(download);
    if (url.pathname === '/v1/change-events') return jsonResponse(fixture('incrementalStartNow'));
    throw new Error(`unexpected URL ${url.pathname}`);
  };
  const api = new LiveBango(API_KEY, { fetch, sleep: async () => {} });

  const result = await api.run(names, '2024-10-01');

  assert.deepEqual(postedCompanies, [selectedName, selectedName]);
  assert.deepEqual(result.partners.map(partner => partner.inputName), [selectedName, selectedName]);
  assert.deepEqual(paths, [
    '/v1/batch/match',
    '/v1/batch/job-duplicates',
    '/v1/batch/job-duplicates/download',
    '/v1/change-events',
  ]);
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
