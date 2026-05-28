import 'dotenv/config';
import { GeminiProvider } from '../services/AIProvider.js';
import { ApimartGeminiProvider } from '../services/daily/ApimartGeminiProvider.js';
import { generateDailyMarkdown } from '../services/daily/RssDailyService.js';
import { DEFAULT_DAILY_RSS_SOURCES } from '../services/daily/rssDailySources.js';

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function createGeminiProvider() {
  const apimartKey = process.env.APIMART_API_KEY;
  if (apimartKey) {
    return new ApimartGeminiProvider(
      process.env.APIMART_BASE_URL || 'https://api.apimart.ai/v1beta',
      apimartKey,
      process.env.APIMART_MODEL || 'gemini-3.5-flash'
    );
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return undefined;

  return new GeminiProvider(
    process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com',
    apiKey,
    process.env.GEMINI_MODEL || 'gemini-2.5-flash'
  );
}

async function main() {
  const date = getArg('date');
  const outputDir = getArg('output-dir') || 'daily';
  const dryRun = hasFlag('dry-run');
  const noAi = hasFlag('no-ai');
  const noImages = hasFlag('no-images');
  const summaryLimit = Number(getArg('summary-limit') || process.env.DAILY_SUMMARY_LIMIT || '999');
  const maxAgeDays = Number(getArg('max-age-days') || '3');
  const assetsRootDir = getArg('assets-dir') || process.env.DAILY_ASSETS_DIR || 'daily-assets';
  const imageMarkdownPrefix = getArg('image-prefix') || process.env.DAILY_IMAGE_PREFIX || '/daily-assets';

  const aiProvider = noAi ? undefined : createGeminiProvider();
  if (!aiProvider && !noAi) {
    console.warn('[daily:rss] APIMART_API_KEY/GEMINI_API_KEY not set; generating without AI summaries. Use --no-ai to silence this.');
  }

  const result = await generateDailyMarkdown({
    sources: DEFAULT_DAILY_RSS_SOURCES,
    date,
    outputDir,
    aiProvider,
    summaryLimit,
    maxAgeDays,
    processImages: !noImages,
    assetsRootDir,
    imageMarkdownPrefix,
    dryRun,
  });

  if (dryRun) {
    console.log(result.markdown);
  } else {
    console.log(`[daily:rss] Generated ${result.filePath} with ${result.itemCount} items.`);
  }

  const failed = result.statuses.filter((status) => status.status === 'failed');
  if (failed.length > 0) {
    console.warn(`[daily:rss] ${failed.length} source(s) failed: ${failed.map((status) => status.sourceName).join(', ')}`);
  }
}

main().catch((error) => {
  console.error(`[daily:rss] Failed: ${error?.message || error}`);
  process.exitCode = 1;
});
