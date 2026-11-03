import { z } from 'zod'

export const DOCUMENT_PREVIEW_FAILURES = {
  OFFICE_TOO_LARGE: '文档内容或内部文件数量超过预览限制，请复制文件路径后打开原文件。',
  SPREADSHEET_TOO_LARGE: 'Excel 内容较多，超过 10 万单元格的预览上限，请复制文件路径后使用本地表格软件打开。',
  SPREADSHEET_PARSE_FAILED: 'Excel 文件无法解析，可能已损坏或格式不兼容，请用 Excel 或其他表格软件打开并重新保存后重试。',
  UNSUPPORTED_XML: '文档包含暂不支持的 XML 声明，请打开原文件查看。',
  PRESENTATION_EMPTY: '演示文稿没有可读取的页面，请打开原文件检查。',
  CONVERSION_FAILED: '文档内容无法转换为预览，请打开原文件检查，或重新保存文件后重试。',
  CONVERSION_TIMEOUT: '文档转换时间过长，暂时无法预览，请稍后重试或打开原文件。',
  WORKER_EXITED: '文档预览进程意外退出，请重新打开预览或查看原文件。',
  INVALID_RESPONSE: '文档预览进程返回的数据不完整，请重新打开预览或查看原文件。',
  SEND_FAILED: '无法将文档发送到预览进程，请重新打开预览或查看原文件。',
  CANCELLED: '文档预览已取消，请重新打开预览。',
} as const

export type DocumentPreviewFailure = keyof typeof DOCUMENT_PREVIEW_FAILURES
export const documentPreviewFailureSchema = z.object({
  error: z.enum(Object.keys(DOCUMENT_PREVIEW_FAILURES) as [DocumentPreviewFailure, ...DocumentPreviewFailure[]]),
}).strict()

/** Only a fixed reason crosses the worker boundary; parser diagnostics stay private. */
export class DocumentPreviewError extends Error {
  constructor(readonly reason: DocumentPreviewFailure, options?: ErrorOptions) {
    super(DOCUMENT_PREVIEW_FAILURES[reason], options)
    this.name = 'DocumentPreviewError'
  }
}
