/**
 * 优化的图片组件
 * 支持懒加载、响应式、现代格式、渐进式加载
 */

import { useEffect, useRef, useState } from 'react';
import type { ImgHTMLAttributes } from 'react';
import {
  getOptimizedImageUrl,
  generateSrcSet,
  generateSizes,
  globalImageLazyLoader,
  type ImageLoadState,
} from '@/utils/image-optimization';

export interface OptimizedImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet' | 'sizes' | 'onLoad' | 'onError'> {
  /** 图片 URL */
  src: string;
  /** 替代文本 */
  alt: string;
  /** 是否启用懒加载（默认 true） */
  lazy?: boolean;
  /** 响应式宽度断点 */
  widths?: number[];
  /** 响应式尺寸配置 */
  sizes?: Array<{ maxWidth: string; size: string }> | string;
  /** 图片质量 (1-100，默认 80) */
  quality?: number;
  /** 强制指定格式 */
  format?: 'auto' | 'webp' | 'avif' | 'original';
  /** 加载优先级 */
  priority?: 'high' | 'low' | 'auto';
  /** 占位符类型 */
  placeholder?: 'blur' | 'empty';
  /** 模糊占位符颜色 */
  placeholderColor?: string;
  /** 加载时回调 */
  onLoad?: () => void;
  /** 错误时回调 */
  onError?: (error: Error) => void;
}

/**
 * 优化的图片组件
 */
export function OptimizedImage({
  src,
  alt,
  lazy = true,
  widths,
  sizes,
  quality = 80,
  format = 'auto',
  priority = 'auto',
  placeholder = 'empty',
  placeholderColor = '#f0f0f0',
  onLoad,
  onError,
  className = '',
  style,
  ...props
}: OptimizedImageProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [loadState, setLoadState] = useState<ImageLoadState>('idle');

  // 生成优化后的 URL
  const optimizedSrc = getOptimizedImageUrl(src, { quality, format });

  // 生成 srcset（响应式）
  const srcSet = widths ? generateSrcSet(src, widths, { quality, format }) : undefined;

  // 生成 sizes 字符串
  const sizesStr = sizes
    ? typeof sizes === 'string'
      ? sizes
      : generateSizes(sizes)
    : undefined;

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;

    // 高优先级图片不懒加载
    if (priority === 'high' || !lazy) {
      setLoadState('loading');
      return;
    }

    // 懒加载
    setLoadState('idle');
    globalImageLazyLoader.observe(img);

    return () => {
      globalImageLazyLoader.unobserve(img);
    };
  }, [lazy, priority]);

  const handleLoad = () => {
    setLoadState('loaded');
    onLoad?.();
  };

  const handleError = () => {
    setLoadState('error');
    onError?.(new Error(`Failed to load image: ${src}`));
  };

  // 懒加载时使用 data-src
  const imgProps = lazy && priority !== 'high'
    ? {
        'data-src': optimizedSrc,
        'data-srcset': srcSet,
        src: placeholder === 'blur'
          ? `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 300'%3E%3Crect fill='${encodeURIComponent(placeholderColor)}' width='400' height='300'/%3E%3C/svg%3E`
          : undefined,
      }
    : {
        src: optimizedSrc,
        srcSet: srcSet,
      };

  const combinedClassName = [
    className,
    lazy && loadState === 'idle' && 'lazy-loading',
    loadState === 'loaded' && 'lazy-loaded',
    loadState === 'error' && 'lazy-error',
  ]
    .filter(Boolean)
    .join(' ');

  const combinedStyle = {
    ...style,
    backgroundColor: placeholder === 'blur' && loadState !== 'loaded' ? placeholderColor : undefined,
    transition: 'opacity 0.3s ease-in-out',
    opacity: loadState === 'loaded' ? 1 : loadState === 'loading' ? 0.5 : 1,
  };

  return (
    <img
      ref={imgRef}
      alt={alt}
      className={combinedClassName}
      style={combinedStyle}
      sizes={sizesStr}
      loading={lazy && priority !== 'high' ? 'lazy' : 'eager'}
      fetchPriority={priority}
      onLoad={handleLoad}
      onError={handleError}
      {...imgProps}
      {...props}
    />
  );
}

/**
 * 带源集的 Picture 组件（完整的现代图片格式支持）
 */
export interface PictureProps {
  /** 图片 URL */
  src: string;
  /** 替代文本 */
  alt: string;
  /** 响应式宽度断点 */
  widths?: number[];
  /** 图片质量 */
  quality?: number;
  /** 是否启用懒加载 */
  lazy?: boolean;
  /** 类名 */
  className?: string;
  /** 样式 */
  style?: React.CSSProperties;
  /** img 标签的其他属性 */
  imgProps?: ImgHTMLAttributes<HTMLImageElement>;
}

/**
 * Picture 组件（自动生成多格式源）
 */
export function Picture({
  src,
  alt,
  widths = [640, 750, 828, 1080, 1200],
  quality = 80,
  lazy = true,
  className,
  style,
  imgProps = {},
}: PictureProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [loadState, setLoadState] = useState<ImageLoadState>('idle');

  // AVIF 源
  const avifSrcSet = generateSrcSet(src, widths, { quality, format: 'avif' });

  // WebP 源
  const webpSrcSet = generateSrcSet(src, widths, { quality, format: 'webp' });

  // 原始格式源（降级）
  const fallbackSrc = getOptimizedImageUrl(src, { quality, format: 'original' });
  const fallbackSrcSet = generateSrcSet(src, widths, { quality, format: 'original' });

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;

    if (lazy) {
      globalImageLazyLoader.observe(img);
      return () => {
        globalImageLazyLoader.unobserve(img);
      };
    }
  }, [lazy]);

  const handleLoad = () => {
    setLoadState('loaded');
  };

  const handleError = () => {
    setLoadState('error');
  };

  return (
    <picture className={className} style={style}>
      {/* AVIF 源（最高优先级） */}
      <source
        type="image/avif"
        srcSet={lazy ? undefined : avifSrcSet}
        data-srcset={lazy ? avifSrcSet : undefined}
      />

      {/* WebP 源 */}
      <source
        type="image/webp"
        srcSet={lazy ? undefined : webpSrcSet}
        data-srcset={lazy ? webpSrcSet : undefined}
      />

      {/* 降级到原始格式 */}
      <img
        ref={imgRef}
        src={lazy ? undefined : fallbackSrc}
        srcSet={lazy ? undefined : fallbackSrcSet}
        data-src={lazy ? fallbackSrc : undefined}
        data-srcset={lazy ? fallbackSrcSet : undefined}
        alt={alt}
        loading={lazy ? 'lazy' : 'eager'}
        onLoad={handleLoad}
        onError={handleError}
        className={loadState === 'loaded' ? 'lazy-loaded' : 'lazy-loading'}
        {...imgProps}
      />
    </picture>
  );
}

/**
 * 背景图片组件
 */
export interface BackgroundImageProps {
  /** 图片 URL */
  src: string;
  /** 子元素 */
  children?: React.ReactNode;
  /** 类名 */
  className?: string;
  /** 样式 */
  style?: React.CSSProperties;
  /** 图片质量 */
  quality?: number;
  /** 图片格式 */
  format?: 'auto' | 'webp' | 'avif' | 'original';
  /** 是否启用懒加载 */
  lazy?: boolean;
}

/**
 * 优化的背景图片组件
 */
export function BackgroundImage({
  src,
  children,
  className = '',
  style = {},
  quality = 80,
  format = 'auto',
  lazy = true,
}: BackgroundImageProps) {
  const [loaded, setLoaded] = useState(!lazy);
  const divRef = useRef<HTMLDivElement>(null);

  const optimizedSrc = getOptimizedImageUrl(src, { quality, format });

  useEffect(() => {
    if (!lazy) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setLoaded(true);
            observer.disconnect();
          }
        });
      },
      { rootMargin: '50px' }
    );

    if (divRef.current) {
      observer.observe(divRef.current);
    }

    return () => observer.disconnect();
  }, [lazy]);

  const combinedStyle: React.CSSProperties = {
    ...style,
    backgroundImage: loaded ? `url(${optimizedSrc})` : undefined,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundColor: loaded ? undefined : '#f0f0f0',
  };

  return (
    <div ref={divRef} className={className} style={combinedStyle}>
      {children}
    </div>
  );
}
