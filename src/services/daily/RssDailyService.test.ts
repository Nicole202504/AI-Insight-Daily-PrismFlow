import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeItems,
  renderDailyMarkdown,
  fetchSources,
  type DailyRssItem,
  type DailyRssSource,
} from './RssDailyService.js';

const sampleDate = '2026-05-28';

test('dedupeItems keeps one item per canonical URL', () => {
  const items: DailyRssItem[] = [
    {
      id: '1',
      title: 'OpenAI ships something',
      url: 'https://openai.com/news/example?utm_source=x',
      description: 'First copy',
      publishedAt: sampleDate,
      sourceName: 'OpenAI Blog',
      sourceGroup: 'company',
    },
    {
      id: '2',
      title: 'OpenAI ships something',
      url: 'https://openai.com/news/example',
      description: 'Duplicate copy',
      publishedAt: sampleDate,
      sourceName: 'OpenAI Blog',
      sourceGroup: 'company',
    },
  ];

  assert.equal(dedupeItems(items).length, 1);
});

test('renderDailyMarkdown groups items by source group with Chinese headings', () => {
  const markdown = renderDailyMarkdown({
    date: sampleDate,
    items: [
      {
        id: 'company-1',
        title: 'OpenAI update',
        url: 'https://openai.com/news/example',
        description: 'A company update',
        publishedAt: sampleDate,
        sourceName: 'OpenAI Blog',
        sourceGroup: 'company',
        summary: {
          title_cn: 'OpenAI 发布更新',
          summary_cn: 'OpenAI 发布了一项值得关注的产品更新。',
          why_it_matters: '这会影响开发者的产品路线。',
          tags: ['OpenAI'],
          score: 8,
        },
      },
      {
        id: 'community-1',
        title: 'HN discusses agents',
        url: 'https://news.ycombinator.com/item?id=1',
        description: 'A community discussion',
        publishedAt: sampleDate,
        sourceName: 'Hacker News AI',
        sourceGroup: 'community',
      },
    ],
    sourceStatuses: [],
  });

  assert.match(markdown, /# AI 资讯日报 2026-05-28/);
  assert.match(markdown, /## 公司动态/);
  assert.match(markdown, /## 社区热点/);
  assert.match(markdown, /OpenAI 发布更新/);
  assert.match(markdown, /HN discusses agents/);
});

test('fetchSources returns successful items and failed source status without throwing', async () => {
  const sources: DailyRssSource[] = [
    {
      id: 'good',
      name: 'Good Feed',
      url: 'https://example.test/good.xml',
      group: 'company',
      enabled: true,
      retries: 1,
      timeoutMs: 100,
      maxItems: 5,
    },
    {
      id: 'bad',
      name: 'Bad Feed',
      url: 'https://example.test/bad.xml',
      group: 'community',
      enabled: true,
      retries: 1,
      timeoutMs: 100,
      maxItems: 5,
    },
  ];

  const result = await fetchSources(sources, {
    now: new Date(`${sampleDate}T08:00:00+08:00`),
    fetchImpl: async (url) => {
      if (String(url).includes('bad')) {
        throw new Error('network down');
      }
      return new Response(`<?xml version="1.0"?>
        <rss version="2.0"><channel><title>Good Feed</title>
          <item><title>Item A</title><link>https://example.test/a</link><description>Hello</description><pubDate>Thu, 28 May 2026 00:00:00 GMT</pubDate></item>
        </channel></rss>`, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
    },
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.statuses.find((status) => status.sourceId === 'good')?.status, 'success');
  assert.equal(result.statuses.find((status) => status.sourceId === 'bad')?.status, 'failed');
});
