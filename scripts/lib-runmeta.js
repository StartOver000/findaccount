// ============================================================
// lib-runmeta.js — 采集运行元数据（可复现的最小集）
//
// 记录：runId / 阶段 / 起止时间 / 参数 / 配置指纹 / 计数 / 状态。
// 写入 data/run-meta.json（lastRun + 最近 20 次 history）。
// 配合 accounts 记录里的 source / capturedAt / status 字段使用。
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOT, configFingerprint } = require('./lib-config');

const META_PATH = path.join(ROOT, 'data', 'run-meta.json');
const HISTORY_LIMIT = 20;

function nowIso() {
  return new Date().toISOString();
}

function newRunId() {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function readMeta(file) {
  const target = file || META_PATH;
  try {
    const meta = JSON.parse(fs.readFileSync(target, 'utf8'));
    return { lastRun: meta.lastRun || null, history: Array.isArray(meta.history) ? meta.history : [] };
  } catch (e) {
    if (e.code === 'ENOENT') return { lastRun: null, history: [] };
    throw new Error(`[runmeta] 解析失败 ${target}: ${e.message}`);
  }
}

function writeMeta(meta, file) {
  atomicWriteJson(file || META_PATH, {
    lastRun: meta.lastRun || null,
    history: (meta.history || []).slice(0, HISTORY_LIMIT),
  });
}

// 开始一次运行；返回 run 对象（调用方保存并在结束时传回 finishRun/failRun）
function beginRun(stage, params, file) {
  const meta = readMeta(file);
  const run = {
    runId: newRunId(),
    stage: String(stage || 'unknown'),
    status: 'running',
    startedAt: nowIso(),
    finishedAt: null,
    params: params || {},
    configHash: configFingerprint(),
    counts: {},
    error: null,
  };
  meta.lastRun = run;
  writeMeta(meta, file);
  return run;
}

function finishRun(run, counts, file) {
  if (!run) return null;
  const meta = readMeta(file);
  run.status = 'ok';
  run.finishedAt = nowIso();
  if (counts) run.counts = counts;
  run.durationMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  meta.lastRun = run;
  meta.history = [run, ...(meta.history || []).filter((r) => r && r.runId !== run.runId)].slice(0, HISTORY_LIMIT);
  writeMeta(meta, file);
  return run;
}

function failRun(run, error, file) {
  if (!run) return null;
  const meta = readMeta(file);
  run.status = 'failed';
  run.finishedAt = nowIso();
  run.error = String((error && error.message) || error || 'unknown');
  run.durationMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  meta.lastRun = run;
  meta.history = [run, ...(meta.history || []).filter((r) => r && r.runId !== run.runId)].slice(0, HISTORY_LIMIT);
  writeMeta(meta, file);
  return run;
}

module.exports = {
  META_PATH,
  nowIso,
  newRunId,
  readMeta,
  writeMeta,
  beginRun,
  finishRun,
  failRun,
  configFingerprint,
};
