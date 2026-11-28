// CHASING 共享行程抓取脚本
// 每小时由 GitHub Actions 运行一次，输出 data/events.json。
// 只用 Node 内置功能，不装任何依赖包。
//
// 数据源（最终清单，共 5 个，Weverse / Threads 不在内——IVE 没有这两个的官方账号）：
//   1. X（付费，按量）：IVE 官方 X 账号 @IVEstarship 的新帖，$0.005/条，用 since_id 只拉新帖。
//   2. IVE 官网（免费）：抓官网公告/行程页 HTML。本环境无法直接访问该站，
//      未能核实其行程页结构——模块按通用文本解析写，抓不到就记日志跳过，见 SETUP.md。
//   3. Starship 官网（免费）：调官网 GraphQL 接口查公告板，已实测可用。
//   4. YouTube（免费额度）：IVE 官方频道 @IVEstarship 新视频。
//   5. IG（付费，Apify）：Apify Instagram Profile Scraper，每 2 小时查一次最新 12 条。
//
// 每个来源都是独立函数，凭环境变量开关：没有对应的 token/key 就跳过、不报错。
// 状态文件 data/state.json 存 X 的 since_id、已解析的用户 ID、IG 上次检查时间，
// 随仓库提交，Actions 每次运行靠它接着上次继续拉。
//
// 诚实规则：只收有明确日期的内容；没有日期、时间或场地的一律写“未公布”/“待确认”，
//          绝不编造。自动抓到的条目标记 tags: ["自动抓取", "待核实"]。
// 失败策略：任何一个来源失败都只记日志、跳过该来源，绝不让整个脚本退出报错，
//          最差情况下只用人工文件也能产出合法的 events.json。

import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CURATED_PATH = path.join(ROOT, 'data', 'curated-events.json');
const STATE_PATH = path.join(ROOT, 'data', 'state.json');
const OUTPUT_PATH = path.join(ROOT, 'data', 'events.json');

// ---------- 可调配置（环境变量覆盖，不用改代码） ----------
// X：盯 @IVEstarship（公司官方账号，发公告行程；@IVE_twt 是成员账号，@IVEstarship_jp 是日本账号）
const X_USERNAME = process.env.X_USERNAME || 'IVEstarship';
const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN || '';
// IVE 官网：默认首页；若确认了行程页地址，在仓库 Secrets 或 workflow 里设 IVE_SITE_URL 覆盖。
const IVE_SITE_URL = process.env.IVE_SITE_URL || 'https://www.ive-starship.com/';
// IG 检查间隔（小时），默认 2。预算控制就调这里：改 4 小时用量减半，改 1 小时用量翻倍。
const IG_CHECK_INTERVAL_HOURS = Number(process.env.IG_CHECK_INTERVAL_HOURS || 2);
// Apify：官方 Actor apify/instagram-profile-scraper（input: usernames + resultsType:"posts" + resultsLimit）。
const APIFY_TOKEN = process.env.APIFY_TOKEN || '';
const APIFY_ACTOR_ID = process.env.APIFY_ACTOR_ID || 'apify/instagram-profile-scraper';
const IG_USERNAME = process.env.IG_USERNAME || 'ivestarship';
const IG_RESULTS_PER_RUN = 12; // 每次运行只取最新 12 条，控制费用
// YouTube：IVE 官方频道 @IVEstarship，频道 ID 2026-11-27 于 youtube.com/@IVEstarship
// 页面核实（标题 "IVE - YouTube"，规范链接 youtube.com/channel/UC-Fnix71vRP64WXeo0ikd0Q）。
const YOUTUBE_HANDLE = 'IVEstarship';
const YOUTUBE_CHANNEL_ID_FALLBACK = 'UC-Fnix71vRP64WXeo0ikd0Q';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';

const STARSHIP_GRAPHQL = 'https://starship-ent.com/graphql';

// 标题/简介里出现这些词才可能是行程（演唱会、签售、回归、颁奖等），缺一不可：
// 还必须同时出现明确日期，否则丢弃。
const SCHEDULE_KEYWORDS = [
  'concert', 'encore', 'tour', 'showcase', 'fan meeting', 'fanmeeting',
  'comeback', 'festival', 'awards', 'ceremony', 'pop-up', 'popup',
  'listening party', 'fansign',
  '演唱会', '安可', '巡演', '见面会', '回归', '音乐节', '颁奖', '快闪',
  '听歌会', '签售', '首演', '开唱', '개봉', '발매',
];

// 已知场馆（只在原文明确提到时才填，不猜）：
// 键是原文里会出现的词，值是 [城市, 场地, scope]
const KNOWN_VENUES = [
  ['KSPO', ['首尔', 'KSPO DOME', '韩国']],
  ['Gocheok', ['首尔', '高尺天空巨蛋 Gocheok Sky Dome', '韩国']],
  ['高尺', ['首尔', '高尺天空巨蛋 Gocheok Sky Dome', '韩国']],
  ['KINTEX', ['高阳', 'KINTEX', '韩国']],
  ['MUFG', ['东京', 'MUFG Stadium（日本国立竞技场）', '亚洲']],
  ['Tokyo Dome', ['东京', '东京巨蛋 Tokyo Dome', '亚洲']],
  ['Kaohsiung', ['高雄', '高雄国家体育场', '亚洲']],
  ['高雄', ['高雄', '高雄国家体育场', '亚洲']],
];

const MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12,
};

function log(...args) { console.log('[fetch-events]', ...args); }
function warn(...args) { console.warn('[fetch-events][warn]', ...args); }

function stripTags(s) {
  return (s || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#8211;/g, '-')
    .replace(/&#8212;/g, '-').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// 从文本里找明确日期。只返回能确定年月日的日期，否则返回 null（绝不猜）。
// 支持：2027-01-29 / 2027.01.29 / 2027/01/29 / January 29, 2027 / 29 January 2027 /
//      2027年1月29日 / 1月29日 / 11월 29일（韩文“月日”，年份取参考日期的年份）。
function extractDate(text, refDate) {
  if (!text) return null;
  const t = text;
  let m = t.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  if (m) {
    const d = toISO(+m[1], +m[2], +m[3]);
    if (d) return d;
  }
  m = t.match(/(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/i);
  if (m) {
    const month = MONTHS[m[1].toLowerCase()];
    const day = +m[2];
    let year = m[3] ? +m[3] : refDate.getUTCFullYear();
    let d = toISO(year, month, day);
    // 没写年份且按当年算已过去，就顺延到下一年（例如 11 月看到 "January 29"）。
    if (!m[3] && d && d < refDate.toISOString().slice(0, 10)) d = toISO(year + 1, month, day);
    if (d) return d;
  }
  m = t.match(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{4})/i);
  if (m) {
    const d = toISO(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
    if (d) return d;
  }
  m = t.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (m) {
    const d = toISO(+m[1], +m[2], +m[3]);
    if (d) return d;
  }
  m = t.match(/(\d{1,2})月(\d{1,2})日/);
  if (m) {
    let year = refDate.getUTCFullYear();
    let d = toISO(year, +m[1], +m[2]);
    if (d && d < refDate.toISOString().slice(0, 10)) d = toISO(year + 1, +m[1], +m[2]);
    if (d) return d;
  }
  // 韩文：11월 29일（年份取参考日期；若已过去则下一年）
  m = t.match(/(\d{1,2})월\s*(\d{1,2})일/);
  if (m) {
    let year = refDate.getUTCFullYear();
    let d = toISO(year, +m[1], +m[2]);
    if (d && d < refDate.toISOString().slice(0, 10)) d = toISO(year + 1, +m[1], +m[2]);
    if (d) return d;
  }
  return null;
}

function toISO(y, mo, d) {
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

function hasScheduleKeyword(text) {
  const lower = (text || '').toLowerCase();
  return SCHEDULE_KEYWORDS.some((k) => lower.includes(k.toLowerCase()));
}

function matchKnownVenue(text) {
  for (const [key, value] of KNOWN_VENUES) {
    if ((text || '').includes(key)) return value;
  }
  return null;
}

function makeAutoEvent({ id, star, title, date, sourceUrl, venueHint, sourceLabel }) {
  const [city, location, scope] = venueHint || ['待确认', '待确认（见来源链接）', '全球'];
  return {
    id,
    star,
    title: title.length > 80 ? title.slice(0, 77) + '…' : title,
    date,
    time: '未公布',
    location,
    scope,
    city,
    category: 'Kpop',
    tags: ['自动抓取', '待核实'],
    desc: `自动抓取（${sourceLabel}），未经人工核实，时间与场地以来源链接为准。`,
    address: location,
    route: ['时间与场地待官方公布，见来源链接'],
    ticket_url: sourceUrl,
    vote_url: 'https://www.mubeat.tv/',
    guide: {
      checklist: ['以来源链接的官方口径为准'],
      security: ['不要向陌生人转账购买，警惕假票'],
    },
  };
}

function validEvent(ev) {
  return ev && typeof ev.id === 'string' && ev.id &&
    typeof ev.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ev.date) &&
    typeof ev.title === 'string' && ev.title &&
    typeof ev.star === 'string' && ev.star;
}

async function fetchJson(url, options, timeoutMs = 20000) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ================= 来源 1：X（付费，按量） =================
// 官方 API v2，按量收费：读一条帖子 $0.005；24 小时内重复读取同一资源去重计费。
// 用 since_id 只拉新帖：IVE 官方账号一天约 1–3 条新帖，一个月约 $0.15–0.5。
// 需要 Secrets：X_BEARER_TOKEN（App-Only Bearer Token）。没有就跳过。
async function fetchX(state) {
  if (!X_BEARER_TOKEN) {
    log('X：无 X_BEARER_TOKEN，跳过。');
    return [];
  }
  const out = [];
  try {
    const headers = { Authorization: `Bearer ${X_BEARER_TOKEN}` };
    // 用户 ID 很稳定，解析一次后存 state，避免每次花 $0.010 重复解析。
    let userId = state.xUserId;
    if (!userId) {
      const u = await fetchJson(
        `https://api.x.com/2/users/by/username/${X_USERNAME}?user.fields=id`,
        { headers },
      );
      userId = u.data && u.data.id;
      if (!userId) { warn('X：解析用户 ID 失败，跳过。'); return []; }
      state.xUserId = userId;
    }
    // 只拉原创帖（排除转推与回复），最多 10 条；since_id 让每次只返回上次之后的新帖。
    let url = `https://api.x.com/2/users/${userId}/tweets?max_results=10&exclude=retweets,replies&tweet.fields=created_at`;
    if (state.xSinceId) url += `&since_id=${encodeURIComponent(state.xSinceId)}`;
    const data = await fetchJson(url, { headers });
    if (data.errors) warn('X：API 返回错误：', JSON.stringify(data.errors).slice(0, 300));
    const tweets = (data.data || []).slice().reverse(); // 从旧到新处理
    let maxId = state.xSinceId;
    for (const tw of tweets) {
      if (maxId === null || BigInt(tw.id) > BigInt(maxId)) maxId = tw.id;
      const text = tw.text || '';
      if (!hasScheduleKeyword(text)) continue;
      const ref = tw.created_at ? new Date(tw.created_at) : new Date();
      const date = extractDate(text, ref);
      if (!date) continue; // 没有明确日期就不要，绝不编造。
      out.push(makeAutoEvent({
        id: `auto-x-${tw.id}`,
        star: 'IVE',
        title: text.replace(/\s+/g, ' ').trim(),
        date,
        sourceUrl: `https://x.com/${X_USERNAME}/status/${tw.id}`,
        venueHint: matchKnownVenue(text),
        sourceLabel: 'X @' + X_USERNAME,
      }));
    }
    state.xSinceId = maxId;
    log(`X：读到 ${tweets.length} 条新帖，新增 ${out.length} 条候选。`);
  } catch (e) {
    warn('X 抓取失败，跳过：', e.message);
  }
  return out;
}

// ================= 来源 2：IVE 官网（免费，HTML） =================
// 官网 https://www.ive-starship.com/ 在本环境无法直接访问（连接失败），
// 未能核实其行程页地址与页面结构。本模块按通用文本解析写：
// 抓首页 HTML，去标签后按行找“日期 + 行程关键词”同时出现的内容。
// 抓不到（连不上、空壳页、无匹配内容）就记日志跳过，不编数据。
// 若确认了行程页地址，把 IVE_SITE_URL 环境变量设为该地址即可。
async function fetchIveSite() {
  const out = [];
  try {
    const res = await fetch(IVE_SITE_URL, {
      headers: { 'User-Agent': 'CHASING-events-bot/1.0 (+https://laicheukwan.github.io/chasing-app/)' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) { warn(`IVE 官网返回 HTTP ${res.status}，跳过。`); return []; }
    const html = await res.text();
    const text = stripTags(html);
    if (text.length < 200) {
      warn('IVE 官网返回内容过少（可能是 JS 空壳页），本次抓不到，跳过。');
      return [];
    }
    // 按句切分：只有同时含日期与行程关键词的句子才可能是行程。
    const now = new Date();
    const sentences = text.split(/(?<=[。!?\n])\s+/);
    for (const s of sentences) {
      if (!hasScheduleKeyword(s)) continue;
      const date = extractDate(s, now);
      if (!date) continue;
      const d = new Date(date + 'T00:00:00Z');
      if (d - now > 90 * 24 * 3600 * 1000 || now - d > 2 * 24 * 3600 * 1000) continue;
      out.push(makeAutoEvent({
        id: `auto-ive-${Buffer.from(s.slice(0, 60)).toString('base64url').slice(0, 12)}`,
        star: 'IVE',
        title: s.trim().slice(0, 80),
        date,
        sourceUrl: IVE_SITE_URL,
        venueHint: matchKnownVenue(s),
        sourceLabel: 'IVE 官网',
      }));
    }
    log(`IVE 官网：新增 ${out.length} 条候选。`);
  } catch (e) {
    warn('IVE 官网抓取失败（本环境连不上该站也属正常），跳过：', e.message);
  }
  return out;
}

// ================= 来源 3：Starship 官网（免费，GraphQL） =================
// 官网是 React 单页应用，首屏 HTML 是空壳，公告走 GraphQL 接口：
//   POST https://starship-ent.com/graphql
//   query Query($category, $artist, $page, $pageSize, $search) {
//     listBoard(...) { boards { id title date } totalCount } }
//   query Query($category, $id) {
//     viewBoard(...) { id date title desc } }
// 2026-11-27 实测可用：listBoard(category:"notice") 返回真实公告；
// artist:"IVE" 返回空（该参数不按此匹配），故改为取最新 20 条公告、按标题含
// IVE/아이브 过滤，再调 viewBoard 取正文找行程日期。
async function fetchStarship() {
  const out = [];
  try {
    const gql = async (query, variables) => fetchJson(STARSHIP_GRAPHQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'CHASING-events-bot/1.0' },
      body: JSON.stringify({ query, variables }),
    });
    const list = await gql(
      'query Query($category: String, $page: Int, $pageSize: Int) { listBoard(category: $category, page: $page, pageSize: $pageSize) { boards { id title date } totalCount } }',
      { category: 'notice', page: 1, pageSize: 20 },
    );
    const boards = (list.data && list.data.listBoard && list.data.listBoard.boards) || [];
    const now = new Date();
    for (const b of boards) {
      if (!/ive|아이브/i.test(b.title || '')) continue;
      // 公告日期 45 天内的才看，避免翻旧闻。
      const pub = b.date ? new Date(String(b.date).replace(/\./g, '-')) : null;
      if (pub && !Number.isNaN(pub.getTime()) && now - pub > 45 * 24 * 3600 * 1000) continue;
      let detail = null;
      try {
        const d = await gql(
          'query Query($category: String, $id: Int) { viewBoard(category: $category, id: $id) { id date title desc } }',
          { category: 'notice', id: b.id },
        );
        detail = d.data && d.data.viewBoard;
      } catch (e) { warn(`Starship 公告 ${b.id} 详情读取失败，跳过：`, e.message); continue; }
      if (!detail) continue;
      const text = `${detail.title || ''}\n${detail.desc || ''}`;
      if (!hasScheduleKeyword(text)) continue;
      const ref = pub && !Number.isNaN(pub.getTime()) ? pub : now;
      const date = extractDate(text, ref);
      if (!date) continue; // 没有明确的行程日期就不要。
      out.push(makeAutoEvent({
        id: `auto-starship-${b.id}`,
        star: 'IVE',
        title: (detail.title || b.title).trim(),
        date,
        sourceUrl: `https://www.starship-ent.com/board/notice/${b.id}`,
        venueHint: matchKnownVenue(text),
        sourceLabel: 'Starship 官网公告',
      }));
    }
    log(`Starship 官网：最新 ${boards.length} 条公告中 IVE 相关新增 ${out.length} 条候选。`);
  } catch (e) {
    warn('Starship 官网抓取失败，跳过：', e.message);
  }
  return out;
}

// ================= 来源 4：YouTube（免费额度） =================
// IVE 官方频道 @IVEstarship，频道 ID 2026-11-27 于频道页核实。
// 需要 Secrets：YOUTUBE_API_KEY。没有就跳过。
async function fetchYouTube() {
  if (!YOUTUBE_API_KEY) {
    log('YouTube：无 YOUTUBE_API_KEY，跳过。');
    return [];
  }
  const out = [];
  try {
    let channelId = YOUTUBE_CHANNEL_ID_FALLBACK;
    try {
      const r = await fetch(
        `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${YOUTUBE_HANDLE}&key=${YOUTUBE_API_KEY}`,
      );
      const j = await r.json();
      if (j.items && j.items[0] && j.items[0].id) channelId = j.items[0].id;
    } catch (e) { warn('YouTube 解析频道 ID 失败，用兜底常量：', e.message); }

    // 查官方频道最新视频（100 单位/次，每小时跑一次约 2400 单位/天，免费额度 10000/天）。
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&type=video&order=date&maxResults=10&key=${YOUTUBE_API_KEY}`,
    );
    const data = await res.json();
    if (data.error) {
      warn('YouTube API 返回错误：', data.error.message || JSON.stringify(data.error));
      return [];
    }
    const now = new Date();
    for (const item of data.items || []) {
      const s = item.snippet || {};
      const published = new Date(s.publishedAt || now);
      // 只看最近 30 天的视频，避免把旧视频翻出来当新行程。
      if (now - published > 30 * 24 * 3600 * 1000) continue;
      const text = `${s.title || ''} ${s.description || ''}`;
      if (!hasScheduleKeyword(text)) continue;
      const date = extractDate(text, published);
      if (!date) continue; // 没有明确日期就不要，绝不编造。
      out.push(makeAutoEvent({
        id: `auto-yt-${item.id.videoId}`,
        star: 'IVE',
        title: (s.title || 'IVE 官方视频').trim(),
        date,
        sourceUrl: `https://www.youtube.com/watch?v=${item.id.videoId}`,
        venueHint: matchKnownVenue(text),
        sourceLabel: 'YouTube @' + YOUTUBE_HANDLE,
      }));
    }
    log(`YouTube：新增 ${out.length} 条候选。`);
  } catch (e) {
    warn('YouTube 抓取失败，跳过：', e.message);
  }
  return out;
}

// ================= 来源 5：IG（付费，Apify） =================
// Apify 官方 Actor apify/instagram-profile-scraper，input：
//   { usernames: ["ivestarship"], resultsType: "posts", resultsLimit: 12 }
// 每次运行返回账号最新 12 条帖子。费用：$2.30/1,000 条结果；
// 每 2 小时跑一次：12 条 × 12 次/天 × 30 天 ≈ 4,320 条/月 ≈ $10，
// 在 Starter $19/月（含 $19 用量）额度内。间隔由 IG_CHECK_INTERVAL_HOURS 控制。
// 需要 Secrets：APIFY_TOKEN。没有就跳过。API 文档：
//   POST /v2/acts/{actor}/runs → 轮询运行状态 → GET /v2/datasets/{id}/items
// 注意：这是非官方抓取——Instagram 官方不允许拉取他人账号帖子，
// 第三方监控可能不稳定、被限流或封禁，抓到的数据只当“待核实”的补充。
async function fetchInstagram(state) {
  if (!APIFY_TOKEN) {
    log('IG：无 APIFY_TOKEN，跳过。');
    return [];
  }
  const now = Date.now();
  const last = state.igLastCheck ? new Date(state.igLastCheck).getTime() : 0;
  if (now - last < IG_CHECK_INTERVAL_HOURS * 3600 * 1000) {
    log(`IG：距上次检查不足 ${IG_CHECK_INTERVAL_HOURS} 小时，跳过（控费）。`);
    return [];
  }
  const out = [];
  try {
    const actorPath = APIFY_ACTOR_ID.replace('/', '~');
    const startRes = await fetch(
      `https://api.apify.com/v2/acts/${actorPath}/runs?token=${APIFY_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          usernames: [IG_USERNAME],
          resultsType: 'posts',
          resultsLimit: IG_RESULTS_PER_RUN,
        }),
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!startRes.ok) throw new Error(`启动运行失败 HTTP ${startRes.status}`);
    const run = await startRes.json();
    const runId = run.data && run.data.id;
    const datasetId = run.data && run.data.defaultDatasetId;
    if (!runId || !datasetId) throw new Error('Apify 未返回运行 ID 或数据集 ID');

    // 轮询运行状态，最多约 5 分钟。
    let status = '';
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 15000));
      const s = await fetchJson(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`, {}, 20000);
      status = s.data && s.data.status;
      if (status === 'SUCCEEDED' || status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') break;
    }
    if (status !== 'SUCCEEDED') {
      warn(`IG：Apify 运行未成功（状态 ${status}），跳过，本次不更新检查时间，下次再试。`);
      return [];
    }
    const items = await fetchJson(
      `https://api.apify.com/v2/datasets/${datasetId}/items?format=json&limit=${IG_RESULTS_PER_RUN}&token=${APIFY_TOKEN}`,
      {}, 30000,
    );
    const ref = new Date();
    for (const it of Array.isArray(items) ? items : []) {
      const caption = it.caption || '';
      const text = `${caption}`;
      if (!hasScheduleKeyword(text)) continue;
      const published = it.timestamp ? new Date(it.timestamp) : ref;
      const date = extractDate(text, published);
      if (!date) continue; // 没有明确日期就不要。
      const shortcode = it.shortCode || it.id || '';
      out.push(makeAutoEvent({
        id: `auto-ig-${shortcode || Buffer.from(it.url || caption.slice(0, 40)).toString('base64url').slice(0, 12)}`,
        star: 'IVE',
        title: caption.replace(/\s+/g, ' ').trim().slice(0, 80) || 'IVE Instagram 帖子',
        date,
        sourceUrl: it.url || `https://www.instagram.com/${IG_USERNAME}/`,
        venueHint: matchKnownVenue(text),
        sourceLabel: 'Instagram @' + IG_USERNAME + '（Apify）',
      }));
    }
    state.igLastCheck = new Date().toISOString();
    log(`IG：读到 ${Array.isArray(items) ? items.length : 0} 条帖子，新增 ${out.length} 条候选。`);
  } catch (e) {
    warn('IG 抓取失败，跳过：', e.message);
  }
  return out;
}

// ================= 合并与输出 =================
function dedupe(curated, auto) {
  const seen = new Set();
  const result = [];
  for (const ev of curated) {
    if (!validEvent(ev)) { warn('人工文件里有字段不全的条目，已跳过：', JSON.stringify(ev).slice(0, 120)); continue; }
    if (seen.has(ev.id)) continue;
    seen.add(ev.id);
    result.push(ev);
  }
  for (const ev of auto) {
    if (!validEvent(ev)) continue;
    if (seen.has(ev.id)) continue; // 人工优先：同 id 的自动条目丢弃。
    // 同一天 + 标题高度重合，视为同一行程，人工优先。
    const clash = result.some((c) => c.date === ev.date &&
      c.title.replace(/[^A-Za-z0-9]/g, '').toLowerCase().slice(0, 12) ===
      ev.title.replace(/[^A-Za-z0-9]/g, '').toLowerCase().slice(0, 12));
    if (clash) continue;
    seen.add(ev.id);
    result.push(ev);
  }
  result.sort((a, b) => a.date.localeCompare(b.date));
  return result;
}

async function readState() {
  try {
    const raw = JSON.parse(await readFile(STATE_PATH, 'utf-8'));
    return {
      xUserId: raw.xUserId || null,
      xSinceId: raw.xSinceId || null,
      igLastCheck: raw.igLastCheck || null,
    };
  } catch {
    return { xUserId: null, xSinceId: null, igLastCheck: null };
  }
}

async function writeState(state) {
  const payload = {
    note: '抓取状态文件：X 的 since_id 与已解析用户 ID、IG 上次检查时间存在这里，随仓库提交，Actions 每次运行靠它接着上次继续拉。不要手动改（除非想重拉：把 xSinceId 清空、igLastCheck 清空即可）。',
    ...state,
    updatedAt: new Date().toISOString(),
  };
  const tmp = STATE_PATH + '.tmp';
  await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  await rename(tmp, STATE_PATH);
}

async function main() {
  let curated = [];
  try {
    const raw = JSON.parse(await readFile(CURATED_PATH, 'utf-8'));
    curated = Array.isArray(raw.events) ? raw.events : [];
    log(`人工文件：${curated.length} 条。`);
  } catch (e) {
    warn('读 curated-events.json 失败（文件不存在或格式错误），只用自动来源：', e.message);
  }

  const state = await readState();

  // 每个来源独立开关：缺 token/key 就跳过，互不影响。
  const results = await Promise.allSettled([
    fetchX(state),
    fetchIveSite(),
    fetchStarship(),
    fetchYouTube(),
    fetchInstagram(state),
  ]);
  const autoEvents = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) autoEvents.push(...r.value);
    else if (r.status === 'rejected') warn('某个来源异常退出：', r.reason && r.reason.message);
  }

  const merged = dedupe(curated, autoEvents);

  const payload = {
    updatedAt: new Date().toISOString(),
    source: 'CHASING 共享行程数据：人工核实文件（data/curated-events.json）+ 自动抓取（X @IVEstarship / IVE 官网 / Starship 官网公告 / YouTube @IVEstarship / Instagram @ivestarship）合并而成，人工条目优先。每小时由 GitHub Actions 自动更新。Weverse / Threads 不在来源内（IVE 没有这两个的官方账号）。',
    stars: ['IVE'],
    events: merged,
  };
  const tmp = OUTPUT_PATH + '.tmp';
  await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  await rename(tmp, OUTPUT_PATH);
  await writeState(state);
  log(`完成：共 ${merged.length} 条（人工 ${curated.length} 条，自动新增 ${merged.length - curated.length} 条），已写入 data/events.json。`);
}

main().catch((e) => {
  // 最后一道防线：即使合并失败也不要让 Action 报错中断，
  // 保持上一次的 events.json 不变，下次再跑。
  console.error('[fetch-events][error]', e);
  process.exit(0);
});
