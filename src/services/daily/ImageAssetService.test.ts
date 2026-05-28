import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { processDailyImages, resolveImageUrl } from './ImageAssetService.js';
import type { DailyRssItem } from './RssDailyService.js';

test('resolveImageUrl resolves relative image paths against article URL', () => {
  assert.equal(
    resolveImageUrl('rankings_052526.png', 'https://minimaxir.com/2026/05/openrouter-hy3/'),
    'https://minimaxir.com/2026/05/openrouter-hy3/rankings_052526.png'
  );
});

test('processDailyImages downloads image assets and rewrites item imageUrl', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-assets-test-'));
  const items: DailyRssItem[] = [
    {
      id: 'item-1',
      title: 'Image item',
      url: 'https://example.test/posts/one/',
      description: 'Has image',
      publishedAt: '2026-05-28',
      sourceName: 'Example',
      sourceGroup: 'company',
      imageUrl: 'cover.png',
    },
  ];

  const processed = await processDailyImages(items, {
    date: '2026-05-28',
    assetsRootDir: tempDir,
    markdownPrefix: 'daily-assets',
    fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }),
  });

  assert.equal(processed.items[0].imageUrl, 'daily-assets/2026-05-28/example-item-1.png');
  assert.equal(processed.results[0].status, 'saved');
  const saved = await fs.readFile(path.join(tempDir, '2026-05-28', 'example-item-1.png'));
  assert.deepEqual([...saved], [1, 2, 3]);
});

test('processDailyImages removes inaccessible images without throwing', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-assets-test-'));
  const items: DailyRssItem[] = [
    {
      id: 'item-2',
      title: 'Bad image item',
      url: 'https://example.test/posts/two/',
      description: 'Has bad image',
      publishedAt: '2026-05-28',
      sourceName: 'Example',
      sourceGroup: 'company',
      imageUrl: 'https://example.test/missing.jpg',
    },
  ];

  const processed = await processDailyImages(items, {
    date: '2026-05-28',
    assetsRootDir: tempDir,
    fetchImpl: async () => new Response('not found', { status: 404 }),
  });

  assert.equal(processed.items[0].imageUrl, undefined);
  assert.equal(processed.results[0].status, 'removed');
});
