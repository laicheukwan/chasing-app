# CHASING · 接 Google Maps 地图 Key 教程

> 现在的代码**不填 Key 也能用**（免 Key iframe 模式，已经在跑）。
> 只有想要「自定义标记 / 深色地图 / 路线绘制 / 换样式」时，才需要申请 Key。

---

## 一、你需要哪种 Key？

| 需求 | Key 类型 | 难度 | 费用 |
|---|---|---|---|
| 只嵌入地图看位置（当前功能） | **Maps Embed API** | ⭐ 最简单 | 免费额度很大 |
| 自定义标记、路线、深色样式、点击交互 | **Maps JavaScript API** | ⭐⭐ | 有免费额度，超出按量计费 |

**推荐先申请 Maps Embed API**，够用且最省钱。

代码里对应这一行（`index.html` 约第 1490 行附近）：

```js
const GMAPS_KEY = '';        // ← 把你的 Key 填在这两个引号中间
const GMAPS_MODE = 'embed';  // 'embed' = iframe 模式；'js' = JavaScript API 模式
```

---

## 二、申请步骤（5 分钟）

1. **打开 Google Cloud Console**
   <https://console.cloud.google.com/> → 用 Google 账号登录。

2. **创建项目**
   顶部项目下拉 → 「新建项目」→ 名字随便写（例如 `chasing-maps`）→ 创建。

3. **开启结算（必须）**
   Google Maps 现在要求绑定信用卡才能用，但**每月有免费额度**（Embed 模式基本用不到钱）。
   左侧「结算」→ 绑定信用卡 → 完成。（个人开发者可先绑，$200/月额度足够原型阶段）

4. **启用 API**
   左侧「API 和服务」→「库」→ 搜索下面这个并点击「启用」：
   - `Maps Embed API`（只嵌入地图选这个）
   - 如果要用高级功能，再启用 `Maps JavaScript API`

5. **创建 API 密钥**
   「API 和服务」→「凭据」→「创建凭据」→「API 密钥」→ 复制出现的字符串（形如 `YOUR_GOOGLE_MAPS_API_KEY...`）。

6. **限制密钥（强烈建议）**
   点刚创建的 Key →「编辑」：
   - **应用限制** → HTTP 来源 → 添加：
     ```
     http://localhost:8765/*
     https://你的正式域名/*
     ```
   - **API 限制** → 只勾选 `Maps Embed API`（或你实际启用的），其它全部取消。
   - 保存。这样别人拿到 Key 也用不了，防止被盗刷。

---

## 三、把 Key 填进代码

打开 `index.html`，找到：

```js
const GMAPS_KEY = '';
```

改成：

```js
const GMAPS_KEY = 'YOUR_GOOGLE_MAPS_API_KEY你的真实key';
```

保存 → 刷新页面（Ctrl+Shift+R）。
详情页 / 情报地图右下角会从「免 Key 模式」变成 **「Google Maps · 已启用 Key」**，说明生效了。

---

## 四、常见问题

**Q：不填 Key 现在能用吗？**
能。用的是 `maps.google.com/maps?...&output=embed`，不需要 Key，个人原型完全够用。

**Q：提示 "This API key is invalid / not authorized"？**
检查三件事：
1. 是否已启用 `Maps Embed API`；
2. 项目的**结算**是否已绑定信用卡（没绑定一定报错）；
3. 「应用限制」里的来源是否填了 `http://localhost:8765/*`（本地调试必须加）。

**Q：Key 会不会被偷？**
前端 Key 一定会出现在源码里，所以**必须做「应用限制 + API 限制」**。限制到具体域名 + 具体 API 后，即使被看到也无法滥用。

**Q：以后上线了怎么办？**
把正式域名加进「应用限制」的允许来源即可，不需要改代码。

**Q：想换成高德 / Mapbox / MapLibre（国内更稳）？**
告诉我，我可以把 `mapFrame()` 这一个函数换成对应实现，其它代码不用动。

---

## 五、想升级到「自定义标记 + 深色地图」？

告诉我一声，我帮你把下面这几件事做掉（需要 `Maps JavaScript API`）：

- 自定义品牌配色的地图样式（贴合现在的浅紫 UI）
- 多个场馆标记 + 点击弹出情报卡
- 从当前位置到场馆的路线绘制（Directions API，需要额外启用）
- 深色模式自动切换地图样式

现在代码里已经预留了 `GMAPS_MODE = 'js'` 的开关位置，加这个升级不需要重构页面。
