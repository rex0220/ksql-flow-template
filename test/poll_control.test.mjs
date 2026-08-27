import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  PollControlError,
  RESULTS,
  RERUN_STATES,
  batchQuery,
  candidateQuery,
  classifyRecord,
  createApiClient,
  exitResult,
  pollOnce,
  spawnRunner,
  validateConfig,
  validateFieldContract,
} from '../scripts/poll_control.mjs';

process.env.TEST_KSQL_TOKEN = 'test-token-never-log';

function config(overrides = {}) {
  return validateConfig({
    baseUrl: 'https://example.cybozu.com', guestSpaceId: null, logAppId: 4249,
    tokenEnv: 'TEST_KSQL_TOKEN', profile: 'prod', host: 'vps-batch-01',
    command: path.resolve('run_batch.sh'), args: ['--resume'], cwd: path.resolve('.'),
    requestTtlSec: 21600, pollGapSec: 300, batchTimeoutSec: 3600, claimGraceSec: 600,
    maxCheckedRequests: 3, overflowCancellationLimit: 3, staleRecoveryLimit: 3,
    candidateLimit: 20, httpTimeoutMs: 1000, responseMaxBytes: 65536,
    httpRetryLimit: 2, httpRetryMaxElapsedMs: 1000,
    ...overrides,
  });
}

function f(value) { return { value }; }

function record(overrides = {}) {
  const raw = {
    '$id': '10', '$revision': '1', 更新日時: '2026-08-27T00:00:00.000Z',
    更新者: { code: 'operator-1', name: 'Operator' }, record_type: 'BATCH',
    status: 'FAILED', batch_id: 'old-batch', profile: 'prod', host: 'vps-batch-01',
    started_at: '2026-08-26T23:00:00.000Z', rerun_request: ['REQUEST'], rerun_state: '',
    rerun_requested_at: '', rerun_requested_by: '', rerun_claimed_host: '',
    rerun_claim_expires_at: '', rerun_attempt: '0', rerun_exit_code: '',
    rerun_result: '', rerun_batch_id: '',
    ...overrides,
  };
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, f(value)]));
}

function fields() {
  const properties = {
    rerun_request: { type: 'CHECK_BOX', required: false, options: { REQUEST: { label: 'REQUEST', index: '0' } }, defaultValue: [] },
    rerun_state: { type: 'DROP_DOWN', required: false, options: Object.fromEntries(RERUN_STATES.map((name, index) => [name, { label: name, index: String(index) }])), defaultValue: '' },
    rerun_requested_at: { type: 'DATETIME', required: false },
    rerun_requested_by: { type: 'SINGLE_LINE_TEXT', required: false },
    rerun_claimed_host: { type: 'SINGLE_LINE_TEXT', required: false },
    rerun_claim_expires_at: { type: 'DATETIME', required: false },
    rerun_attempt: { type: 'NUMBER', required: false },
    rerun_exit_code: { type: 'NUMBER', required: false },
    rerun_result: { type: 'MULTI_LINE_TEXT', required: false },
    rerun_batch_id: { type: 'SINGLE_LINE_TEXT', required: false },
  };
  return structuredClone(properties);
}

function childOutcome(code, signal = null) {
  return () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', code, signal));
    return child;
  };
}

function fakeApi(handler) {
  return { request: handler };
}

test('設定は API 呼出し前に未知キー・危険値・範囲外を拒否する', async (t) => {
  const cases = [
    ['unknown key', { surprise: true }],
    ['relative command', { command: './run_batch.sh' }],
    ['relative cwd', { cwd: '.' }],
    ['non HTTPS', { baseUrl: 'http://example.cybozu.com' }],
    ['URL path', { baseUrl: 'https://example.cybozu.com/path' }],
    ['undefined token', { tokenEnv: 'MISSING_TOKEN' }],
    ['other argv', { args: ['--as-of', 'x'] }],
    ['TTL equals gap', { requestTtlSec: 300 }],
    ['range', { maxCheckedRequests: 0 }],
    ['insufficient candidate limit', { candidateLimit: 8 }],
  ];
  for (const [name, change] of cases) {
    await t.test(name, () => assert.throws(() => config(change), PollControlError));
  }
});

test('実値設定と例示設定は同じ厳格な契約を満たす', async () => {
  // 実値設定はテンプレート配布物には存在しない（利用者が example から作る）ため、有る場合のみ検証する
  for (const name of ['poll-control.config.json', 'poll-control.config.example.json']) {
    let raw;
    try { raw = await readFile(path.resolve(name), 'utf8'); }
    catch (error) {
      if (name.includes('example')) throw error; // example は必ず存在すること
      continue;
    }
    assert.doesNotThrow(() => validateConfig(JSON.parse(raw), { KSQL_TOKEN_LOGS: 'present' }));
  }
});

test('10 フィールド契約を検証する', async (t) => {
  assert.equal(validateFieldContract(fields()), true);
  const mutations = [
    (p) => { delete p.rerun_batch_id; },
    (p) => { p.rerun_attempt.type = 'SINGLE_LINE_TEXT'; },
    (p) => { p.rerun_request.options.EXTRA = {}; },
    (p) => { p.rerun_request.defaultValue = ['REQUEST']; },
    (p) => { delete p.rerun_state.options.CANCELED; },
    (p) => { p.rerun_state.options.EXTRA = {}; },
    (p) => { p.rerun_state.required = true; },
    (p) => { p.rerun_state.defaultValue = 'REQUESTED'; },
  ];
  for (const mutate of mutations) {
    const properties = fields(); mutate(properties);
    await t.test(mutate.toString().slice(0, 35), () => assert.throws(() => validateFieldContract(properties), PollControlError));
  }
});

test('候補クエリは固定条件だけを使い record_type/status/state を含めない', () => {
  const query = candidateQuery(config({ profile: 'p"\\x', host: 'h"\\y' }));
  // record_type はクエリで絞らない — JOB への誤チェックを取得して CANCELED で返すため
  assert.doesNotMatch(query, /record_type/);
  assert.match(query, /rerun_request in \("REQUEST"\)/);
  assert.match(query, /started_at asc limit 20$/);
  assert.doesNotMatch(query, /status|rerun_state/);
  assert.match(query, /p\\"\\\\x/);
});

test('JOB レコードへのチェックは CANCELED + チェック解除で返し spawn しない', async () => {
  const jobRecord = record({ record_type: 'JOB', status: 'ABORTED' });
  const puts = [];
  let spawned = 0;
  const api = fakeApi(async (method, resource, options = {}) => {
    if (method === 'GET') return { records: [jobRecord] };
    puts.push(options.body);
    return { revision: String(puts.length + 1) };
  });
  await pollOnce(config(), { api, now: new Date('2026-08-27T01:00:00Z'), spawnImpl: () => { spawned += 1; return childOutcome(0)(); } });
  assert.equal(spawned, 0);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].record.rerun_state.value, 'CANCELED');
  assert.deepEqual(puts[0].record.rerun_request.value, []);
  assert.match(puts[0].record.rerun_result.value, /バッチレコードではない/);
});

test('状態を新規・継続・実行中・stale・再要求へ振り分ける', () => {
  const now = Date.parse('2026-08-27T01:00:00Z');
  assert.equal(classifyRecord(record(), now), 'new');
  assert.equal(classifyRecord(record({ rerun_state: 'REQUESTED' }), now), 'continued');
  assert.equal(classifyRecord(record({ rerun_state: 'CLAIMED', rerun_claim_expires_at: '2026-08-27T02:00:00Z' }), now), 'active');
  assert.equal(classifyRecord(record({ rerun_state: 'CLAIMED', rerun_claim_expires_at: '2026-08-27T01:00:00Z' }), now), 'stale');
  for (const state of ['SUCCESS', 'FAILED', 'UNKNOWN', 'EXPIRED', 'CANCELED']) {
    assert.equal(classifyRecord(record({ rerun_state: state }), now), 're-request');
  }
});

test('stale は UNKNOWN に回収するだけで通常要求だけを起動する', async () => {
  const puts = []; let getCount = 0; let spawned = 0;
  const api = fakeApi(async (method, resource, options = {}) => {
    if (method === 'GET' && resource === 'records' && getCount++ === 0) return { records: [
      record({ '$id': '1', rerun_state: 'CLAIMED', rerun_claim_expires_at: '2026-08-26T00:00:00Z' }),
      record({ '$id': '2' }),
    ] };
    if (method === 'GET' && resource === 'records') return { records: [] };
    puts.push(options.body);
    return { revision: String(puts.length + 1) };
  });
  const result = await pollOnce(config(), { api, now: new Date('2026-08-27T01:00:00Z'), spawnImpl: (...args) => { spawned += 1; return childOutcome(0)(...args); } });
  assert.equal(spawned, 1);
  assert.equal(puts[0].record.rerun_state.value, 'UNKNOWN');
  assert.deepEqual(puts[0].record.rerun_request.value, []);
  assert.equal(puts[0].record.rerun_exit_code.value, '');
  assert.equal(puts[0].record.rerun_batch_id.value, '');
  assert.equal(puts[1].record.rerun_state.value, 'CLAIMED');
  assert.equal(result.outcome, 'ran');
});

test('新規要求は更新日時と更新者.codeを退避し claim revision を結果へ連鎖する', async () => {
  const puts = []; let recordsGet = 0;
  const source = record();
  const api = fakeApi(async (method, resource, options = {}) => {
    if (method === 'GET' && resource === 'records' && recordsGet++ === 0) return { records: [source] };
    if (method === 'GET' && resource === 'records') return { records: [] };
    puts.push(options.body);
    return { revision: puts.length === 1 ? '91' : '92' };
  });
  await pollOnce(config(), { api, now: new Date('2026-08-27T01:00:00Z'), spawnImpl: childOutcome(0) });
  assert.equal(puts[0].revision, '1');
  assert.equal(puts[0].record.rerun_requested_at.value, '2026-08-27T00:00:00.000Z');
  assert.equal(puts[0].record.rerun_requested_by.value, 'operator-1');
  assert.deepEqual(puts[0].record.rerun_request.value, ['REQUEST']);
  assert.equal(puts[1].revision, '91');
  assert.deepEqual(puts[1].record.rerun_request.value, []);
});

test('Exit 5 継続は証跡と TTL 起点を据え置き attempt を増やす', async () => {
  const puts = []; let recordsGet = 0;
  const source = record({ rerun_state: 'REQUESTED', rerun_requested_at: '2026-08-27T00:00:00Z', rerun_requested_by: 'first-user', rerun_attempt: '2', 更新日時: '2026-08-27T00:59:00Z' });
  const api = fakeApi(async (method, resource, options = {}) => {
    if (method === 'GET' && resource === 'records' && recordsGet++ === 0) return { records: [source] };
    if (method === 'PUT') { puts.push(options.body); return { revision: String(puts.length + 1) }; }
    throw new Error('Exit 5 must not query batches');
  });
  await pollOnce(config(), { api, now: new Date('2026-08-27T01:00:00Z'), spawnImpl: childOutcome(5) });
  assert.equal(puts[0].record.rerun_requested_at, undefined);
  assert.equal(puts[0].record.rerun_requested_by, undefined);
  assert.equal(puts[0].record.rerun_attempt.value, '3');
  assert.equal(puts[1].record.rerun_state.value, 'REQUESTED');
  assert.deepEqual(puts[1].record.rerun_request.value, ['REQUEST']);
});

test('TTL 境界直前は claim、境界時刻は EXPIRED（更新日時では延長しない）', async (t) => {
  const base = record({ rerun_state: 'REQUESTED', rerun_requested_at: '2026-08-27T00:00:00Z', rerun_requested_by: 'u', 更新日時: '2026-08-27T10:00:00Z' });
  for (const [name, now, expected] of [
    ['before', '2026-08-27T05:59:59.999Z', 'CLAIMED'],
    ['boundary', '2026-08-27T06:00:00.000Z', 'EXPIRED'],
  ]) {
    await t.test(name, async () => {
      const puts = []; let getCount = 0;
      const api = fakeApi(async (method, resource, options = {}) => {
        if (method === 'GET' && resource === 'records' && getCount++ === 0) return { records: [base] };
        if (method === 'GET') return { records: [] };
        puts.push(options.body); return { revision: String(puts.length + 1) };
      });
      await pollOnce(config(), { api, now: new Date(now), spawnImpl: childOutcome(5) });
      assert.equal(puts[0].record.rerun_state.value, expected);
    });
  }
});

test('claim 競合では spawn しない', async () => {
  let spawned = 0;
  const api = fakeApi(async (method) => {
    if (method === 'GET') return { records: [record()] };
    throw new PollControlError('revision-conflict', 'conflict', 409);
  });
  const result = await pollOnce(config(), { api, now: new Date('2026-08-27T01:00:00Z'), spawnImpl: () => { spawned += 1; return childOutcome(0)(); } });
  assert.equal(result.outcome, 'claim-conflict');
  assert.equal(spawned, 0);
});

test('結果競合は再 GET 後に証跡を照合して1回だけ再適用する', async (t) => {
  for (const secondConflict of [false, true]) {
    await t.test(secondConflict ? 'second conflict stops' : 'reapply succeeds', async () => {
      let recordGets = 0; let recordsGets = 0; let puts = 0;
      const claimed = record({ '$revision': '8', rerun_state: 'CLAIMED', rerun_claimed_host: 'vps-batch-01', rerun_requested_at: '2026-08-27T00:00:00.000Z', rerun_requested_by: 'operator-1' });
      const api = fakeApi(async (method, resource) => {
        if (method === 'GET' && resource === 'records' && recordsGets++ === 0) return { records: [record()] };
        if (method === 'GET' && resource === 'records') return { records: [] };
        if (method === 'GET' && resource === 'record') { recordGets += 1; return { record: claimed }; }
        puts += 1;
        if (puts === 1) return { revision: '2' };
        if (puts === 2 || (puts === 3 && secondConflict)) throw new PollControlError('revision-conflict', 'conflict', 409);
        return { revision: '9' };
      });
      const result = await pollOnce(config(), { api, now: new Date('2026-08-27T01:00:00Z'), spawnImpl: childOutcome(0) });
      assert.equal(recordGets, 1);
      assert.equal(puts, 3);
      assert.equal(result.updateOutcome, secondConflict ? 'abandoned' : 'reapplied');
    });
  }
  await t.test('changed evidence stops without reapply', async () => {
    let recordsGets = 0; let puts = 0;
    const changed = record({ '$revision': '8', rerun_state: 'CLAIMED', rerun_claimed_host: 'vps-batch-01', rerun_requested_at: 'different', rerun_requested_by: 'different' });
    const api = fakeApi(async (method, resource) => {
      if (method === 'GET' && resource === 'records' && recordsGets++ === 0) return { records: [record()] };
      if (method === 'GET' && resource === 'records') return { records: [] };
      if (method === 'GET' && resource === 'record') return { record: changed };
      puts += 1;
      if (puts === 1) return { revision: '2' };
      throw new PollControlError('revision-conflict', 'conflict', 409);
    });
    const result = await pollOnce(config(), { api, now: new Date('2026-08-27T01:00:00Z'), spawnImpl: childOutcome(0) });
    assert.equal(puts, 2);
    assert.equal(result.updateOutcome, 'abandoned');
  });
});

test('spawn は固定 command/args/cwd、shell false、stdio inherit だけを使う', async () => {
  const cfg = config(); let observed;
  const malicious = '"; ../x\nTOKEN=steal';
  const outcome = await spawnRunner(cfg, (command, args, options) => {
    observed = { command, args, options, malicious };
    return childOutcome(0)();
  });
  assert.deepEqual(outcome, { code: 0, signal: null });
  assert.equal(observed.command, cfg.command);
  assert.deepEqual(observed.args, ['--resume']);
  assert.deepEqual(observed.options, { cwd: cfg.cwd, shell: false, stdio: 'inherit' });
  assert.doesNotMatch(JSON.stringify(observed.args), /steal/);
});

test('Exit 0..5・signal・未知 code は固定辞書とチェック規則へ写像する', () => {
  const expected = [
    ['SUCCESS', false, RESULTS.SUCCESS], ['FAILED', false, RESULTS.EXIT_1],
    ['FAILED', false, RESULTS.EXIT_2], ['FAILED', false, RESULTS.EXIT_3],
    ['FAILED', false, RESULTS.EXIT_4], ['REQUESTED', true, RESULTS.EXIT_5],
  ];
  expected.forEach(([state, keep, result], code) => assert.deepEqual(exitResult({ code, signal: null }), { state, keepRequest: keep, exitCode: code, result }));
  for (const outcome of [{ code: null, signal: 'SIGTERM' }, { code: 9, signal: null }, { code: null, signal: null }]) {
    assert.deepEqual(exitResult(outcome), { state: 'UNKNOWN', keepRequest: false, exitCode: '', result: RESULTS.UNKNOWN });
  }
});

test('全終端状態の再要求は結果をクリアし証跡を取り直す', async () => {
  for (const state of ['SUCCESS', 'FAILED', 'UNKNOWN', 'EXPIRED', 'CANCELED']) {
    const puts = []; let getCount = 0;
    const api = fakeApi(async (method, resource, options = {}) => {
      if (method === 'GET' && resource === 'records' && getCount++ === 0) return { records: [record({ rerun_state: state, rerun_result: 'old', rerun_batch_id: 'old-id' })] };
      if (method === 'PUT') { puts.push(options.body); return { revision: String(puts.length + 1) }; }
      throw new Error('unexpected');
    });
    await pollOnce(config(), { api, now: new Date('2026-08-27T01:00:00Z'), spawnImpl: childOutcome(5) });
    assert.equal(puts[0].record.rerun_result.value, '');
    assert.equal(puts[0].record.rerun_batch_id.value, '');
    assert.equal(puts[0].record.rerun_requested_by.value, 'operator-1');
  }
});

test('BATCH 照合はローカル値・claim後・別IDのみを採用し git_ref を fields に含める', async () => {
  const seen = []; let recordsGet = 0;
  const newBatch = (id, changes = {}) => record({ '$id': id, record_type: 'BATCH', batch_id: `batch-${id}`, started_at: '2026-08-27T01:00:01Z', ...changes, git_ref: 'abc' });
  const api = fakeApi(async (method, resource, options = {}) => {
    seen.push({ method, resource, options });
    if (method === 'GET' && resource === 'records' && recordsGet++ === 0) return { records: [record()] };
    if (method === 'GET' && resource === 'records') return { records: [
      newBatch('10'), newBatch('11', { host: 'other' }), newBatch('12', { profile: 'other' }),
      newBatch('13', { record_type: 'JOB' }), newBatch('14', { started_at: '2026-08-27T00:59:59Z' }), newBatch('15'), newBatch('16'),
    ] };
    return { revision: method === 'PUT' ? '2' : undefined };
  });
  await pollOnce(config(), { api, now: new Date('2026-08-27T01:00:00Z'), spawnImpl: childOutcome(0) });
  const batchGet = seen.filter((x) => x.method === 'GET' && x.resource === 'records')[1];
  assert.match(batchGet.options.query.query, /started_at >= "2026-08-27T01:00:00Z"/); // DATETIME は分切り捨てのため分頭の >= 比較
  assert.ok(batchGet.options.query.fields.includes('git_ref'));
  const resultPut = seen.filter((x) => x.method === 'PUT')[1];
  assert.equal(resultPut.options.body.record.rerun_batch_id.value, ''); // two valid matches => ambiguous
  assert.doesNotMatch(await readFile(path.resolve('scripts/poll_control.mjs'), 'utf8'), /spawnRunner\([^)]*git/);
});

test('BATCH 照合は 0 件なら空欄、1 件なら batch_id、複数件なら空欄', async (t) => {
  for (const [name, batches, expected] of [
    ['zero', [], ''],
    ['one', [record({ '$id': '20', batch_id: 'new-20', started_at: '2026-08-27T01:00:01Z' })], 'new-20'],
    ['many', [record({ '$id': '20', batch_id: 'new-20', started_at: '2026-08-27T01:00:01Z' }), record({ '$id': '21', batch_id: 'new-21', started_at: '2026-08-27T01:00:02Z' })], ''],
  ]) {
    await t.test(name, async () => {
      let gets = 0; const puts = [];
      const api = fakeApi(async (method, resource, options = {}) => {
        if (method === 'GET' && resource === 'records' && gets++ === 0) return { records: [record()] };
        if (method === 'GET' && resource === 'records') return { records: batches };
        puts.push(options.body); return { revision: String(puts.length + 1) };
      });
      await pollOnce(config(), { api, now: new Date('2026-08-27T01:00:00Z'), spawnImpl: childOutcome(0) });
      assert.equal(puts[1].record.rerun_batch_id.value, expected);
    });
  }
});

test('DoS 上限: active CLAIMED を件数に含め、1回1起動・overflow/stale上限を守る', async () => {
  const cfg = config({ maxCheckedRequests: 3, overflowCancellationLimit: 2, staleRecoveryLimit: 1, candidateLimit: 20 });
  const candidates = [
    record({ '$id': '1', rerun_state: 'CLAIMED', rerun_claim_expires_at: '2026-08-28T00:00:00Z' }),
    record({ '$id': '2', rerun_state: 'CLAIMED', rerun_claim_expires_at: '2026-08-26T00:00:00Z' }),
    record({ '$id': '3', rerun_state: 'CLAIMED', rerun_claim_expires_at: '2026-08-26T00:00:00Z' }),
    ...['4', '5', '6', '7'].map((id) => record({ '$id': id })),
  ];
  const puts = []; let gets = 0; let spawned = 0;
  const api = fakeApi(async (method, resource, options = {}) => {
    if (method === 'GET' && resource === 'records' && gets++ === 0) return { records: candidates };
    if (method === 'GET') return { records: [] };
    puts.push(options.body); return { revision: String(puts.length + 1) };
  });
  await pollOnce(cfg, { api, now: new Date('2026-08-27T01:00:00Z'), spawnImpl: (...args) => { spawned += 1; return childOutcome(0)(...args); } });
  assert.equal(spawned, 1);
  assert.equal(puts.filter((p) => p.record.rerun_result?.value === RESULTS.STALE).length, 1);
  assert.equal(puts.filter((p) => p.record.rerun_result?.value === RESULTS.OVERFLOW).length, 2);
});

async function localServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function httpConfig(origin, overrides = {}) {
  const cfg = { ...config(), baseUrl: origin, ...overrides };
  return Object.freeze(cfg); // local mock is intentionally HTTP; production validation rejects it.
}

test('HTTP は query fields[] を送り、429/5xx を有限回だけ再試行する', async () => {
  let calls = 0; let seenUrl;
  const { server, origin } = await localServer((req, res) => {
    calls += 1; seenUrl = req.url;
    if (calls < 3) { res.writeHead(calls === 1 ? 429 : 503, { 'content-type': 'application/json' }); res.end('{}'); }
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"records":[]}'); }
  });
  try {
    const api = createApiClient(httpConfig(origin), { sleep: async () => {} });
    await api.request('GET', 'records', { query: { app: 1, fields: ['$id', 'git_ref'] } });
    assert.equal(calls, 3);
    assert.match(seenUrl, /fields%5B0%5D=%24id/);
    assert.match(seenUrl, /fields%5B1%5D=git_ref/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('HTTP は timeout・非JSON・巨大応答・外部redirect・PUT応答喪失を拒否する', async (t) => {
  const scenarios = [
    ['non-json', (_req, res) => { res.writeHead(200); res.end('not json'); }, {}, 'non-json'],
    ['large', (_req, res) => { res.writeHead(200); res.end(JSON.stringify({ x: 'x'.repeat(3000) })); }, { responseMaxBytes: 1024 }, 'response-too-large'],
    ['redirect', (_req, res) => { res.writeHead(302, { location: 'https://attacker.invalid/x' }); res.end(); }, {}, 'redirect'],
    ['timeout', () => {}, { httpTimeoutMs: 100 }, 'network'],
  ];
  for (const [name, handler, overrides, kind] of scenarios) {
    await t.test(name, async () => {
      const { server, origin } = await localServer(handler);
      try {
        const api = createApiClient(httpConfig(origin, overrides));
        await assert.rejects(api.request('GET', 'records'), (error) => error.kind === kind);
      } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    });
  }
  await t.test('lost PUT response is not retried', async () => {
    let calls = 0;
    const { server, origin } = await localServer((req) => { calls += 1; req.socket.destroy(); });
    try {
      const api = createApiClient(httpConfig(origin));
      await assert.rejects(api.request('PUT', 'record', { body: { fixed: true }, retryable: false }), (error) => error.kind === 'network');
      assert.equal(calls, 1);
    } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  });
  await t.test('same-origin GET redirect is followed', async () => {
    let calls = 0;
    const { server, origin } = await localServer((req, res) => {
      calls += 1;
      if (req.url.startsWith('/k/v1/records.json')) { res.writeHead(302, { location: '/mock-result' }); res.end(); }
      else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"records":[]}'); }
    });
    try {
      const api = createApiClient(httpConfig(origin));
      assert.deepEqual(await api.request('GET', 'records'), { records: [] });
      assert.equal(calls, 2);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });
});

test('固定要約以外の秘密・API本文・子出力・レコード値を PUT へ入れない', async () => {
  const secret = process.env.TEST_KSQL_TOKEN;
  const evil = 'evil-record-value\nstdout-secret';
  const puts = []; let getCount = 0;
  const api = fakeApi(async (method, resource, options = {}) => {
    if (method === 'GET' && resource === 'records' && getCount++ === 0) return { records: [record({ batch_id: evil })] };
    if (method === 'GET') return { records: [] };
    puts.push(options.body); return { revision: String(puts.length + 1) };
  });
  await pollOnce(config(), { api, now: new Date('2026-08-27T01:00:00Z'), spawnImpl: childOutcome(3) });
  const serialized = JSON.stringify(puts);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(serialized, /stdout-secret/);
  assert.match(serialized, new RegExp(RESULTS.EXIT_3));
});

test('flock ランチャーは競合時に片方だけを通す', async () => {
  if (process.platform === 'win32') {
    const launcher = await readFile(path.resolve('scripts/poll_control.sh'), 'utf8');
    assert.match(launcher, /\/usr\/bin\/flock -n -E 75 \/run\/lock\/ksql-poll-control\.lock/);
    assert.match(launcher, /if \[ "\$status" -eq 75 \]; then\s+exit 0/);
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), 'poll-flock-'));
  const marker = path.join(root, 'marker.mjs');
  const lock = path.join(root, 'poll.lock');
  await writeFile(marker, "await fetch(process.env.MOCK_URL); await new Promise((resolve) => setTimeout(resolve, 250));\n", 'utf8');
  let reached = 0;
  const { server, origin } = await localServer((_req, res) => { reached += 1; res.end('{}'); });
  const run = () => new Promise((resolve) => {
    const child = spawn('/usr/bin/flock', ['-n', '-E', '75', lock, '/usr/bin/node', marker], {
      env: { ...process.env, MOCK_URL: origin }, stdio: 'ignore', shell: false,
    });
    child.once('close', (code) => resolve(code));
  });
  try {
    const codes = await Promise.all([run(), run()]);
    assert.deepEqual(codes.sort((a, b) => a - b), [0, 75]);
    assert.equal(reached, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('静的禁止事項と薄いランチャー契約', async () => {
  const source = await readFile(path.resolve('scripts/poll_control.mjs'), 'utf8');
  const launcher = await readFile(path.resolve('scripts/poll_control.sh'), 'utf8');
  assert.doesNotMatch(source, /\bexec(?:File|Sync)?\s*\(/);
  assert.doesNotMatch(source, /sh\s+-c|\bcurl\b|\bgit\s/);
  assert.match(source, /shell:\s*false/);
  assert.match(source, /stdio:\s*'inherit'/);
  assert.doesNotMatch(source + launcher, /console\.(?:log|error)\([^)]*(?:token|body|record)/i);
  assert.match(launcher, /\/usr\/bin\/flock -n -E 75/);
  assert.match(launcher, /\/usr\/bin\/node --env-file="\$REPO_DIR\/\.env" "\$REPO_DIR\/scripts\/poll_control\.mjs"/);
});
