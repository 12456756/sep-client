/**
 * 图片优化组件使用示例
 */

import { OptimizedImage, Picture, BackgroundImage } from '@/components/OptimizedImage';

/**
 * 基础用法示例
 */
export function BasicImageExample() {
  return (
    <div className="p-4 space-y-4">
      <h2 className="text-xl font-bold">基础用法</h2>

      {/* 简单的优化图片 */}
      <OptimizedImage
        src="/images/logo.png"
        alt="Logo"
        className="w-32 h-32"
      />

      {/* 禁用懒加载（关键图片） */}
      <OptimizedImage
        src="/images/hero.jpg"
        alt="Hero Image"
        lazy={false}
        priority="high"
        className="w-full"
      />

      {/* 指定质量 */}
      <OptimizedImage
        src="/images/thumbnail.jpg"
        alt="Thumbnail"
        quality={60}
        className="w-48"
      />
    </div>
  );
}

/**
 * 响应式图片示例
 */
export function ResponsiveImageExample() {
  return (
    <div className="p-4 space-y-4">
      <h2 className="text-xl font-bold">响应式图片</h2>

      {/* 响应式宽度 */}
      <OptimizedImage
        src="/images/product.jpg"
        alt="Product"
        widths={[320, 640, 960, 1280, 1920]}
        sizes={[
          { maxWidth: '640px', size: '100vw' },
          { maxWidth: '1024px', size: '50vw' },
          { maxWidth: '1536px', size: '33vw' },
        ]}
        className="w-full"
      />

      {/* 简化的 sizes 字符串 */}
      <OptimizedImage
        src="/images/banner.jpg"
        alt="Banner"
        widths={[640, 960, 1280]}
        sizes="(max-width: 768px) 100vw, 50vw"
        className="w-full"
      />
    </div>
  );
}

/**
 * Picture 组件示例（完整的现代格式支持）
 */
export function PictureExample() {
  return (
    <div className="p-4 space-y-4">
      <h2 className="text-xl font-bold">Picture 组件（多格式）</h2>

      {/* 自动生成 AVIF、WebP、原始格式 */}
      <Picture
        src="/images/photo.jpg"
        alt="Photo"
        widths={[640, 960, 1280]}
        quality={80}
        className="w-full"
      />

      {/* 不启用懒加载 */}
      <Picture
        src="/images/hero.jpg"
        alt="Hero"
        lazy={false}
        imgProps={{ className: 'w-full h-64 object-cover' }}
      />
    </div>
  );
}

/**
 * 背景图片示例
 */
export function BackgroundImageExample() {
  return (
    <div className="p-4 space-y-4">
      <h2 className="text-xl font-bold">背景图片</h2>

      {/* 懒加载背景图 */}
      <BackgroundImage
        src="/images/background.jpg"
        className="w-full h-64 flex items-center justify-center"
        quality={70}
      >
        <h3 className="text-white text-3xl font-bold">优化的背景图片</h3>
      </BackgroundImage>

      {/* 高质量背景图 */}
      <BackgroundImage
        src="/images/hero-bg.jpg"
        lazy={false}
        quality={90}
        className="w-full h-96 flex items-center justify-center"
      >
        <div className="text-center text-white">
          <h2 className="text-4xl font-bold mb-4">欢迎</h2>
          <p className="text-xl">使用优化的背景图片</p>
        </div>
      </BackgroundImage>
    </div>
  );
}

/**
 * 占位符示例
 */
export function PlaceholderExample() {
  return (
    <div className="p-4 space-y-4">
      <h2 className="text-xl font-bold">占位符效果</h2>

      {/* 空占位符 */}
      <OptimizedImage
        src="/images/large-image.jpg"
        alt="Large Image"
        placeholder="empty"
        className="w-full h-64 object-cover"
      />

      {/* 模糊占位符 */}
      <OptimizedImage
        src="/images/photo.jpg"
        alt="Photo"
        placeholder="blur"
        placeholderColor="#e0e0e0"
        className="w-full h-64 object-cover"
      />

      {/* 自定义占位符颜色 */}
      <OptimizedImage
        src="/images/artwork.jpg"
        alt="Artwork"
        placeholder="blur"
        placeholderColor="#3b82f6"
        className="w-full h-64 object-cover"
      />
    </div>
  );
}

/**
 * 员工头像示例（实际应用场景）
 */
export function EmployeeAvatarExample() {
  const employees = [
    { id: 1, name: '张三', avatar: '/avatars/zhang.jpg' },
    { id: 2, name: '李四', avatar: '/avatars/li.jpg' },
    { id: 3, name: '王五', avatar: '/avatars/wang.jpg' },
  ];

  return (
    <div className="p-4">
      <h2 className="text-xl font-bold mb-4">员工头像列表</h2>

      <div className="grid grid-cols-3 gap-4">
        {employees.map((employee) => (
          <div key={employee.id} className="text-center">
            <OptimizedImage
              src={employee.avatar}
              alt={employee.name}
              widths={[64, 128, 256]}
              quality={85}
              className="w-24 h-24 rounded-full mx-auto"
              placeholder="blur"
              placeholderColor="#ddd"
            />
            <p className="mt-2 text-sm">{employee.name}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 画廊示例（多图片场景）
 */
export function GalleryExample() {
  const images = [
    { id: 1, src: '/gallery/1.jpg', title: '图片 1' },
    { id: 2, src: '/gallery/2.jpg', title: '图片 2' },
    { id: 3, src: '/gallery/3.jpg', title: '图片 3' },
    { id: 4, src: '/gallery/4.jpg', title: '图片 4' },
    { id: 5, src: '/gallery/5.jpg', title: '图片 5' },
    { id: 6, src: '/gallery/6.jpg', title: '图片 6' },
  ];

  return (
    <div className="p-4">
      <h2 className="text-xl font-bold mb-4">图片画廊</h2>

      <div className="grid grid-cols-3 gap-4">
        {images.map((image) => (
          <div key={image.id} className="relative">
            <Picture
              src={image.src}
              alt={image.title}
              widths={[320, 640, 960]}
              quality={75}
              imgProps={{
                className: 'w-full h-48 object-cover rounded-lg',
              }}
            />
            <div className="mt-2 text-sm text-gray-600">{image.title}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 性能对比示例
 */
export function PerformanceComparisonExample() {
  return (
    <div className="p-4 space-y-8">
      <h2 className="text-xl font-bold">性能对比</h2>

      <div className="grid grid-cols-2 gap-8">
        {/* 未优化 */}
        <div>
          <h3 className="font-bold mb-2">未优化（原始 img）</h3>
          <img
            src="/images/large-photo.jpg"
            alt="Original"
            className="w-full h-64 object-cover"
          />
          <p className="mt-2 text-sm text-gray-600">
            - 固定格式（JPG/PNG）<br />
            - 无响应式<br />
            - 无懒加载<br />
            - 文件体积大
          </p>
        </div>

        {/* 优化后 */}
        <div>
          <h3 className="font-bold mb-2">优化后（OptimizedImage）</h3>
          <OptimizedImage
            src="/images/large-photo.jpg"
            alt="Optimized"
            widths={[320, 640, 960]}
            sizes="(max-width: 768px) 100vw, 50vw"
            quality={80}
            format="auto"
            placeholder="blur"
            className="w-full h-64 object-cover"
          />
          <p className="mt-2 text-sm text-green-600">
            ✅ 现代格式（AVIF/WebP）<br />
            ✅ 响应式加载<br />
            ✅ 懒加载<br />
            ✅ 体积减少 40-60%
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * 完整应用示例
 */
export function CompleteExample() {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Hero 区域 - 高优先级不懒加载 */}
      <BackgroundImage
        src="/images/hero.jpg"
        lazy={false}
        quality={90}
        className="h-96 flex items-center justify-center"
      >
        <h1 className="text-5xl font-bold text-white">欢迎使用优化图片</h1>
      </BackgroundImage>

      {/* 特色内容 */}
      <div className="container mx-auto py-12">
        <div className="grid grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-white rounded-lg shadow-lg overflow-hidden">
              <Picture
                src={`/images/feature-${i}.jpg`}
                alt={`Feature ${i}`}
                widths={[320, 640]}
                quality={80}
                imgProps={{ className: 'w-full h-48 object-cover' }}
              />
              <div className="p-4">
                <h3 className="font-bold mb-2">特色 {i}</h3>
                <p className="text-gray-600">使用优化的图片加载</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 画廊区域 - 懒加载 */}
      <div className="container mx-auto py-12">
        <h2 className="text-3xl font-bold mb-6">图片画廊</h2>
        <div className="grid grid-cols-4 gap-4">
          {Array.from({ length: 12 }, (_, i) => (
            <OptimizedImage
              key={i}
              src={`/images/gallery-${i + 1}.jpg`}
              alt={`Gallery ${i + 1}`}
              widths={[256, 512]}
              quality={75}
              placeholder="blur"
              className="w-full h-48 object-cover rounded"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
