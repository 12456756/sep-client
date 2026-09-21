# SEP Client 前端优化方案

## 项目概况

### 技术栈
- **框架**: React 18.3.1 + TypeScript
- **构建工具**: Electron + Vite (electron-vite)
- **UI 库**: Radix UI + Tailwind CSS 4.x
- **状态管理**: Zustand 5.0.14
- **路由**: React Router DOM 7.18.2
- **可视化**: @xyflow/react 12.11.5

### 当前状态
- **代码规模**: ~12,820 行代码，80 个 TS/TSX 文件
- **组件数量**: 33 个通用组件，15 个页面组件
- **构建产物**: 
  - macOS ARM64: 124 MB
  - macOS x64: 129 MB
  - Windows x64: 98 MB

---

## 一、性能优化方案

### 1.1 代码分割与懒加载

#### 当前问题
- 所有页面组件在入口处同步加载
- 没有实现路由级别的代码分割
- 第三方库未做按需加载优化

#### 优化方案

**路由懒加载**
```typescript
// src/App.tsx - 当前
import { LoginPage } from './pages/LoginPage';
import { ClientAppPage } from './pages/ClientAppPage';

// 优化后
import { lazy, Suspense } from 'react';
const LoginPage = lazy(() => import('./pages/LoginPage'));
const ClientAppPage = lazy(() => import('./pages/ClientAppPage'));
const WorkspacePreviewPage = lazy(() => import('./pages/WorkspacePreviewPage'));
```

**组件懒加载**
```typescript
// 对话框、模态框等低频组件懒加载
const ToolApprovalDialog = lazy(() => import('./components/ToolApprovalDialog'));
```

**预估收益**: 首屏加载时间减少 30-40%

---

### 1.2 Bundle 优化

#### Vite 配置优化

```typescript
// electron.vite.config.ts
export default defineConfig({
  renderer: {
    build: {
      // 代码分割策略
      rollupOptions: {
        output: {
          manualChunks: {
            // React 核心库
            'react-vendor': ['react', 'react-dom'],
            // UI 组件库
            'ui-vendor': [
              '@radix-ui/react-dialog',
              '@radix-ui/react-scroll-area',
              '@radix-ui/react-separator',
              '@radix-ui/react-toast',
              '@radix-ui/react-tooltip',
            ],
            // 可视化库（较大）
            'flow-vendor': ['@xyflow/react'],
            // 路由和状态管理
            'state-vendor': ['react-router-dom', 'zustand'],
            // 图标库
            'icon-vendor': ['lucide-react'],
          },
        },
      },
      // 压缩优化
      minify: 'terser',
      terserOptions: {
        compress: {
          drop_console: true, // 生产环境移除 console
          drop_debugger: true,
        },
      },
      // 启用 CSS 代码分割
      cssCodeSplit: true,
    },
    // 依赖预构建优化
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'zustand',
        'react-router-dom',
      ],
    },
  },
});
```

**预估收益**: Bundle 大小减少 20-25%

---

### 1.3 图片和资源优化

#### 当前问题
- 未对图片资源进行优化
- 没有使用现代图片格式（WebP/AVIF）
- 可能存在未压缩的静态资源

#### 优化方案

```typescript
// vite 插件配置
import viteImagemin from '@vheemstra/vite-plugin-imagemin';
import imageminWebp from 'imagemin-webp';

export default defineConfig({
  plugins: [
    viteImagemin({
      plugins: {
        jpg: imageminWebp({ quality: 85 }),
        png: imageminWebp({ quality: 85 }),
      },
    }),
  ],
});
```

**图片组件封装**
```typescript
// src/components/OptimizedImage.tsx
interface OptimizedImageProps {
  src: string;
  alt: string;
  className?: string;
  loading?: 'lazy' | 'eager';
}

export function OptimizedImage({ 
  src, 
  alt, 
  className, 
  loading = 'lazy' 
}: OptimizedImageProps) {
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      loading={loading}
      decoding="async"
    />
  );
}
```

**预估收益**: 资源大小减少 40-60%

---

### 1.4 React 性能优化

#### 组件优化清单

**1. 使用 React.memo 防止不必要的重渲染**
```typescript
// 适用于展示型组件
export const EmployeeCard = React.memo(({ employee }: Props) => {
  // ...
});
```

**2. 优化 useEffect 依赖**
```typescript
// src/App.tsx - 当前问题
useEffect(() => {
  // 多个状态更新可能导致级联渲染
}, [authState]);

// 优化后 - 使用 useCallback 稳定函数引用
const loadInstances = useCallback(async () => {
  // ...
}, []);
```

**3. 虚拟滚动**
```typescript
// 对于长列表使用虚拟滚动
import { useVirtualizer } from '@tanstack/react-virtual';

export function EmployeeList({ employees }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  
  const virtualizer = useVirtualizer({
    count: employees.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80,
  });
  
  return (
    <div ref={parentRef} style={{ height: '600px', overflow: 'auto' }}>
      <div style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((virtualItem) => (
          <div key={virtualItem.key}>
            {/* 渲染员工卡片 */}
          </div>
        ))}
      </div>
    </div>
  );
}
```

**预估收益**: 大列表渲染性能提升 70-80%

---

### 1.5 Electron 特定优化

#### 主进程优化

```typescript
// electron/main.ts
import { app, BrowserWindow } from 'electron';

app.whenReady().then(() => {
  // 启用硬件加速
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
  
  // V8 优化
  app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');
  
  const win = new BrowserWindow({
    webPreferences: {
      // 使用上下文隔离提升安全性和性能
      contextIsolation: true,
      // 禁用 Node.js 集成（使用 preload 脚本）
      nodeIntegration: false,
      // 启用实验性功能
      enableBlinkFeatures: 'CSSContainerQueries',
    },
  });
});
```

#### 渲染进程优化

```typescript
// 使用 Web Workers 处理重计算
// src/workers/data-processor.worker.ts
self.addEventListener('message', (e) => {
  const result = processLargeDataSet(e.data);
  self.postMessage(result);
});

// 主线程使用
const worker = new Worker(
  new URL('./workers/data-processor.worker.ts', import.meta.url),
  { type: 'module' }
);
```

**预估收益**: 应用启动时间减少 15-20%

---

## 二、用户体验优化

### 2.1 加载状态优化

#### 骨架屏实现

```typescript
// src/components/Skeleton.tsx
export function EmployeeCardSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="h-20 bg-gray-200 rounded-lg mb-4" />
      <div className="h-4 bg-gray-200 rounded w-3/4 mb-2" />
      <div className="h-4 bg-gray-200 rounded w-1/2" />
    </div>
  );
}

// 使用
<Suspense fallback={<EmployeeCardSkeleton />}>
  <EmployeeList />
</Suspense>
```

#### 渐进式加载

```typescript
// 优先加载关键内容，延迟加载次要内容
export function ClientAppPage() {
  const [criticalDataLoaded, setCriticalDataLoaded] = useState(false);
  
  useEffect(() => {
    // 1. 先加载关键数据
    loadCriticalData().then(() => {
      setCriticalDataLoaded(true);
      // 2. 后台加载非关键数据
      loadSecondaryData();
    });
  }, []);
  
  return criticalDataLoaded ? <MainContent /> : <LoadingSkeleton />;
}
```

**预估收益**: 感知加载时间减少 40%

---

### 2.2 错误处理优化

#### Error Boundary 实现

```typescript
// src/components/ErrorBoundary.tsx
import { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };
  
  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }
  
  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // 发送错误到监控服务
    window.electronAPI?.logError?.({
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    });
  }
  
  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="error-container">
          <h2>出错了</h2>
          <p>{this.state.error?.message}</p>
          <button onClick={() => this.setState({ hasError: false })}>
            重试
          </button>
        </div>
      );
    }
    
    return this.props.children;
  }
}
```

---

### 2.3 交互反馈优化

#### 防抖和节流

```typescript
// src/hooks/useDebounce.ts
export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  
  return debouncedValue;
}

// 使用场景：搜索输入
const searchTerm = useDebounce(inputValue, 300);
useEffect(() => {
  if (searchTerm) performSearch(searchTerm);
}, [searchTerm]);
```

#### 乐观更新

```typescript
// 状态管理中实现乐观更新
export const useEmployeeStore = create<EmployeeStore>((set) => ({
  employees: [],
  
  updateEmployee: async (id: string, data: Partial<Employee>) => {
    // 1. 乐观更新 UI
    set((state) => ({
      employees: state.employees.map((emp) =>
        emp.id === id ? { ...emp, ...data } : emp
      ),
    }));
    
    try {
      // 2. 发送请求
      await api.updateEmployee(id, data);
    } catch (error) {
      // 3. 失败时回滚
      set((state) => ({ employees: state.previousEmployees }));
      throw error;
    }
  },
}));
```

---

## 三、构建优化

### 3.1 开发环境优化

```typescript
// electron.vite.config.ts - 开发环境
export default defineConfig({
  renderer: {
    server: {
      // HMR 优化
      hmr: {
        overlay: true,
      },
      // 预热常用模块
      warmup: {
        clientFiles: [
          './src/App.tsx',
          './src/pages/*.tsx',
          './src/components/*.tsx',
        ],
      },
    },
  },
});
```

### 3.2 生产构建优化

```bash
# package.json - 添加构建分析脚本
{
  "scripts": {
    "build:analyze": "BUILD_ANALYZE=true npm run build",
    "build:stats": "vite build --mode production --stats"
  }
}
```

```typescript
// 添加 bundle 分析插件
import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig({
  plugins: [
    visualizer({
      filename: './dist/stats.html',
      open: true,
      gzipSize: true,
      brotliSize: true,
    }),
  ],
});
```

---

## 四、缓存策略

### 4.1 HTTP 缓存

```typescript
// electron/main.ts - 配置缓存头
session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
  callback({
    responseHeaders: {
      ...details.responseHeaders,
      'Cache-Control': ['max-age=31536000, immutable'],
    },
  });
});
```

### 4.2 应用级缓存

```typescript
// src/utils/cache.ts
class CacheManager {
  private cache = new Map<string, { data: unknown; expiry: number }>();
  
  set(key: string, data: unknown, ttl = 300000) {
    this.cache.set(key, {
      data,
      expiry: Date.now() + ttl,
    });
  }
  
  get<T>(key: string): T | null {
    const item = this.cache.get(key);
    if (!item) return null;
    
    if (Date.now() > item.expiry) {
      this.cache.delete(key);
      return null;
    }
    
    return item.data as T;
  }
}

export const cache = new CacheManager();
```

---

## 五、监控与分析

### 5.1 性能监控

```typescript
// src/utils/performance-monitor.ts
export function measurePageLoad() {
  if (!window.performance) return;
  
  window.addEventListener('load', () => {
    const perfData = window.performance.timing;
    const pageLoadTime = perfData.loadEventEnd - perfData.navigationStart;
    const domReadyTime = perfData.domContentLoadedEventEnd - perfData.navigationStart;
    
    // 发送到分析服务
    window.electronAPI?.logPerformance?.({
      pageLoadTime,
      domReadyTime,
      timestamp: Date.now(),
    });
  });
}
```

### 5.2 React DevTools Profiler

```typescript
// src/App.tsx - 添加性能分析
import { Profiler, ProfilerOnRenderCallback } from 'react';

const onRenderCallback: ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
  baseDuration,
  startTime,
  commitTime
) => {
  if (import.meta.env.DEV) {
    console.log(`[Profiler] ${id} (${phase}):`, {
      actualDuration,
      baseDuration,
    });
  }
};

export default function App() {
  return (
    <Profiler id="App" onRender={onRenderCallback}>
      {/* 应用内容 */}
    </Profiler>
  );
}
```

---

## 六、实施计划

### Phase 1: 立即优化（1-2 周）
- [ ] 实现路由懒加载
- [ ] 配置代码分割
- [ ] 添加 Error Boundary
- [ ] 实现骨架屏

### Phase 2: 中期优化（2-3 周）
- [ ] 组件级懒加载
- [ ] React.memo 优化
- [ ] 虚拟滚动实现
- [ ] 图片优化

### Phase 3: 高级优化（3-4 周）
- [ ] Web Workers 集成
- [ ] 缓存策略实施
- [ ] 性能监控系统
- [ ] Bundle 分析和优化

---

## 七、预期收益

| 优化项目 | 预期提升 |
|---------|---------|
| 首屏加载时间 | 减少 30-40% |
| Bundle 大小 | 减少 20-25% |
| 长列表渲染 | 提升 70-80% |
| 应用启动时间 | 减少 15-20% |
| 资源大小 | 减少 40-60% |

---

## 八、注意事项

1. **渐进式优化**: 不要一次性修改所有代码，按照实施计划逐步推进
2. **性能测试**: 每个阶段完成后进行性能基准测试
3. **向后兼容**: 确保优化不影响现有功能
4. **团队协作**: 代码审查确保优化方案符合团队规范
5. **用户反馈**: 灰度发布，收集用户反馈

---

## 参考资源

- [Vite 性能优化指南](https://vitejs.dev/guide/performance.html)
- [React 性能优化](https://react.dev/learn/render-and-commit)
- [Electron 性能优化](https://www.electronjs.org/docs/latest/tutorial/performance)
- [Web Vitals](https://web.dev/vitals/)
