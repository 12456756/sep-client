import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { lstat, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { ConnectorStore, type ConnectorEncryption } from '../data/connector-store'
import { DingTalkWorkspaceStore } from '../data/dingtalk-workspace-store'
import { ConnectorProcessDirectories } from '../data/connector-process-directories'
import type { TaskOwnerScope } from '../data/scope-path'
import type { ConnectorRegistryPort } from '../domain/connectors'
import { ConnectorRegistry } from '../runtime/connector-registry'
import { ConnectorAssetStore } from '../data/connector-asset-store'
import { connectorDependenciesSchema, type ConnectorDependencyPort } from '../domain/connector-dependencies'
import { ConnectorDependencies } from '../runtime/connector-dependencies'
import { ManagedConnector } from '../runtime/managed-connector'
import { prepareConnectorBinary } from '../runtime/connector-assets'
import type { ConnectorRuntimePort } from '../domain/connectors'

export function createConnectorRegistry(options: {
  userDataDir: string; encryption: ConnectorEncryption; packaged: boolean; resourcesPath: string
  request?: typeof fetch
  currentScope(): TaskOwnerScope | null
  open(url: string): Promise<void>
}): ConnectorRegistryPort {
  const { userDataDir, encryption, currentScope, open } = options
  const packageRoot = (name: string): string | undefined => options.packaged ? undefined : dirname(createRequire(import.meta.url).resolve(`${name}/package.json`))
  const assets = async (id: 'dingtalk' | 'feishu' | 'wecom', packageName: string, executable: string, subdirectory: string): Promise<{ binary: string; skillsArchive?: string; dependency: ConnectorDependencyPort }> => {
    const root = packageRoot(packageName)
    if (root) {
      const source = join(root, subdirectory, executable)
      const runtimeRoot = join(userDataDir, 'connector-runtime', id)
      const hash = createHash('sha256').update(await readFile(source)).digest('hex')
      const binary = join(runtimeRoot, hash, executable)
      return { binary, skillsArchive: id === 'dingtalk' ? join(root, 'assets/dws-skills.zip') : undefined,
        dependency: { ensure: async signal => { signal.throwIfAborted(); await prepareConnectorBinary(source, runtimeRoot); signal.throwIfAborted() } } }
    }
    const manifestPath = join(options.resourcesPath, 'connector-dependencies.json')
    const metadata = await lstat(manifestPath)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 65536) throw new Error('Invalid connector dependency manifest')
    const manifest = connectorDependenciesSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
    const component = manifest.components.find(item => item.id === id && item.platform === process.platform && item.arch === process.arch)
    if (!component) throw new Error('Connector component unavailable for this platform')
    const store = new ConnectorAssetStore(userDataDir, component)
    return { binary: store.path(component.binary), skillsArchive: id === 'dingtalk' ? store.path('dws-skills.zip') : undefined,
      dependency: new ConnectorDependencies(store, options.request ?? (async (input, init) => {
        const { net } = await import('electron')
        return net.fetch(input instanceof URL ? input.href : input, init)
      })) }
  }
  const managed = (runtime: ConnectorRuntimePort, dependency: ConnectorDependencyPort): ConnectorRuntimePort => new ManagedConnector(runtime, dependency, currentScope)
  return new ConnectorRegistry({
    github: async () => {
      const { GitHubWorkspaceRuntime } = await import('../runtime/github-workspace')
      return new GitHubWorkspaceRuntime({ store: new ConnectorStore(userDataDir, encryption, 'github'), currentScope, request: options.request })
    },
    kdocs: async () => {
      const { KdocsWorkspaceRuntime } = await import('../runtime/kdocs-workspace')
      return new KdocsWorkspaceRuntime({ store: new ConnectorStore(userDataDir, encryption, 'kdocs'), currentScope, open })
    },
    qqmail: async () => {
      const { QQMailWorkspaceRuntime } = await import('../runtime/qq-mail-workspace')
      return new QQMailWorkspaceRuntime({ store: new ConnectorStore(userDataDir, encryption, 'qqmail'), currentScope })
    },
    tmeet: async () => {
      const { TencentMeetingWorkspaceRuntime } = await import('../runtime/tencent-meeting-workspace')
      return new TencentMeetingWorkspaceRuntime({ store: new ConnectorStore(userDataDir, encryption, 'tmeet'), currentScope, open })
    },
    dingtalk: async () => {
      const { ConnectorOAuthRuntime } = await import('../runtime/connector-oauth')
      const { DingTalkWorkspaceRuntime } = await import('../runtime/dingtalk-workspace')
      const asset = await assets('dingtalk', 'dingtalk-workspace-cli', process.platform === 'win32' ? 'dws.exe' : 'dws', 'vendor')
      return managed(new DingTalkWorkspaceRuntime({
        legacy: new ConnectorOAuthRuntime({ store: new ConnectorStore(userDataDir, encryption), currentScope, open }),
        store: new DingTalkWorkspaceStore(userDataDir, new ConnectorStore(userDataDir, encryption, 'dingtalk-workspace')),
        binary: asset.binary,
        skillsArchive: asset.skillsArchive!,
        currentScope, open,
      }), asset.dependency)
    },
    feishu: async () => {
      const { FeishuWorkspaceRuntime } = await import('../runtime/feishu-workspace')
      const asset = await assets('feishu', '@larksuite/cli', process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli', 'bin')
      return managed(new FeishuWorkspaceRuntime({
        store: new ConnectorStore(userDataDir, encryption, 'feishu'), directories: new ConnectorProcessDirectories(userDataDir, 'feishu'),
        binary: asset.binary,
        currentScope, open,
      }), asset.dependency)
    },
    wecom: async () => {
      const { WecomWorkspaceRuntime } = await import('../runtime/wecom-workspace')
      const { WecomWorkspaceStore } = await import('../data/wecom-workspace-store')
      const asset = await assets('wecom', '@wecom/cli', process.platform === 'win32' ? 'wecom-cli.exe' : 'wecom-cli', 'bin')
      return managed(new WecomWorkspaceRuntime({
        store: new WecomWorkspaceStore(userDataDir, new ConnectorStore(userDataDir, encryption, 'wecom')),
        binary: asset.binary,
        currentScope, open,
      }), asset.dependency)
    },
  })
}
