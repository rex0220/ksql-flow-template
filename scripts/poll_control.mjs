#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const RERUN_STATES = Object.freeze([
  'REQUESTED', 'CLAIMED', 'SUCCESS', 'FAILED', 'UNKNOWN', 'EXPIRED', 'CANCELED',
]);
export const TERMINAL_STATES = new Set(['SUCCESS', 'FAILED', 'UNKNOWN', 'EXPIRED', 'CANCELED']);
export const FAILED_STATUSES = new Set(['FAILED', 'ABORTED', 'TIMEOUT']);

export const RESULTS = Object.freeze({
  SUCCESS: 'リランが正常終了しました。実行ログアプリを確認してください。',
  EXIT_1: 'リランを開始できませんでした（設定・検証エラー、または再開できる直近バッチが見つかりません）。実行ログアプリを確認してください。',
  EXIT_2: '業務アサート違反で安全停止しました。対象データを確認してください。',
  EXIT_3: '実行時エラーで終了しました。基盤と実行ログアプリを確認してください。',
  EXIT_4: '一部のジョブが失敗しました。実行ログアプリを確認してください。',
  EXIT_5: '別のバッチが実行中のため、要求状態に戻しました。',
  UNKNOWN: '終了結果を確認できません。実行ログアプリと VPS を照合してください。',
  STALE: '確保期限を超過したため結果不明にしました。自動再実行はしていません。',
  EXPIRED: '要求の有効期限を超過したため実行しませんでした。',
  OVERFLOW: '受付条件を満たさないため取り消しました。',
  NOT_FAILED: '対象が失敗したバッチではないため取り消しました。失敗した実行の記録を選び直してください。',
  NOT_BATCH: '対象がバッチレコードではないため取り消しました。レコード種別 BATCH（親レコード）にチェックしてください。',
});

const CONFIG_KEYS = new Set([
  'baseUrl', 'guestSpaceId', 'logAppId', 'tokenEnv', 'profile', 'host', 'command',
  'args', 'cwd', 'requestTtlSec', 'pollGapSec', 'batchTimeoutSec', 'claimGraceSec',
  'maxCheckedRequests', 'overflowCancellationLimit', 'staleRecoveryLimit',
  'candidateLimit', 'httpTimeoutMs', 'responseMaxBytes', 'httpRetryLimit',
  'httpRetryMaxElapsedMs',
]);

const INTEGER_RANGES = Object.freeze({
  logAppId: [1, Number.MAX_SAFE_INTEGER],
  requestTtlSec: [1, 604800],
  pollGapSec: [1, 86400],
  batchTimeoutSec: [1, 604800],
  claimGraceSec: [0, 86400],
  maxCheckedRequests: [1, 100],
  overflowCancellationLimit: [1, 100],
  staleRecoveryLimit: [1, 100],
  candidateLimit: [1, 500],
  httpTimeoutMs: [100, 120000],
  responseMaxBytes: [1024, 10 * 1024 * 1024],
  httpRetryLimit: [0, 5],
  httpRetryMaxElapsedMs: [0, 120000],
});

const RECORD_FIELDS = [
  '$id', '$revision', '更新日時', '更新者', 'record_type', 'status', 'batch_id',
  'profile', 'host', 'started_at', 'rerun_request', 'rerun_state',
  'rerun_requested_at', 'rerun_requested_by', 'rerun_claimed_host',
  'rerun_claim_expires_at', 'rerun_attempt', 'rerun_exit_code', 'rerun_result',
  'rerun_batch_id',
];

const FIELD_CONTRACT = Object.freeze({
  rerun_request: 'CHECK_BOX',
  rerun_state: 'DROP_DOWN',
  rerun_requested_at: 'DATETIME',
  rerun_requested_by: 'SINGLE_LINE_TEXT',
  rerun_claimed_host: 'SINGLE_LINE_TEXT',
  rerun_claim_expires_at: 'DATETIME',
  rerun_attempt: 'NUMBER',
  rerun_exit_code: 'NUMBER',
  rerun_result: 'MULTI_LINE_TEXT',
  rerun_batch_id: 'SINGLE_LINE_TEXT',
});

export class PollControlError extends Error {
  constructor(kind, message, status = undefined) {
    super(message);
    this.name = 'PollControlError';
    this.kind = kind;
    this.status = status;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateConfig(raw, env = process.env) {
  if (!isPlainObject(raw)) throw new PollControlError('config', '設定は JSON object である必要があります。');
  const unknown = Object.keys(raw).filter((key) => !CONFIG_KEYS.has(key));
  if (unknown.length) throw new PollControlError('config', '設定に未知のキーがあります。');
  for (const key of CONFIG_KEYS) {
    if (!(key in raw)) throw new PollControlError('config', '設定の必須キーが不足しています。');
  }
  let baseUrl;
  try {
    baseUrl = new URL(raw.baseUrl);
  } catch {
    throw new PollControlError('config', 'baseUrl が不正です。');
  }
  if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || baseUrl.pathname !== '/') {
    throw new PollControlError('config', 'baseUrl は HTTPS origin である必要があります。');
  }
  if (raw.guestSpaceId !== null && (!Number.isSafeInteger(raw.guestSpaceId) || raw.guestSpaceId < 1)) {
    throw new PollControlError('config', 'guestSpaceId が不正です。');
  }
  for (const [key, [min, max]] of Object.entries(INTEGER_RANGES)) {
    if (!Number.isSafeInteger(raw[key]) || raw[key] < min || raw[key] > max) {
      throw new PollControlError('config', '数値設定が範囲外です。');
    }
  }
  for (const key of ['tokenEnv', 'profile', 'host']) {
    if (typeof raw[key] !== 'string' || raw[key].length === 0) throw new PollControlError('config', '文字列設定が不正です。');
  }
  if (!/^[A-Z_][A-Z0-9_]*$/.test(raw.tokenEnv)) throw new PollControlError('config', 'tokenEnv が不正です。');
  if (typeof env[raw.tokenEnv] !== 'string' || env[raw.tokenEnv].length === 0) {
    throw new PollControlError('config', 'tokenEnv で指定した環境変数が未定義です。');
  }
  if (!path.isAbsolute(raw.command) || !path.isAbsolute(raw.cwd)) {
    throw new PollControlError('config', 'command と cwd は絶対パスである必要があります。');
  }
  if (path.basename(raw.command) !== 'run_batch.sh') throw new PollControlError('config', 'command は run_batch.sh に固定してください。');
  if (!Array.isArray(raw.args) || raw.args.length !== 1 || raw.args[0] !== '--resume') {
    throw new PollControlError('config', 'args は --resume だけに固定してください。');
  }
  if (raw.requestTtlSec <= raw.pollGapSec) {
    throw new PollControlError('config', '要求 TTL はポーリング空白時間より長くしてください。');
  }
  if (raw.candidateLimit < raw.maxCheckedRequests + raw.overflowCancellationLimit + raw.staleRecoveryLimit) {
    throw new PollControlError('config', 'candidateLimit が処理上限に対して不足しています。');
  }
  return Object.freeze({ ...raw, baseUrl: baseUrl.origin });
}

export async function loadConfig(configPath, env = process.env) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    throw new PollControlError('config', '設定ファイルを読み込めません。');
  }
  return validateConfig(parsed, env);
}

function apiPath(config, resource) {
  return config.guestSpaceId === null
    ? `/k/v1/${resource}.json`
    : `/k/guest/${config.guestSpaceId}/v1/${resource}.json`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonResponse(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) throw new PollControlError('http', 'API 応答を読み取れません。', response.status);
  let size = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new PollControlError('response-too-large', 'API 応答が上限を超えました。', response.status);
    }
    chunks.push(value);
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new PollControlError('non-json', 'API 応答が JSON ではありません。', response.status);
  }
}

export function createApiClient(config, { fetchImpl = globalThis.fetch, sleep = delay } = {}) {
  const origin = new URL(config.baseUrl).origin;
  const token = process.env[config.tokenEnv];

  async function request(method, resource, { query, body, retryable = method === 'GET' } = {}) {
    const url = new URL(apiPath(config, resource), origin);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (Array.isArray(value)) value.forEach((item, index) => url.searchParams.set(`${key}[${index}]`, String(item)));
        else url.searchParams.set(key, String(value));
      }
    }
    const started = Date.now();
    let attempt = 0;
    let redirectCount = 0;
    let currentUrl = url;
    while (true) {
      let response;
      try {
        response = await fetchImpl(currentUrl, {
          method,
          headers: {
            'X-Cybozu-API-Token': token,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'manual',
          signal: AbortSignal.timeout(config.httpTimeoutMs),
        });
      } catch {
        throw new PollControlError('network', 'API 通信に失敗しました。');
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        let redirected;
        try { redirected = new URL(location, currentUrl); } catch { throw new PollControlError('redirect', 'API redirect を拒否しました。'); }
        if (redirected.origin !== origin) throw new PollControlError('redirect', 'API redirect を拒否しました。');
        if (method !== 'GET' || redirectCount >= 3) throw new PollControlError('redirect', 'API redirect を拒否しました。');
        redirectCount += 1;
        currentUrl = redirected;
        await response.body?.cancel();
        continue;
      }
      const shouldRetry = retryable && (response.status === 429 || response.status >= 500);
      const remaining = config.httpRetryMaxElapsedMs - (Date.now() - started);
      if (shouldRetry && attempt < config.httpRetryLimit && remaining > 0) {
        attempt += 1;
        await response.body?.cancel();
        await sleep(Math.min(100 * (2 ** attempt), remaining));
        if (Date.now() - started >= config.httpRetryMaxElapsedMs) {
          throw new PollControlError('http', 'API の再試行上限に達しました。', response.status);
        }
        continue;
      }
      const data = await readJsonResponse(response, config.responseMaxBytes);
      if (!response.ok) {
        const kind = response.status === 409 ? 'revision-conflict' : 'http';
        throw new PollControlError(kind, 'API がエラーを返しました。', response.status);
      }
      return data;
    }
  }

  return Object.freeze({ request });
}

function escapeQueryString(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

// record_type をクエリで絞らない: JOB(子レコード)にチェックを入れる誤操作は自然に起きるが、
// クエリで落とすとポーラーが永遠に拾わず、リマインダーが誤発報する(リマインダー条件は
// record_type を見ない)。取得してコードで判定し、CANCELED + 理由で人間に返す。
export function candidateQuery(config) {
  return `profile = "${escapeQueryString(config.profile)}" and host = "${escapeQueryString(config.host)}" and rerun_request in ("REQUEST") order by started_at asc limit ${config.candidateLimit}`;
}

export function batchQuery(config, claimTime) {
  // claimTime は分頭 (toKintoneMinuteFloor)。DATETIME の分切り捨てに合わせ >= で比較する
  return `record_type in ("BATCH") and profile = "${escapeQueryString(config.profile)}" and host = "${escapeQueryString(config.host)}" and started_at >= "${escapeQueryString(claimTime)}" order by started_at asc limit ${config.candidateLimit}`;
}

function value(record, field) {
  return record?.[field]?.value ?? '';
}

function recordId(record) { return String(value(record, '$id')); }
function revision(record) { return String(value(record, '$revision')); }

export function classifyRecord(record, nowMs) {
  const state = value(record, 'rerun_state');
  if (state === 'CLAIMED') {
    const expires = Date.parse(value(record, 'rerun_claim_expires_at'));
    return Number.isFinite(expires) && expires <= nowMs ? 'stale' : 'active';
  }
  if (state === '') return 'new';
  if (state === 'REQUESTED') return 'continued';
  if (TERMINAL_STATES.has(state)) return 're-request';
  return 'invalid';
}

function field(value) { return { value }; }

function updateBody(config, record, fields) {
  return { app: config.logAppId, id: recordId(record), revision: revision(record), record: fields };
}

async function putRecord(api, config, record, fields) {
  return api.request('PUT', 'record', { body: updateBody(config, record, fields), retryable: false });
}

function terminalFields(state, result) {
  return {
    rerun_request: field([]),
    rerun_state: field(state),
    rerun_exit_code: field(''),
    rerun_result: field(result),
    rerun_batch_id: field(''),
    rerun_claimed_host: field(''),
    rerun_claim_expires_at: field(''),
  };
}

export function validateFieldContract(properties) {
  const errors = [];
  for (const [code, type] of Object.entries(FIELD_CONTRACT)) {
    const property = properties?.[code];
    if (!property) errors.push(`${code}:missing`);
    else if (property.type !== type) errors.push(`${code}:type`);
    if (property?.required === true) errors.push(`${code}:required`);
  }
  const request = properties?.rerun_request;
  if (request) {
    if (JSON.stringify(Object.keys(request.options ?? {}).sort()) !== JSON.stringify(['REQUEST'])) errors.push('rerun_request:options');
    const defaults = Array.isArray(request.defaultValue) ? request.defaultValue : [];
    if (defaults.length !== 0) errors.push('rerun_request:default');
  }
  const state = properties?.rerun_state;
  if (state) {
    if (JSON.stringify(Object.keys(state.options ?? {}).sort()) !== JSON.stringify([...RERUN_STATES].sort())) errors.push('rerun_state:options');
    if (state.defaultValue !== undefined && state.defaultValue !== '') errors.push('rerun_state:default');
  }
  if (errors.length) throw new PollControlError('schema', '実行ログアプリのリラン用フィールド契約が不一致です。');
  return true;
}

export async function checkFieldContract(api, config) {
  const response = await api.request('GET', 'app/form/fields', { query: { app: config.logAppId } });
  return validateFieldContract(response.properties);
}

export function exitResult(outcome) {
  const code = outcome?.code;
  if (outcome?.signal || !Number.isInteger(code) || code < 0 || code > 5) {
    return { state: 'UNKNOWN', keepRequest: false, exitCode: '', result: RESULTS.UNKNOWN };
  }
  if (code === 0) return { state: 'SUCCESS', keepRequest: false, exitCode: 0, result: RESULTS.SUCCESS };
  if (code === 5) return { state: 'REQUESTED', keepRequest: true, exitCode: 5, result: RESULTS.EXIT_5 };
  return { state: 'FAILED', keepRequest: false, exitCode: code, result: RESULTS[`EXIT_${code}`] };
}

export function spawnRunner(config, spawnImpl = nodeSpawn) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(config.command, config.args, { cwd: config.cwd, shell: false, stdio: 'inherit' });
    } catch {
      resolve({ code: null, signal: null });
      return;
    }
    child.once('error', () => resolve({ code: null, signal: null }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function claimEvidence(record, kind) {
  if (kind === 'continued') {
    return { requestedAt: value(record, 'rerun_requested_at'), requestedBy: value(record, 'rerun_requested_by') };
  }
  return { requestedAt: value(record, '更新日時'), requestedBy: value(record, '更新者')?.code ?? '' };
}

function isExpired(requestedAt, nowMs, ttlSec) {
  const timestamp = Date.parse(requestedAt);
  return !Number.isFinite(timestamp) || nowMs >= timestamp + ttlSec * 1000;
}

// kintone の DATETIME・クエリ日時リテラルは yyyy-MM-ddTHH:mm:ssZ。
// Date#toISOString() のミリ秒 (.SSS) を必ず落としてから渡す。
export function toKintoneDateTime(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// kintone の DATETIME フィールド値は分単位に切り捨てられる（実機ドリルで確認）。
// BATCH 照合の基準時刻は分頭へ floor しないと、claim と同じ分に始まった resume の
// started_at (HH:mm:00Z) が「claim 時刻(秒付き)より後」を満たせず、照合が常に空振りする。
export function toKintoneMinuteFloor(ms) {
  const date = new Date(ms);
  date.setUTCSeconds(0, 0);
  return toKintoneDateTime(date.getTime());
}

function makeClaimFields(record, config, nowIso, kind, evidence) {
  const previous = Number(value(record, 'rerun_attempt'));
  const fields = {
    rerun_request: field(['REQUEST']),
    rerun_state: field('CLAIMED'),
    rerun_claimed_host: field(config.host),
    rerun_claim_expires_at: field(toKintoneDateTime(Date.parse(nowIso) + (config.batchTimeoutSec + config.claimGraceSec) * 1000)),
    rerun_attempt: field(String(Number.isSafeInteger(previous) && previous >= 0 ? previous + 1 : 1)),
  };
  if (kind !== 'continued') {
    fields.rerun_requested_at = field(evidence.requestedAt);
    fields.rerun_requested_by = field(evidence.requestedBy);
    fields.rerun_exit_code = field('');
    fields.rerun_result = field('');
    fields.rerun_batch_id = field('');
  }
  return fields;
}

async function fetchCandidates(api, config) {
  const query = { app: config.logAppId, query: candidateQuery(config), fields: RECORD_FIELDS };
  const response = await api.request('GET', 'records', { query });
  if (!Array.isArray(response.records)) throw new PollControlError('http', '候補 API 応答が不正です。');
  return response.records.slice(0, config.candidateLimit);
}

async function findBatchId(api, config, claimTime, sourceId) {
  const fields = ['$id', 'record_type', 'batch_id', 'git_ref', 'profile', 'host', 'started_at'];
  const response = await api.request('GET', 'records', {
    query: { app: config.logAppId, query: batchQuery(config, claimTime), fields },
  });
  const matches = (response.records ?? []).filter((record) =>
    recordId(record) !== sourceId && value(record, 'record_type') === 'BATCH' &&
    value(record, 'profile') === config.profile && value(record, 'host') === config.host &&
    Date.parse(value(record, 'started_at')) >= Date.parse(claimTime));
  return matches.length === 1 ? value(matches[0], 'batch_id') : '';
}

function resultFields(mapped, batchId) {
  return {
    rerun_request: field(mapped.keepRequest ? ['REQUEST'] : []),
    rerun_state: field(mapped.state),
    rerun_exit_code: field(mapped.exitCode === '' ? '' : String(mapped.exitCode)),
    rerun_result: field(mapped.result),
    rerun_batch_id: field(batchId),
    rerun_claimed_host: field(''),
    rerun_claim_expires_at: field(''),
  };
}

function evidenceMatches(record, config, evidence) {
  // rerun_requested_at は kintone 側で表記が正規化されうるため、文字列でなく時刻値で比較する
  const storedAt = Date.parse(value(record, 'rerun_requested_at'));
  const evidenceAt = Date.parse(evidence.requestedAt);
  return Array.isArray(value(record, 'rerun_request')) && value(record, 'rerun_request').includes('REQUEST') &&
    value(record, 'rerun_state') === 'CLAIMED' && value(record, 'rerun_claimed_host') === config.host &&
    Number.isFinite(storedAt) && storedAt === evidenceAt && value(record, 'rerun_requested_by') === evidence.requestedBy;
}

async function applyResult(api, config, sourceRecord, claimRevision, fields, evidence) {
  const initial = { ...sourceRecord, $revision: field(String(claimRevision)) };
  try {
    await putRecord(api, config, initial, fields);
    return 'updated';
  } catch (error) {
    if (error.kind !== 'revision-conflict') throw error;
  }
  const response = await api.request('GET', 'record', { query: { app: config.logAppId, id: recordId(sourceRecord) } });
  if (!evidenceMatches(response.record, config, evidence)) return 'abandoned';
  try {
    await putRecord(api, config, response.record, fields);
    return 'reapplied';
  } catch (error) {
    if (error.kind === 'revision-conflict') return 'abandoned';
    throw error;
  }
}

export async function pollOnce(config, { api = createApiClient(config), spawnImpl = nodeSpawn, now = new Date() } = {}) {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const records = await fetchCandidates(api, config);
  const classified = records.map((record) => ({ record, kind: classifyRecord(record, nowMs) }));

  let staleCount = 0;
  for (const item of classified) {
    if (item.kind !== 'stale' || staleCount >= config.staleRecoveryLimit) continue;
    staleCount += 1;
    try { await putRecord(api, config, item.record, terminalFields('UNKNOWN', RESULTS.STALE)); }
    catch (error) { if (error.kind !== 'revision-conflict') throw error; }
  }

  const normal = [];
  for (const item of classified) {
    if (!['new', 'continued', 're-request'].includes(item.kind)) continue;
    // JOB(子レコード)へのチェックは誤操作。BATCH に付け直してもらう
    if (value(item.record, 'record_type') !== 'BATCH') {
      try { await putRecord(api, config, item.record, terminalFields('CANCELED', RESULTS.NOT_BATCH)); }
      catch (error) { if (error.kind !== 'revision-conflict') throw error; }
      continue;
    }
    if (!FAILED_STATUSES.has(value(item.record, 'status'))) {
      try { await putRecord(api, config, item.record, terminalFields('CANCELED', RESULTS.NOT_FAILED)); }
      catch (error) { if (error.kind !== 'revision-conflict') throw error; }
      continue;
    }
    normal.push(item);
  }

  // Review note 2: an in-flight CLAIMED record counts toward the checked-request cap.
  // This is the conservative choice: excess new requests are canceled instead of queued.
  const activeCount = classified.filter((item) => item.kind === 'active').length;
  const available = Math.max(0, config.maxCheckedRequests - activeCount);
  const accepted = normal.slice(0, available);
  const overflow = normal.slice(available, available + config.overflowCancellationLimit);
  for (const item of overflow) {
    try { await putRecord(api, config, item.record, terminalFields('CANCELED', RESULTS.OVERFLOW)); }
    catch (error) { if (error.kind !== 'revision-conflict') throw error; }
  }
  const target = accepted[0];
  if (!target) return { outcome: 'idle', staleRecovered: staleCount, overflowCanceled: overflow.length };

  const evidence = claimEvidence(target.record, target.kind);
  if (isExpired(evidence.requestedAt, nowMs, config.requestTtlSec)) {
    try { await putRecord(api, config, target.record, terminalFields('EXPIRED', RESULTS.EXPIRED)); }
    catch (error) { if (error.kind !== 'revision-conflict') throw error; }
    return { outcome: 'expired' };
  }

  let claim;
  try {
    claim = await putRecord(api, config, target.record, makeClaimFields(target.record, config, nowIso, target.kind, evidence));
  } catch (error) {
    if (error.kind === 'revision-conflict') return { outcome: 'claim-conflict' };
    throw error;
  }
  const claimRevision = claim.revision;
  const processOutcome = await spawnRunner(config, spawnImpl);
  const mapped = exitResult(processOutcome);
  const batchId = mapped.exitCode === 5 ? '' : await findBatchId(api, config, toKintoneMinuteFloor(nowMs), recordId(target.record));
  const updateOutcome = await applyResult(api, config, target.record, claimRevision, resultFields(mapped, batchId), evidence);
  return { outcome: 'ran', exitCode: mapped.exitCode, updateOutcome };
}

export async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  let configPath = path.resolve('poll-control.config.json');
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--check') check = true;
    else if (argv[index] === '--config' && argv[index + 1]) { configPath = path.resolve(argv[index + 1]); index += 1; }
    else throw new PollControlError('usage', '使用できる引数は --check と --config だけです。');
  }
  const config = await loadConfig(configPath, dependencies.env ?? process.env);
  const api = dependencies.api ?? createApiClient(config, dependencies);
  if (check) {
    await checkFieldContract(api, config);
    dependencies.log?.('リラン用フィールド契約を確認しました。');
    return 0;
  }
  await pollOnce(config, { ...dependencies, api });
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  runCli().then(
    (code) => { process.exitCode = code; },
    () => {
      // Never print tokens, API bodies, record values, or exception text.
      console.error('poll-control は安全に停止しました。設定、通信、実行ログアプリを確認してください。');
      process.exitCode = 1;
    },
  );
}
