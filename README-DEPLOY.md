# CHASING 合并版 · 2026-11-27 20:29

以用户 20:28 发来的 chasing-app.zip（Claude 最新版）为底，在上面合了三样东西，Claude 的 UI 改动都保留了。

## 合了什么
1. Logo 定稿：品牌色 #567ACE
   - 侧栏：SVG 星星 + CHASING 文字 → 02 版 logo.png（白字 + 蓝 SING）
   - favicon：新增 icons/icon-192.png（TODO P0-1 完成）
   - App 图标：01 版四张 icons/icon-192 / 512 / 512-maskable / 180
   - 全站主色：紫色 #7b6ef0 → #567ACE（深色模式 #7ea3e8），共 21 处
2. PWA：Claude 那版已经加了 manifest + sw.js（theme #567ACE、chasing-v1），这次没动它，只补齐了它引用的、zip 里缺的文件：icons/、logo.png
3. 共享数据：加回 loadSharedEvents()，启动先渲染本地，再读 data/events.json（9 条 IVE 行程），读到就替换、读不到保持本地不变。data/events.json、data/curated-events.json、data/state.json、scripts/fetch-events.mjs、.github/workflows/update-events.yml 都在包里。

## 保留了 Claude 的改动
- 全站搜索/筛选增强（互助页搜艺人/场馆、周边价格区间 & 面交城市筛选）
- 粉丝团卡片横向滑动压缩
- PWA 的 manifest / sw.js 原样保留

## 放进仓库（直接替换 laicheukwan/chasing-app 的 main 分支）
把这个文件夹里的全部文件按同样路径放进去，根目录 index.html / manifest.webmanifest / sw.js / logo.png，icons/、data/、scripts/、.github/ 整个文件夹。
仓库 Settings → Actions → General → Workflow permissions → Read and write permissions → Save（每小时自动更新才推得上去）。
等约 1 分钟让 Pages 重新部署。

## 本地验过（2026-11-27）
- index / manifest / logo / 4 张图标 / sw.js / data/events.json 全部 200
- manifest、events.json 是合法 JSON，sw.js 通过 node --check
- diff 对 Claude 版只有 102 行，全是上面三项，没有删 Claude 的搜索/筛选代码
