import DOMPurify from 'dompurify'

/** Sanitized content stays in an opaque, scriptless frame with no network access. */
export function documentPreviewFrame(html: string, zoom: number): string {
  const scale = Number.isFinite(zoom) ? Math.min(2, Math.max(0.5, zoom)) : 1
  const imageSource = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/
  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'u', 's', 'sup', 'sub', 'br', 'hr', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img'],
    ALLOWED_ATTR: ['src', 'alt', 'colspan', 'rowspan'],
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP: imageSource,
    RETURN_DOM_FRAGMENT: true,
  })
  // DOMPurify permits additional data-image types by default; keep this policy local.
  for (const image of fragment.querySelectorAll('img[src]')) {
    if (!imageSource.test(image.getAttribute('src') ?? '')) image.removeAttribute('src')
  }
  const template = document.createElement('template')
  template.content.append(fragment)
  const safe = template.innerHTML
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>
    *{box-sizing:border-box}html{color-scheme:light}body{margin:0;padding:28px;color:#252525;background:white;font:16px/1.75 system-ui,sans-serif;zoom:${scale};overflow-wrap:anywhere;letter-spacing:0}h1{font-size:26px}h2{font-size:22px}h3{font-size:18px}table{border-collapse:collapse;margin:16px 0;min-width:60%}td,th{border:1px solid #d5d8dc;padding:7px 10px;vertical-align:top;min-width:70px;white-space:pre-wrap}th{background:#f2f4f5}img{max-width:100%;height:auto;display:block;margin:16px 0}pre{white-space:pre-wrap}p{margin:0 0 12px}blockquote{margin-left:0;padding-left:16px;border-left:3px solid #ced5d1}
    </style></head><body>${safe}</body></html>`
}
