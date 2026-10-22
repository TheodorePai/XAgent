import { AgentBrowser } from '@mastra/agent-browser';
import { lookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
export interface BrowserScope {
  runId: string; mode: 'mock' | 'deepseek'; destination: string;
  trace: { tool: string; sourceIds?: string[] }[];
}

export interface WebSource { id: string; title: string; url: string; text: string; kind: 'search' | 'page'; fetchedAt: string }
export interface WebImage { id: string; url: string; sourceId: string; sourcePage: string; caption: string; width: number; height: number }
interface Session { browser?: AgentBrowser; sources: Map<string, WebSource>; images: Map<string, WebImage>; calls: number; queue: Promise<unknown> }
const sessions = new WeakMap<BrowserScope, Session>();
const id = (prefix: string, url: string) => prefix + createHash('sha256').update(url).digest('hex').slice(0, 12);
const contentDomains = ['gov.cn', 'news.cn', 'xinhuanet.com', 'people.com.cn', 'chinanews.com', 'chinanews.com.cn', 'cnr.cn', 'yanjinews.com', 'ybnews.cn', 'sohu.com', 'news.qq.com', 'thepaper.cn', 'ctnews.com.cn', 'ce.cn'];
export function allowedContentURL(value: string) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
    contentDomains.some(d => u.hostname === d || u.hostname.endsWith('.' + d)); } catch { return false; }
}
function publicAddress(value: string) {
  if (value.includes(':')) return value.startsWith('2') || value.startsWith('3');
  const p = value.split('.').map(Number);
  return p.length === 4 && ![0, 10, 127].includes(p[0]) && p[0] < 224 &&
    !(p[0] === 169 && p[1] === 254) && !(p[0] === 172 && p[1] >= 16 && p[1] <= 31) &&
    !(p[0] === 192 && p[1] === 168) && !(p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}
function session(scope: BrowserScope) {
  let s = sessions.get(scope);
  if (!s) { s = { sources: new Map(), images: new Map(), calls: 0, queue: Promise.resolve() }; sessions.set(scope, s); }
  return s;
}
async function browser(scope: BrowserScope) {
  const s = session(scope);
  if (++s.calls > 8) throw new Error('BROWSER_CALL_BUDGET_EXCEEDED');
  if (!s.browser) {
    s.browser = new AgentBrowser({ headless: true, scope: 'thread', timeout: 15000,
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
    s.browser.setCurrentThread(scope.runId);
    await s.browser.ensureReady();
    const manager = await s.browser.getManagerForThread(scope.runId);
    const cache = new Map<string, boolean>();
    await manager.getContext()!.route('**/*', async route => {
      try {
        const request = route.request(), u = new URL(request.url());
        if (!['http:', 'https:'].includes(u.protocol) || request.method() !== 'GET' || u.username || u.password ||
            (u.port && !['80', '443'].includes(u.port)) || ['font', 'media'].includes(request.resourceType())) return await route.abort();
        let allowed = cache.get(u.hostname);
        if (allowed === undefined) {
          const addresses = await lookup(u.hostname, { all: true });
          allowed = addresses.length > 0 && addresses.every(a => publicAddress(a.address)); cache.set(u.hostname, allowed);
        }
        if (!allowed) return await route.abort();
        await route.continue();
      } catch { await route.abort().catch(() => {}); }
    });
  }
  return s.browser;
}
function source(scope: BrowserScope, title: string, url: string, text: string, kind: WebSource['kind']) {
  const item = { id: id('S-', url), title: title.slice(0, 200), url, text: text.slice(0, 4500), kind, fetchedAt: new Date().toISOString() };
  const s = session(scope), old = s.sources.get(item.id);
  if (!old || kind === 'page') s.sources.set(item.id, item);
  return s.sources.get(item.id)!;
}
const searchScript = `Array.from(document.querySelectorAll('#b_results li.b_algo')).map(n=>({title:n.querySelector('h2')?.textContent||'',url:n.querySelector('h2 a')?.href||'',text:n.querySelector('.b_caption p')?.textContent||n.textContent.slice(0,600)})).slice(0,10)`;
const pageScript = `({title:document.title,text:(document.querySelector('article')||document.querySelector('.TRS_Editor')||document.querySelector('#zoom')||document.body).innerText.slice(0,4500),images:Array.from(document.images).filter(i=>i.naturalWidth>=300&&i.naturalHeight>=150).slice(0,12).map(i=>({url:i.currentSrc||i.src,caption:i.alt||i.title||document.title,width:i.naturalWidth,height:i.naturalHeight}))})`;

async function doSearch(scope: BrowserScope, query: string) {
  if (scope.mode === 'mock') {
    const title = scope.destination + '旅游资料[MOCK]';
    const results = [1, 2].map(n => source(scope, title, `https://www.jl.gov.cn/mock-travel-${n}`, `${title}，景点${n}，只用于脚本测试。`, 'search'));
    scope.trace.push({ tool: 'browserSearch', sourceIds: results.map(s => s.id) }); return { simulated: true, results };
  }
  const b = await browser(scope);
  const navigation = await b.goto({ url: 'https://www.bing.com/search?q=' + encodeURIComponent(query), waitUntil: 'domcontentloaded', timeout: 18000 }, scope.runId);
  if (!navigation.success) throw new Error('BROWSER_SEARCH_NAVIGATION_FAILED');
  const extracted = await b.evaluate({ script: searchScript }, scope.runId);
  if (!extracted.success || !Array.isArray(extracted.result)) throw new Error('BROWSER_SEARCH_EXTRACTION_FAILED');
  const results: WebSource[] = [];
  for (const item of extracted.result as { title: string; url: string; text: string }[]) {
    let url = item.url;
    try {
      const link = new URL(url), encoded = link.searchParams.get('u');
      if (link.hostname.endsWith('bing.com') && encoded?.startsWith('a1')) url = Buffer.from(encoded.slice(2), 'base64url').toString();
    } catch { continue; }
    if (allowedContentURL(url)) results.push(source(scope, item.title, url, item.text, 'search'));
  }
  scope.trace.push({ tool: 'browserSearch', sourceIds: results.map(s => s.id) });
  return { provider: 'mastra-agent-browser', results: results.slice(0, 6), note: '仅保留政府和指定公共新闻来源；搜索摘要不是网页全文。没有结果时换用带 site:gov.cn 的查询。' };
}
async function doRead(scope: BrowserScope, sourceId: string) {
  const original = session(scope).sources.get(sourceId);
  if (!original) throw new Error('SOURCE_NOT_DISCOVERED_IN_THIS_RUN');
  if (scope.mode === 'mock') {
    const item = source(scope, original.title, original.url, original.text + ' 适合安排步行、美食和文化体验。', 'page');
    const image: WebImage = { id: id('I-', original.url), url: original.url + '.jpg', sourceId, sourcePage: original.url, caption: '[MOCK] 测试图片', width: 800, height: 600 };
    session(scope).images.set(image.id, image); scope.trace.push({ tool: 'browserRead', sourceIds: [sourceId] }); return { simulated: true, ...item };
  }
  const b = await browser(scope);
  const navigation = await b.goto({ url: original.url, waitUntil: 'domcontentloaded', timeout: 18000 }, scope.runId);
  if (!navigation.success || !allowedContentURL(navigation.url)) return { error: 'PAGE_UNAVAILABLE', sourceId };
  const manager = await b.getManagerForThread(scope.runId);
  await manager.getPage().waitForLoadState('load', { timeout: 4500 }).catch(() => {});
  const extracted = await b.evaluate({ script: pageScript }, scope.runId);
  if (!extracted.success) return { error: 'PAGE_EXTRACTION_FAILED', sourceId };
  const data = extracted.result as { title: string; text: string; images: { url: string; caption: string; width: number; height: number }[] };
  if (data.text.length < 100 || /访问验证|安全验证|验证码/.test(data.title)) return { error: 'PAGE_ACCESS_RESTRICTED', sourceId };
  const item = source(scope, data.title, navigation.url, data.text, 'page');
  for (const image of data.images) {
    try {
      const u = new URL(image.url);
      if (u.protocol !== 'https:' || u.username || u.password || u.port) continue;
      const value = { ...image, caption: image.caption.slice(0, 300), id: id('I-', image.url), sourceId: item.id, sourcePage: navigation.url };
      session(scope).images.set(value.id, value);
    } catch { /* malformed image URL */ }
  }
  scope.trace.push({ tool: 'browserRead', sourceIds: [item.id] }); return item;
}
export function browserImages(scope: BrowserScope) {
  scope.trace.push({ tool: 'browserImages' });
  return { images: [...session(scope).images.values()].slice(0, 8), note: '实际网页加载的图片；caption 来自网页，不代表模型已目视核验。保留 sourcePage，使用授权未另行确认。' };
}
export function webEvidence(scope: BrowserScope) { return session(scope); }
function serial<T>(scope: BrowserScope, action: () => Promise<T>): Promise<T> {
  const s = session(scope), next = s.queue.then(action);
  s.queue = next.catch(() => {}); return next;
}
export function browserSearch(scope: BrowserScope, query: string) { return serial(scope, () => doSearch(scope, query)); }
export function browserRead(scope: BrowserScope, sourceId: string) { return serial(scope, () => doRead(scope, sourceId)); }
export async function closeBrowser(scope: BrowserScope) {
  const s = sessions.get(scope); if (s) await s.queue;
  sessions.delete(scope);
  if (s?.browser) await s.browser.close().catch(() => {});
}
