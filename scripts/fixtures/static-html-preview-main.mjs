import { app, BrowserWindow } from 'electron'

app.whenReady().then(() => {
  const window = new BrowserWindow({ show: false, width: 1050, height: 800, webPreferences: { contextIsolation: true, nodeIntegration: false } })
  return window.loadURL(process.env.SEP_STATIC_HTML_TEST_URL)
}).catch(error => { process.stderr.write(`${error.stack}\n`); app.exit(1) })
