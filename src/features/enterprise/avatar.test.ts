import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avatarCandidates, avatarCacheKey } from './avatar';

const employee = {
  name: '产品经理',
  avatar: 'https://legacy.example/avatar.webp?v=legacy',
  avatarAsset: {
    id: 'silicon:product-manager',
    version: '6facaa2a11421f41',
    portraitUrl: 'https://longdaosep.cn/assets/employees/silicon/product-manager.webp?v=6facaa2a11421f41',
    faceUrl: 'https://longdaosep.cn/assets/employees/silicon/product-manager-face.webp?v=6facaa2a11421f41',
  },
};

test('employee face candidates prefer faceUrl and preserve the complete URL', () => {
  assert.deepEqual(avatarCandidates(employee, 'face'), [
    employee.avatarAsset.faceUrl,
    employee.avatarAsset.portraitUrl,
    employee.avatar,
  ]);
});

test('employee portrait candidates prefer portraitUrl and fall back to the same asset faceUrl', () => {
  assert.deepEqual(avatarCandidates(employee, 'portrait'), [
    employee.avatarAsset.portraitUrl,
    employee.avatarAsset.faceUrl,
    employee.avatar,
  ]);
});

test('employee avatar candidates support legacy avatar and no asset', () => {
  assert.deepEqual(avatarCandidates({ name: '产品经理', avatar: employee.avatar, avatarAsset: null }, 'face'), [employee.avatar]);
  assert.deepEqual(avatarCandidates({ name: '产品经理', avatar: null, avatarAsset: null }, 'portrait'), []);
});

test('employee avatar cache key changes when the asset version changes', () => {
  assert.equal(avatarCacheKey(employee, 'face'), 'avatar:silicon:product-manager:6facaa2a11421f41:face');
  assert.notEqual(
    avatarCacheKey(employee, 'face'),
    avatarCacheKey({ ...employee, avatarAsset: { ...employee.avatarAsset, version: 'new-version' } }, 'face'),
  );
});
