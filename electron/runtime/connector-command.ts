import { ConnectorInputError } from '../domain/connectors'

export function normalizeConnectorJsonArgs(input: string[]): string[] {
  if (!Array.isArray(input) || input.length < 2 || input.length > 128 || input.some(arg => typeof arg !== 'string' || arg.length > 64000 || arg.includes('\0'))) {
    throw new ConnectorInputError('命令参数无效。请先读取对应的 schema，再提交 args 字符串数组。')
  }
  const args: string[] = []
  for (let index = 0; index < input.length; index++) {
    if (input[index] === '--format') {
      if (input[++index] !== 'json') throw new ConnectorInputError('连接器仅支持 JSON 输出，请移除 format 参数后重试。')
    } else if (input[index] === '--format=json') {
      continue
    } else args.push(input[index])
  }
  return args
}
