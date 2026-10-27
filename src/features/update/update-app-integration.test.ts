import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8')
const client = readFileSync(new URL('../../pages/ClientAppPage.tsx', import.meta.url), 'utf8')

test('the update subscription lives in App and the client toolbar exposes its notice', () => {
  assert.match(app, /import \{ useUpdate \} from '\.\/features\/update\/use-update'/)
  assert.match(app, /const update = useUpdate\(\)/)
  assert.match(app, /<ClientAppPage[^>]* update=\{update\}/s)
  assert.match(client, /import \{ UpdateNotice \} from '\.\.\/components\/enterprise\/UpdateNotice'/)
  assert.match(client, /<UpdateNotice[\s\S]*update=\{update\}[\s\S]*onOpenWorkRecords=\{\(\) => workspace\.navigate\(\{ name: 'records' \}\)\}/)
})

test('the login screen omits the update entry while retaining a single update subscription', () => {
  assert.doesNotMatch(app, /login-update-entry|loginUpdateOpen|<UpdateNotice/)
  assert.equal(app.match(/useUpdate\(\)/g)?.length, 1)
})
