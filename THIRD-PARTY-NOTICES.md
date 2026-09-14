# 第三方素材与许可

本文件列出随客户端一起分发的第三方素材及其许可要求。代码依赖的许可见各自
`node_modules/<package>/LICENSE`，此处只记录**有署名义务**的素材。

## 员工头像画片 — ToonHead

- 使用位置：`src/components/enterprise/EmployeeFace.tsx`（员工卡、员工页、抽屉、账号头像）
- 分发方式：`@dicebear/toon-head`，在本机按员工 id 生成 SVG，不联网、不上传任何数据
- 代码许可：MIT，Copyright (c) 2026 Florian Körner
- 画片许可：**CC BY 4.0**

  > Design "ToonHead" by Johan Melin, licensed under CC BY 4.0. Remix of the original.
  > Source: https://www.figma.com/community/file/1589627891082866389
  > Homepage: https://www.johanmelin.com
  > License: https://creativecommons.org/licenses/by/4.0/

CC BY 4.0 要求保留署名。除本文件外，署名信息也由 DiceBear 写进每一张生成的 SVG 的
`<metadata>` 块里，随界面一起分发 —— 换头像风格时不要顺手把那段 metadata 剥掉。

如果将来需要完全免署名的方案，DiceBear 里 `lorelei`、`open-peeps`、`notionists`
这几套是纯 MIT，但都是扁平线稿，和现在这套立体感半身像不是一个观感。
