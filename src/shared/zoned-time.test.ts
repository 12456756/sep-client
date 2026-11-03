import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { localDateTime, scheduledInstant } from './zoned-time'

test('wall times resolve in explicit zones independent of machine timezone', () => {
  for (const [local, timezone, expected] of [
    ['2026-10-22T09:00', 'Asia/Shanghai', '2026-10-22T01:00:00Z'],
    ['2026-10-22T09:00', 'America/New_York', '2026-10-22T13:00:00Z'],
    ['2026-10-22T09:00', 'Asia/Kathmandu', '2026-10-22T03:15:00Z'],
    ['2026-10-22T00:00', 'UTC', '2026-10-22T00:00:00Z'],
  ]) {
    assert.equal(scheduledInstant(local!, timezone!), Date.parse(expected!))
    assert.equal(localDateTime(Date.parse(expected!), timezone!), local)
  }
})

test('invalid calendar input and DST gaps or repeated wall times are never shifted or guessed', () => {
  for (const [local, timezone] of [
    ['2026-02-30T09:00', 'UTC'], ['2026-10-22T24:00', 'UTC'], ['2026-10-22T09:00Z', 'UTC'], ['bad', 'UTC'],
    ['2026-03-08T02:30', 'America/New_York'], ['2026-11-01T01:30', 'America/New_York'],
    ['2026-10-04T02:15', 'Australia/Lord_Howe'], ['2026-04-05T01:45', 'Australia/Lord_Howe'],
    ['2026-10-22T09:00', 'Invalid/Timezone'],
  ]) assert.throws(() => scheduledInstant(local!, timezone!))
})
