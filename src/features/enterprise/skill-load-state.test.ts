import assert from 'node:assert/strict';
import test from 'node:test';
import { classifySkillLoadError, formatSkillRateLimitMessage } from './skill-load-state';

test('classifies rate limiting and keeps a usable retry duration', () => {
  const failure = classifySkillLoadError({ statusCode: 429, message: '请在 12 秒后重试' });
  assert.equal(failure.kind, 'rate-limited');
  assert.equal(failure.retryAfterSeconds, 12);
  assert.equal(failure.message, '技能服务请求较多，请在 12 秒后重试。');
});

test('uses a safe default when retry-after is not provided', () => {
  const failure = classifySkillLoadError({ statusCode: 429 });
  assert.equal(failure.retryAfterSeconds, 30);
  assert.equal(failure.message, formatSkillRateLimitMessage(30));
});

test('classifies authentication and permission failures', () => {
  assert.equal(classifySkillLoadError({ statusCode: 401 }).kind, 'auth');
  assert.equal(classifySkillLoadError({ statusCode: 401 }).message, '登录状态已过期，请重新登录。');
  assert.equal(classifySkillLoadError({ statusCode: 403 }).kind, 'forbidden');
  assert.equal(classifySkillLoadError({ statusCode: 403 }).message, '当前账号没有查看这些技能的权限。');
});

test('classifies network and service failures', () => {
  assert.equal(classifySkillLoadError(new Error('Failed to fetch')).kind, 'network');
  assert.equal(classifySkillLoadError({ message: '网络连接已断开' }).kind, 'network');
  assert.equal(classifySkillLoadError({ statusCode: 503, message: 'upstream unavailable' }).kind, 'service');
});

test('falls back to the server message for an unknown failure', () => {
  const failure = classifySkillLoadError({ message: '自定义错误' });
  assert.equal(failure.kind, 'unknown');
  assert.equal(failure.message, '自定义错误');
});
