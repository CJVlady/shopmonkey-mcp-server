import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlidingWindowLimiter, requestLog, securityHeaders } from '../http-security.js';

test('security headers disable caching, framing, sniffing and referrers', () => {
  const headers = securityHeaders('json');
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['Content-Security-Policy'], undefined);
});

test('HTML security headers restrict content execution', () => {
  const headers = securityHeaders('html');
  assert.match(headers['Content-Security-Policy'], /default-src 'none'/);
  assert.match(headers['Content-Security-Policy'], /form-action 'self'/);
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
});

test('sliding limiter accepts the budget then rejects with retry time', () => {
  const limiter = new SlidingWindowLimiter(2, 60_000, 100);
  assert.equal(limiter.allow('register:127.0.0.1', 0).allowed, true);
  assert.equal(limiter.allow('register:127.0.0.1', 1).allowed, true);
  const rejected = limiter.allow('register:127.0.0.1', 2);
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.retryAfter, 60);
  assert.equal(limiter.allow('register:127.0.0.1', 60_001).allowed, true);
});

test('sliding limiter bounds key storage', () => {
  const limiter = new SlidingWindowLimiter(1, 60_000, 2);
  limiter.allow('one', 0);
  limiter.allow('two', 1);
  limiter.allow('three', 2);
  assert.ok(limiter.size <= 2);
});

test('request log excludes query strings, headers and bodies', () => {
  const request = {
    method: 'POST',
    url: '/token?code=top-secret',
    headers: { authorization: 'Bearer hidden' },
  };
  const line = requestLog(request, 400, 100, 'request-1', 145);
  assert.deepEqual(JSON.parse(line), {
    requestId: 'request-1',
    method: 'POST',
    path: '/token',
    status: 400,
    durationMs: 45,
  });
  assert.ok(!line.includes('top-secret'));
  assert.ok(!line.includes('hidden'));
  assert.deepEqual(Object.keys(JSON.parse(line)).sort(), ['durationMs', 'method', 'path', 'requestId', 'status'].sort());
});
