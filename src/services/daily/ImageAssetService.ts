import fs from 'fs/promises';
import path from 'path';
import type { DailyRssItem } from './RssDailyService.js';

export interface ImageProcessResult {
  itemId: string;
  originalUrl: string;
  resolvedUrl?: string;
  localPath?: string;
  status: 'saved' | 'removed' | 'skipped';
  error?: string;
}

export interface ProcessDailyImagesOptions {
  date: string;
  assetsRootDir?: string;
  markdownPrefix?: string;
  fetchImpl?: typeof fetch;
}

const extensionByMime: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
};

export function resolveImageUrl(imageUrl: string, articleUrl: string): string | undefined {
  if (!imageUrl) return undefined;
  if (imageUrl.startsWith('data:')) return imageUrl;

  try {
    return new URL(imageUrl, articleUrl).toString();
  } catch {
    return undefined;
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'image';
}

function extensionFromUrl(url: string): string {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return ext && ext.length <= 6 ? ext : '';
  } catch {
    return '';
  }
}

function extensionFromContentType(contentType: string | null, url: string): string {
  const mime = (contentType || '').split(';')[0].trim().toLowerCase();
  return extensionByMime[mime] || extensionFromUrl(url) || '.jpg';
}

async function fetchImage(url: string, fetchImpl: typeof fetch): Promise<{ buffer: Buffer; contentType: string | null }> {
  const response = await fetchImpl(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 daily-rss-image-fetcher',
      Accept: 'image/avif,image/webp,image/png,image/jpeg,image/svg+xml,image/*,*/*;q=0.8',
      Referer: new URL(url).origin,
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type');
  if (contentType && !contentType.toLowerCase().startsWith('image/')) {
    throw new Error(`Not an image: ${contentType}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType,
  };
}

function markdownPath(prefix: string, date: string, filename: string): string {
  return `${prefix.replace(/\/$/, '')}/${date}/${filename}`;
}

export async function processDailyImages(
  items: DailyRssItem[],
  options: ProcessDailyImagesOptions
): Promise<{ items: DailyRssItem[]; results: ImageProcessResult[] }> {
  const fetchImpl = options.fetchImpl || fetch;
  const assetsRootDir = options.assetsRootDir || 'daily-assets';
  const markdownPrefix = options.markdownPrefix || '/daily-assets';
  const targetDir = path.join(assetsRootDir, options.date);
  const processedItems: DailyRssItem[] = [];
  const results: ImageProcessResult[] = [];

  await fs.mkdir(targetDir, { recursive: true });

  for (const item of items) {
    if (!item.imageUrl) {
      processedItems.push(item);
      continue;
    }

    const originalUrl = item.imageUrl;
    const resolvedUrl = resolveImageUrl(originalUrl, item.url);
    if (!resolvedUrl || resolvedUrl.startsWith('data:')) {
      processedItems.push({ ...item, imageUrl: undefined });
      results.push({ itemId: item.id, originalUrl, resolvedUrl, status: 'removed', error: 'Unsupported image URL' });
      continue;
    }

    try {
      const { buffer, contentType } = await fetchImage(resolvedUrl, fetchImpl);
      const ext = extensionFromContentType(contentType, resolvedUrl);
      const filename = `${slugify(item.sourceName)}-${slugify(item.id)}${ext}`;
      const filePath = path.join(targetDir, filename);
      await fs.writeFile(filePath, buffer);

      const localPath = markdownPath(markdownPrefix, options.date, filename);
      processedItems.push({ ...item, imageUrl: localPath });
      results.push({ itemId: item.id, originalUrl, resolvedUrl, localPath, status: 'saved' });
    } catch (error: any) {
      processedItems.push({ ...item, imageUrl: undefined });
      results.push({ itemId: item.id, originalUrl, resolvedUrl, status: 'removed', error: error?.message || String(error) });
    }
  }

  return { items: processedItems, results };
}
