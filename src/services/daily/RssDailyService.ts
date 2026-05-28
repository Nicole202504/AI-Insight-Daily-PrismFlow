import fs from 'fs/promises';
import path from 'path';
import Parser from 'rss-parser';
import type { AIProvider } from '../AIProvider.js';
import { extractJson, getISODate, getRandomUserAgent, removeMarkdownCodeBlock, stripHtml, sleep } from '../../utils/helpers.js';
import { processDailyImages } from './ImageAssetService.js';

export type DailyRssSourceGroup = 'company' | 'practitioner' | 'community' | 'papers' | 'products' | 'github';

export interface DailyRssSource {
  id: string;
  name: string;
  url: string;
  group: DailyRssSourceGroup;
  enabled: boolean;
  priority?: number;
  maxItems?: number;
  timeoutMs?: number;
  retries?: number;
}

export interface DailyRssSummary {
  title_cn: string;
  summary_cn: string;
  why_it_matters?: string;
  tags?: string[];
  score?: number;
}

export interface DailyRssItem {
  id: string;
  title: string;
  url: string;
  description: string;
  content?: string;
  publishedAt: string;
  sourceName: string;
  sourceGroup: DailyRssSourceGroup;
  author?: string;
  imageUrl?: string;
  summary?: DailyRssSummary;
}

export interface DailyRssSourceStatus {
  sourceId: string;
  sourceName: string;
  status: 'success' | 'failed' | 'disabled';
  itemCount: number;
  finalUrl?: string;
  error?: string;
}

export interface FetchSourcesOptions {
  now?: Date;
  maxAgeDays?: number;
  fetchImpl?: typeof fetch;
}

export interface DailyMarkdownInput {
  date: string;
  items: DailyRssItem[];
  sourceStatuses: DailyRssSourceStatus[];
}

export interface SummarizeOptions {
  limit?: number;
  concurrency?: number;
  timeoutMs?: number;
}

const parser = new Parser({
  customFields: {
    item: [
      ['content:encoded', 'contentEncoded'],
      ['media:content', 'mediaContent'],
      ['media:thumbnail', 'mediaThumbnail'],
    ],
  },
});

const groupTitles: Record<DailyRssSourceGroup, string> = {
  company: '公司动态',
  practitioner: '从业者观点',
  community: '社区热点',
  papers: '论文与模型',
  products: '每日产品',
  github: 'GitHub 项目',
};

const groupOrder: DailyRssSourceGroup[] = ['company', 'products', 'github', 'practitioner', 'community', 'papers'];

function canonicalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.startsWith('utm_') || ['ref', 'source', 'campaign'].includes(key)) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return url.trim().replace(/\/$/, '');
  }
}

function stableId(sourceId: string, item: any): string {
  const key = item.guid || item.id || item.link || item.title || `${sourceId}-${Date.now()}`;
  return `${sourceId}:${Buffer.from(String(key)).toString('base64url').slice(0, 32)}`;
}

function extractImageUrl(item: any): string | undefined {
  const mediaContent = Array.isArray(item.mediaContent) ? item.mediaContent[0] : item.mediaContent;
  if (mediaContent?.$?.url) return mediaContent.$.url;
  const mediaThumbnail = Array.isArray(item.mediaThumbnail) ? item.mediaThumbnail[0] : item.mediaThumbnail;
  if (mediaThumbnail?.$?.url) return mediaThumbnail.$.url;
  const enclosure = item.enclosure;
  if (enclosure?.url && String(enclosure.type || '').startsWith('image/')) return enclosure.url;

  const html = item.contentEncoded || item.content || item.summary || '';
  const match = String(html).match(/<img[^>]+src=["']([^"']+)["']/i);
  return match?.[1];
}

function toItem(source: DailyRssSource, rawItem: any): DailyRssItem {
  const content = rawItem.contentEncoded || rawItem.content || rawItem.summary || rawItem.description || '';
  const description = stripHtml(rawItem.contentSnippet || rawItem.summary || rawItem.description || content).replace(/\s+/g, ' ').trim();
  const publishedAt = rawItem.isoDate || rawItem.pubDate || rawItem.published || new Date().toISOString();

  return {
    id: stableId(source.id, rawItem),
    title: rawItem.title || '无标题',
    url: rawItem.link || rawItem.guid || '',
    description,
    content: stripHtml(content).replace(/\s+/g, ' ').trim(),
    publishedAt,
    sourceName: source.name,
    sourceGroup: source.group,
    author: rawItem.creator || rawItem.author || rawItem['dc:creator'],
    imageUrl: extractImageUrl(rawItem),
  };
}

function isRecent(item: DailyRssItem, now: Date, maxAgeDays: number): boolean {
  const publishedTime = new Date(item.publishedAt).getTime();
  if (Number.isNaN(publishedTime)) return true;
  return now.getTime() - publishedTime <= maxAgeDays * 24 * 60 * 60 * 1000;
}

async function fetchWithTimeout(url: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': getRandomUserAgent(),
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOneSource(
  source: DailyRssSource,
  options: Required<Pick<FetchSourcesOptions, 'now' | 'maxAgeDays' | 'fetchImpl'>>
): Promise<{ items: DailyRssItem[]; status: DailyRssSourceStatus }> {
  if (!source.enabled) {
    return {
      items: [],
      status: { sourceId: source.id, sourceName: source.name, status: 'disabled', itemCount: 0 },
    };
  }

  const attempts = Math.max(1, source.retries || 1);
  const timeoutMs = source.timeoutMs || 15000;
  let lastError = '';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchWithTimeout(source.url, timeoutMs, options.fetchImpl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const xml = await response.text();
      const feed = await parser.parseString(xml);
      const items = (feed.items || [])
        .map((item) => toItem(source, item))
        .filter((item) => item.url && isRecent(item, options.now, options.maxAgeDays))
        .slice(0, source.maxItems || 10);

      return {
        items,
        status: {
          sourceId: source.id,
          sourceName: source.name,
          status: 'success',
          itemCount: items.length,
          finalUrl: response.url || source.url,
        },
      };
    } catch (error: any) {
      lastError = error?.message || String(error);
      if (attempt < attempts) {
        await sleep(Math.min(1000 * attempt, 3000));
      }
    }
  }

  return {
    items: [],
    status: {
      sourceId: source.id,
      sourceName: source.name,
      status: 'failed',
      itemCount: 0,
      error: lastError,
    },
  };
}

export async function fetchSources(
  sources: DailyRssSource[],
  options: FetchSourcesOptions = {}
): Promise<{ items: DailyRssItem[]; statuses: DailyRssSourceStatus[] }> {
  const effectiveOptions = {
    now: options.now || new Date(),
    maxAgeDays: options.maxAgeDays ?? 3,
    fetchImpl: options.fetchImpl || fetch,
  };

  const results = await Promise.all(sources.map((source) => fetchOneSource(source, effectiveOptions)));
  const items = dedupeItems(results.flatMap((result) => result.items));
  return {
    items,
    statuses: results.map((result) => result.status),
  };
}

export function dedupeItems(items: DailyRssItem[]): DailyRssItem[] {
  const seen = new Set<string>();
  const deduped: DailyRssItem[] = [];

  for (const item of items) {
    const key = item.url ? canonicalizeUrl(item.url) : item.title.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

function renderItem(item: DailyRssItem, index: number): string {
  const title = item.summary?.title_cn || item.title;
  const summary = item.summary?.summary_cn || item.description || item.content || '暂无摘要。';
  const why = item.summary?.why_it_matters ? `\n\n   **为什么重要：** ${item.summary.why_it_matters}` : '';
  const tags = item.summary?.tags?.length ? `\n\n   标签：${item.summary.tags.map((tag) => `\`${tag}\``).join(' ')}` : '';
  const image = item.imageUrl ? `\n\n   ![${escapeMarkdownCell(title)}](${item.imageUrl})` : '';

  return `${index}. **[${title}](${item.url})**\n\n   ${summary}${why}${tags}${image}\n\n   来源：${item.sourceName}`;
}

export function renderDailyMarkdown(input: DailyMarkdownInput): string {
  const lines: string[] = [
    `# AI 资讯日报 ${input.date}`,
    '',
    '> 自动抓取 AI 公司博客、从业者博客与社区聚合源，并生成中文摘要。',
    '',
    '## 今日摘要',
    '',
  ];

  const topItems = input.items.slice(0, 5);
  if (topItems.length === 0) {
    lines.push('今日没有抓取到可用内容。', '');
  } else {
    lines.push('```');
    for (const item of topItems) {
      lines.push(`- ${item.summary?.title_cn || item.title}`);
    }
    lines.push('```', '');
  }

  for (const group of groupOrder) {
    const groupedItems = input.items.filter((item) => item.sourceGroup === group);
    if (groupedItems.length === 0) continue;

    lines.push(`## ${groupTitles[group]}`, '');
    groupedItems.forEach((item, idx) => {
      lines.push(renderItem(item, idx + 1), '');
    });
  }

  const failed = input.sourceStatuses.filter((status) => status.status === 'failed');
  lines.push('---', '', '## 抓取状态', '');
  lines.push('| 源 | 状态 | 条目数 | 备注 |');
  lines.push('| --- | --- | ---: | --- |');
  for (const status of input.sourceStatuses) {
    lines.push(`| ${escapeMarkdownCell(status.sourceName)} | ${status.status} | ${status.itemCount} | ${escapeMarkdownCell(status.error || status.finalUrl || '')} |`);
  }

  if (failed.length > 0) {
    lines.push('', `> 本次有 ${failed.length} 个源抓取失败，日报以降级模式生成。`);
  }

  return `${lines.join('\n').trim()}\n`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function buildSummaryPrompt(item: DailyRssItem): string {
  const content = [item.title, item.description, item.content].filter(Boolean).join('\n\n').slice(0, 5000);
  return `请把下面这条英文 AI 资讯整理为中文日报条目。只输出 JSON，不要输出解释。

JSON 字段：
- title_cn: 中文标题，18 字以内
- summary_cn: 中文摘要，80-160 字
- why_it_matters: 为什么重要，50 字以内
- tags: 2-5 个中文标签数组
- score: 1-10 的重要性分数

来源：${item.sourceName}
链接：${item.url}
内容：
${content}`;
}

export async function summarizeItems(
  items: DailyRssItem[],
  aiProvider?: AIProvider,
  options: SummarizeOptions = {}
): Promise<DailyRssItem[]> {
  if (!aiProvider) return items;
  const provider = aiProvider;

  const limit = options.limit ?? 20;
  const timeoutMs = options.timeoutMs ?? 45000;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, 8));
  const result: DailyRssItem[] = [...items];
  const targetItems = items.slice(0, limit);
  let nextIndex = 0;

  async function summarizeOne(item: DailyRssItem): Promise<DailyRssItem> {
    try {
      const response = await withTimeout(
        provider.generateContent(buildSummaryPrompt(item), [], '你是专业的中文 AI 行业日报编辑。'),
        timeoutMs,
        `AI summary for ${item.title}`
      );
      const parsed = extractJson<DailyRssSummary>(removeMarkdownCodeBlock(response.content));
      return parsed ? { ...item, summary: parsed } : item;
    } catch {
      return item;
    }
  }

  async function worker() {
    while (nextIndex < targetItems.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      result[currentIndex] = await summarizeOne(targetItems[currentIndex]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, targetItems.length) }, () => worker()));
  return result;
}

export async function generateDailyMarkdown(options: {
  sources: DailyRssSource[];
  date?: string;
  outputDir?: string;
  aiProvider?: AIProvider;
  maxAgeDays?: number;
  summaryLimit?: number;
  summaryConcurrency?: number;
  summaryTimeoutMs?: number;
  dryRun?: boolean;
  processImages?: boolean;
  assetsRootDir?: string;
  imageMarkdownPrefix?: string;
}): Promise<{ markdown: string; filePath?: string; itemCount: number; statuses: DailyRssSourceStatus[] }> {
  const date = options.date || getISODate();
  const { items, statuses } = await fetchSources(options.sources, { maxAgeDays: options.maxAgeDays ?? 3 });
  const sortedItems = items.sort((a, b) => {
    const priorityA = options.sources.find((source) => source.name === a.sourceName)?.priority || 0;
    const priorityB = options.sources.find((source) => source.name === b.sourceName)?.priority || 0;
    return priorityB - priorityA || new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
  });
  const summarizedItems = await summarizeItems(sortedItems, options.aiProvider, {
    limit: options.summaryLimit ?? 20,
    concurrency: options.summaryConcurrency ?? 3,
    timeoutMs: options.summaryTimeoutMs ?? 45000,
  });
  const finalItems = options.processImages === false
    ? summarizedItems
    : (await processDailyImages(summarizedItems, {
      date,
      assetsRootDir: options.assetsRootDir || 'daily-assets',
      markdownPrefix: options.imageMarkdownPrefix || '/daily-assets',
    })).items;
  const markdown = renderDailyMarkdown({ date, items: finalItems, sourceStatuses: statuses });

  if (options.dryRun) {
    return { markdown, itemCount: finalItems.length, statuses };
  }

  const outputDir = options.outputDir || 'daily';
  await fs.mkdir(outputDir, { recursive: true });
  const filePath = path.join(outputDir, `${date}.md`);
  await fs.writeFile(filePath, markdown, 'utf-8');
  return { markdown, filePath, itemCount: finalItems.length, statuses };
}
