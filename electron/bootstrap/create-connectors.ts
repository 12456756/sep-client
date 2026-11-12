import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { ConnectorStore, type ConnectorEncryption } from '../data/connector-store'
import { DingTalkWorkspaceStore } from '../data/dingtalk-workspace-store'
import { ConnectorProcessDirectories } from '../data/connector-process-directories'
import type { TaskOwnerScope } from '../data/scope-path'
import type { ConnectorRegistryPort } from '../domain/connectors'
import { ConnectorRegistry } from '../runtime/connector-registry'
import { prepareConnectorBinary } from '../runtime/connector-assets'

export function createConnectorRegistry(options: {
  userDataDir: string; encryption: ConnectorEncryption; packaged: boolean; resourcesPath: string
  currentScope(): TaskOwnerScope | null
  open(url: string): Promise<void>
}): ConnectorRegistryPort {
  const { userDataDir, encryption, currentScope, open } = options
  const packageRoot = (name: string): string | undefined => options.packaged ? undefined : dirname(createRequire(import.meta.url).resolve(`${name}/package.json`))
  return new ConnectorRegistry({
    dingtalk: async () => {
      const { ConnectorOAuthRuntime } = await import('../runtime/connector-oauth')
      const { DingTalkWorkspaceRuntime } = await import('../runtime/dingtalk-workspace')
      const root = packageRoot('dingtalk-workspace-cli')
      return new DingTalkWorkspaceRuntime({
        legacy: new ConnectorOAuthRuntime({ store: new ConnectorStore(userDataDir, encryption), currentScope, open }),
        store: new DingTalkWorkspaceStore(userDataDir, new ConnectorStore(userDataDir, encryption, 'dingtalk-workspace')),
        binary: await prepareConnectorBinary(join(root ? join(root, 'vendor') : join(options.resourcesPath, 'dingtalk'), process.platform === 'win32' ? 'dws.exe' : 'dws'), join(userDataDir, 'connector-runtime', 'dingtalk')),
        skillsArchive: root ? join(root, 'assets', 'dws-skills.zip') : join(options.resourcesPath, 'dingtalk/dws-skills.zip'),
        currentScope, open,
      })
    },
    feishu: async () => {
      const { FeishuWorkspaceRuntime } = await import('../runtime/feishu-workspace')
      const root = packageRoot('@larksuite/cli')
      return new FeishuWorkspaceRuntime({
        store: new ConnectorStore(userDataDir, encryption, 'feishu'), directories: new ConnectorProcessDirectories(userDataDir, 'feishu'),
        binary: await prepareConnectorBinary(join(root ? join(root, 'bin') : join(options.resourcesPath, 'feishu'), process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli'), join(userDataDir, 'connector-runtime', 'feishu')),
        currentScope, open,
      })
    },
  })
}
