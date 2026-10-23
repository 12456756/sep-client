import { app, utilityProcess } from 'electron'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { zipSync, strToU8 } from 'fflate'
import ExcelJS from 'exceljs'
import process from 'node:process'

app.setAppPath(resolve(dirname(fileURLToPath(import.meta.url)), '../..'))

app.whenReady().then(async () => {
  const runtime = {
    render: (format, bytes) => new Promise((resolveResult, reject) => {
      const worker = utilityProcess.fork(resolve(app.getAppPath(), 'out/main/document-preview-worker.js'), [], { serviceName: 'Document preview smoke', stdio: 'pipe' })
      const timer = setTimeout(() => { worker.kill(); reject(new Error('Preview worker timed out')) }, 15000)
      worker.stderr.on('data', value => process.stderr.write(value))
      worker.on('message', result => { clearTimeout(timer); worker.kill(); if (result.error) reject(new Error(`Preview worker error: ${JSON.stringify(result)}`)); else resolveResult(result) })
      worker.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error(`Preview process exited: ${code}`)) })
      worker.once('spawn', () => worker.postMessage({ format, bytes: new Uint8Array(bytes) }))
    }),
    stop: () => undefined,
  }
  try {
    const text = await runtime.render('md', Buffer.from('# accepted'))
    assert.equal(text.kind, 'markdown')
    process.stdout.write('Text worker passed\n')
    const word = await runtime.render('docx', zipSync({
      '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'),
      '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
      'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Accepted Word</w:t></w:r></w:p></w:body></w:document>'),
    }))
    assert.equal(word.kind, 'html')
    assert.match(word.sections[0].html, /Accepted Word/)
    process.stdout.write('Word worker passed\n')
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('Accepted sheet').addRow(['Accepted cell', { formula: '1+1', result: 2 }])
    const sheet = await runtime.render('xlsx', new Uint8Array(await workbook.xlsx.writeBuffer()))
    assert.equal(sheet.kind, 'html')
    assert.match(sheet.sections[0].html, /Accepted cell/)
    process.stdout.write('PASS: actual Electron utilityProcess reads text, Word and Excel through the production build\n')
    runtime.stop()
    app.exit(0)
  } catch (error) {
    runtime.stop()
    process.stderr.write(`${error.stack}\n`)
    app.exit(1)
  }
}).catch(error => { process.stderr.write(`${error.stack}\n`); app.exit(1) })
