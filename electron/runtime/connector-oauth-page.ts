import { createHash } from 'node:crypto'

const styles = `
  * { box-sizing: border-box; }
  html { background: #f5f5f5; color: #17191d; color-scheme: light; }
  body {
    margin: 0;
    min-height: 100vh;
    min-height: 100svh;
    display: grid;
    place-items: center;
    padding: 32px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    letter-spacing: 0;
  }
  main {
    width: min(100%, 600px);
    min-height: min(720px, calc(100svh - 64px));
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 56px 32px;
    background: #fff;
    border: 1px solid #ededee;
    border-radius: 18px;
    box-shadow: 0 2px 5px rgb(0 0 0 / 8%);
    text-align: center;
  }
  .lock { width: 96px; height: 120px; flex: none; }
  h1 { margin: 48px 0 16px; font-size: 24px; line-height: 1.4; font-weight: 600; }
  p { margin: 0; max-width: 100%; color: #747b85; font-size: 16px; line-height: 1.9; overflow-wrap: anywhere; }
  @media (max-width: 600px) {
    body { padding: 20px; }
    main { min-height: calc(100svh - 40px); padding: 40px 24px; }
    h1 { font-size: 22px; }
    p { font-size: 15px; }
  }
`

export const connectorOAuthSuccessPolicy = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(styles).digest('base64')}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`

export const connectorOAuthSuccessPage = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>授权成功 - CSEP</title>
  <style>${styles}</style>
</head>
<body>
  <main aria-labelledby="success-title">
    <svg class="lock" viewBox="0 0 96 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="lock-color" x1="0" y1="0.7" x2="1" y2="0.3">
          <stop stop-color="#0669ff"/>
          <stop offset="0.55" stop-color="#65bdff"/>
          <stop offset="1" stop-color="#b2e7fb"/>
        </linearGradient>
      </defs>
      <path d="M20 48V31a28 28 0 0 1 56 0v17" fill="none" stroke="#2547e8" stroke-width="5"/>
      <rect x="0" y="46" width="96" height="74" rx="8" fill="url(#lock-color)"/>
      <path d="M48 62a7.5 7.5 0 0 0-4 13.8l-4 11.4a2 2 0 0 0 1.9 2.7h12.2a2 2 0 0 0 1.9-2.7l-4-11.4A7.5 7.5 0 0 0 48 62Z" fill="#fff"/>
    </svg>
    <h1 id="success-title">授权成功</h1>
    <p>请返回 CSEP 客户端继续使用。你可以关闭此页面。</p>
  </main>
</body>
</html>
`
