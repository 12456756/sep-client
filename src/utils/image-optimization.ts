/**
 * 图片优化工具
 * 提供 WebP/AVIF 支持、懒加载、响应式图片等功能
 */

/**
 * 检测浏览器对现代图片格式的支持
 */
export const imageFormatSupport = {
  webp: false,
  avif: false,
};

/**
 * 检测 WebP 支持
 */
async function checkWebPSupport(): Promise<boolean> {
  if (typeof window === 'undefined') return false;

  return new Promise((resolve) => {
    const webp = new Image();
    webp.onload = webp.onerror = () => {
      resolve(webp.height === 2);
    };
    webp.src = 'data:image/webp;base64,UklGRjoAAABXRUJQVlA4IC4AAACyAgCdASoCAAIALmk0mk0iIiIiIgBoSygABc6WWgAA/veff/0PP8bA//LwYAAA';
  });
}

/**
 * 检测 AVIF 支持
 */
async function checkAVIFSupport(): Promise<boolean> {
  if (typeof window === 'undefined') return false;

  return new Promise((resolve) => {
    const avif = new Image();
    avif.onload = avif.onerror = () => {
      resolve(avif.height === 2);
    };
    avif.src = 'data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAAB0AAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAIAAAACAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQ0MAAAAABNjb2xybmNseAACAAIAAYAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAACVtZGF0EgAKCBgANogQEAwgMg8f8D///8WfhwB8+ErK42A=';
  });
}

/**
 * 初始化格式支持检测
 */
export async function initImageFormatSupport(): Promise<void> {
  imageFormatSupport.webp = await checkWebPSupport();
  imageFormatSupport.avif = await checkAVIFSupport();

  console.log('📷 图片格式支持:', {
    webp: imageFormatSupport.webp ? '✅' : '❌',
    avif: imageFormatSupport.avif ? '✅' : '❌',
  });
}

/**
 * 获取优化后的图片 URL
 * 自动选择最佳格式（AVIF > WebP > 原始格式）
 */
export function getOptimizedImageUrl(
  baseUrl: string,
  options: {
    width?: number;
    quality?: number;
    format?: 'auto' | 'webp' | 'avif' | 'original';
  } = {}
): string {
  const { width, quality = 80, format = 'auto' } = options;

  // 如果是数据 URL 或外部 URL，直接返回
  if (baseUrl.startsWith('data:') || baseUrl.startsWith('http://') || baseUrl.startsWith('https://')) {
    return baseUrl;
  }

  // 移除现有扩展名
  const urlWithoutExt = baseUrl.replace(/\.(jpg|jpeg|png|webp|avif)$/i, '');

  // 自动选择最佳格式
  let selectedFormat = format;
  if (format === 'auto') {
    if (imageFormatSupport.avif) {
      selectedFormat = 'avif';
    } else if (imageFormatSupport.webp) {
      selectedFormat = 'webp';
    } else {
      selectedFormat = 'original';
    }
  }

  // 构建优化后的 URL
  let optimizedUrl = urlWithoutExt;

  // 添加宽度后缀
  if (width) {
    optimizedUrl += `@${width}w`;
  }

  // 添加质量后缀
  if (quality !== 80) {
    optimizedUrl += `_q${quality}`;
  }

  // 添加格式扩展名
  switch (selectedFormat) {
    case 'avif':
      optimizedUrl += '.avif';
      break;
    case 'webp':
      optimizedUrl += '.webp';
      break;
    case 'original': {
      // 保持原始扩展名
      const match = baseUrl.match(/\.(jpg|jpeg|png|webp|avif)$/i);
      if (match) {
        optimizedUrl += match[0];
      }
      break;
    }
    default:
      break;
  }

  return optimizedUrl;
}

/**
 * 生成 srcset 字符串（响应式图片）
 */
export function generateSrcSet(
  baseUrl: string,
  widths: number[],
  options: {
    quality?: number;
    format?: 'auto' | 'webp' | 'avif' | 'original';
  } = {}
): string {
  return widths
    .map((width) => {
      const url = getOptimizedImageUrl(baseUrl, { ...options, width });
      return `${url} ${width}w`;
    })
    .join(', ');
}

/**
 * 生成 sizes 属性
 */
export function generateSizes(breakpoints: Array<{ maxWidth: string; size: string }>): string {
  return breakpoints
    .map(({ maxWidth, size }) => `(max-width: ${maxWidth}) ${size}`)
    .join(', ');
}

/**
 * 预加载关键图片
 */
export function preloadImage(url: string, options: { as?: string; fetchpriority?: 'high' | 'low' | 'auto' } = {}): void {
  if (typeof window === 'undefined') return;

  const link = document.createElement('link');
  link.rel = 'preload';
  link.as = options.as || 'image';
  link.href = url;

  if (options.fetchpriority) {
    link.setAttribute('fetchpriority', options.fetchpriority);
  }

  document.head.appendChild(link);
}

/**
 * 图片懒加载观察器
 */
export class ImageLazyLoader {
  private observer: IntersectionObserver | null = null;
  private images = new Set<HTMLImageElement>();

  constructor(options: IntersectionObserverInit = {}) {
    if (typeof window === 'undefined' || !('IntersectionObserver' in window)) {
      return;
    }

    this.observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const img = entry.target as HTMLImageElement;
            this.loadImage(img);
            this.observer?.unobserve(img);
            this.images.delete(img);
          }
        });
      },
      {
        rootMargin: '50px',
        threshold: 0.01,
        ...options,
      }
    );
  }

  observe(img: HTMLImageElement): void {
    if (!this.observer) {
      // 降级：直接加载
      this.loadImage(img);
      return;
    }

    this.images.add(img);
    this.observer.observe(img);
  }

  unobserve(img: HTMLImageElement): void {
    if (this.observer) {
      this.observer.unobserve(img);
      this.images.delete(img);
    }
  }

  disconnect(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.images.clear();
    }
  }

  private loadImage(img: HTMLImageElement): void {
    const src = img.dataset.src;
    const srcset = img.dataset.srcset;

    if (src) {
      img.src = src;
      delete img.dataset.src;
    }

    if (srcset) {
      img.srcset = srcset;
      delete img.dataset.srcset;
    }

    const picture = img.closest('picture');
    picture?.querySelectorAll<HTMLSourceElement>('source[data-srcset]').forEach(source => {
      source.srcset = source.dataset.srcset ?? '';
      delete source.dataset.srcset;
    });

    img.classList.remove('lazy-loading');
    img.classList.add('lazy-loaded');
  }
}

/**
 * 全局懒加载观察器实例
 */
export const globalImageLazyLoader = new ImageLazyLoader();

/**
 * 图片加载状态
 */
export type ImageLoadState = 'idle' | 'loading' | 'loaded' | 'error';

/**
 * 图片加载 Hook 辅助类型
 */
export interface ImageLoadResult {
  state: ImageLoadState;
  error: Error | null;
}

/**
 * 加载图片并返回 Promise
 */
export function loadImage(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}
