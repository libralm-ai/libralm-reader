/**
 * RSS Engine - Feed fetching and parsing
 * Handles RSS 2.0 and Atom feeds using rss-parser
 */
import Parser from 'rss-parser';
import TurndownService from 'turndown';
import { getStorage, type RssFeed, type RssArticle } from '../storage/index.js';

// ============================================================================
// Types
// ============================================================================

export interface ParsedFeed {
  title: string;
  description?: string;
  link?: string;
  iconUrl?: string;
  items: ParsedArticle[];
}

export interface ParsedArticle {
  guid: string;
  title: string;
  link?: string;
  author?: string;
  pubDate?: string;
  summary?: string;
  content?: string;
}

export interface FeedWithArticles extends RssFeed {
  articles: RssArticle[];
  unreadCount: number;
}

// ============================================================================
// Parser Setup
// ============================================================================

const parser = new Parser({
  timeout: 30000, // 30 second timeout
  headers: {
    'User-Agent': 'LibraLM-Reader/2.0 (RSS Reader)',
    'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml',
  },
  customFields: {
    item: [
      ['content:encoded', 'contentEncoded'],
      ['dc:creator', 'dcCreator'],
    ],
  },
});

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
});

// Remove script/style tags before conversion
turndown.remove(['script', 'style', 'noscript', 'iframe']);

// ============================================================================
// Feed Cache
// ============================================================================

interface CachedFeed {
  parsed: ParsedFeed;
  fetchedAt: number;
}

const feedCache = new Map<string, CachedFeed>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function cleanCache(): void {
  const now = Date.now();
  for (const [key, value] of feedCache.entries()) {
    if (now - value.fetchedAt > CACHE_TTL) {
      feedCache.delete(key);
    }
  }
}

setInterval(cleanCache, 60 * 1000); // Clean every minute

// ============================================================================
// Feed Fetching
// ============================================================================

/**
 * Fetch and parse an RSS/Atom feed from a URL
 */
export async function fetchFeed(url: string, useCache = true): Promise<ParsedFeed> {
  // Check cache
  if (useCache) {
    const cached = feedCache.get(url);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
      return cached.parsed;
    }
  }

  try {
    const feed = await parser.parseURL(url);

    const parsed: ParsedFeed = {
      title: feed.title || extractDomainName(url),
      description: feed.description,
      link: feed.link,
      iconUrl: feed.image?.url,
      items: feed.items.map((item) => ({
        guid: item.guid || item.link || item.title || crypto.randomUUID(),
        title: item.title || 'Untitled',
        link: item.link,
        author: item.creator || (item as { dcCreator?: string }).dcCreator || (item as { author?: string }).author,
        pubDate: item.pubDate || item.isoDate,
        summary: cleanHtml(item.contentSnippet || item.summary || ''),
        content: cleanHtml(
          (item as { contentEncoded?: string }).contentEncoded ||
          item.content ||
          item.summary ||
          ''
        ),
      })),
    };

    // Update cache
    feedCache.set(url, { parsed, fetchedAt: Date.now() });

    return parsed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch feed: ${message}`);
  }
}

/**
 * Subscribe to a new feed - fetches, parses, and stores it
 */
export async function subscribeFeed(url: string): Promise<FeedWithArticles> {
  const storage = getStorage();

  // Check if already subscribed
  const existing = storage.getFeedByUrl(url);
  if (existing) {
    // Refresh the existing feed instead
    return refreshFeed(existing.id);
  }

  // Fetch and parse the feed
  const parsed = await fetchFeed(url, false);

  // Store the feed
  const feed = storage.addFeed({
    url,
    title: parsed.title,
    description: parsed.description,
    iconUrl: parsed.iconUrl,
    lastFetched: new Date().toISOString(),
  });

  // Store articles
  const articlesToAdd = parsed.items.map((item) => ({
    feedId: feed.id,
    guid: item.guid,
    title: item.title,
    link: item.link,
    author: item.author,
    pubDate: item.pubDate,
    summary: item.summary,
    content: item.content,
  }));

  storage.addArticles(articlesToAdd);

  // Return feed with articles
  const articles = storage.getArticles({ feedId: feed.id, limit: 50 });
  const unreadCount = storage.getUnreadCount(feed.id);

  return { ...feed, articles, unreadCount };
}

/**
 * Refresh a feed - fetch new articles
 */
export async function refreshFeed(feedId: string): Promise<FeedWithArticles> {
  const storage = getStorage();
  const feed = storage.getFeed(feedId);

  if (!feed) {
    throw new Error(`Feed not found: ${feedId}`);
  }

  // Fetch fresh data (bypass cache)
  const parsed = await fetchFeed(feed.url, false);

  // Update feed metadata
  storage.updateFeed(feedId, {
    title: parsed.title,
    description: parsed.description,
    iconUrl: parsed.iconUrl,
    lastFetched: new Date().toISOString(),
  });

  // Add new articles (duplicates are ignored via UNIQUE constraint)
  const articlesToAdd = parsed.items.map((item) => ({
    feedId,
    guid: item.guid,
    title: item.title,
    link: item.link,
    author: item.author,
    pubDate: item.pubDate,
    summary: item.summary,
    content: item.content,
  }));

  const addedCount = storage.addArticles(articlesToAdd);

  // Return updated feed with articles
  const updatedFeed = storage.getFeed(feedId)!;
  const articles = storage.getArticles({ feedId, limit: 50 });
  const unreadCount = storage.getUnreadCount(feedId);

  return { ...updatedFeed, articles, unreadCount };
}

/**
 * Refresh all feeds
 */
export async function refreshAllFeeds(): Promise<{ refreshed: number; errors: string[] }> {
  const storage = getStorage();
  const feeds = storage.getFeeds();
  const errors: string[] = [];
  let refreshed = 0;

  for (const feed of feeds) {
    try {
      await refreshFeed(feed.id);
      refreshed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${feed.title}: ${message}`);
    }
  }

  return { refreshed, errors };
}

/**
 * Unsubscribe from a feed
 */
export function unsubscribeFeed(feedId: string): void {
  const storage = getStorage();
  storage.deleteFeed(feedId);
  feedCache.delete(feedId);
}

/**
 * Get all feeds with unread counts
 */
export function listFeeds(): Array<RssFeed & { unreadCount: number }> {
  const storage = getStorage();
  return storage.getFeedsWithUnreadCounts();
}

/**
 * Get articles for a feed
 */
export function getArticles(params: {
  feedId?: string;
  unreadOnly?: boolean;
  savedOnly?: boolean;
  limit?: number;
  offset?: number;
}): RssArticle[] {
  const storage = getStorage();
  return storage.getArticles(params);
}

/**
 * Get a single article by ID
 */
export function getArticle(articleId: string): RssArticle | null {
  const storage = getStorage();
  return storage.getArticle(articleId);
}

/**
 * Mark article as read/unread
 */
export function markRead(articleId: string, isRead: boolean): void {
  const storage = getStorage();
  storage.markArticleRead(articleId, isRead);
}

/**
 * Mark all articles in a feed as read
 */
export function markAllRead(feedId: string): void {
  const storage = getStorage();
  storage.markAllArticlesRead(feedId);
}

/**
 * Toggle article saved state
 */
export function toggleSaved(articleId: string): boolean {
  const storage = getStorage();
  return storage.toggleArticleSaved(articleId);
}

/**
 * Search articles
 */
export function searchArticles(params: {
  query: string;
  feedId?: string;
  limit?: number;
}): Array<RssArticle & { score: number }> {
  const storage = getStorage();
  return storage.searchRssArticles(params);
}

/**
 * Get article content as Markdown (for Claude)
 */
export function getArticleAsMarkdown(articleId: string): string | null {
  const storage = getStorage();
  const article = storage.getArticle(articleId);

  if (!article) return null;

  const content = article.content || article.summary || '';

  // Convert HTML to Markdown if it contains HTML tags
  if (/<[^>]+>/.test(content)) {
    return turndown.turndown(content);
  }

  return content;
}

// ============================================================================
// Helpers
// ============================================================================

function extractDomainName(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function cleanHtml(html: string): string {
  if (!html) return '';

  // Decode HTML entities
  let text = html
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&rsquo;/gi, "'")
    .replace(/&lsquo;/gi, "'")
    .replace(/&rdquo;/gi, '"')
    .replace(/&ldquo;/gi, '"');

  // Normalize whitespace but preserve structure
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

// ============================================================================
// Context Sync (for Claude integration)
// ============================================================================

export interface RssReadingContext {
  articleId: string;
  feedTitle: string;
  articleTitle: string;
  author?: string;
  pubDate?: string;
  content: string;
}

// In-memory variable for current RSS context (same pattern as book context)
// This works in stdio mode because the MCP server is a single long-running process
let currentRssContext: RssReadingContext | null = null;

/**
 * Sync the current article context (called by UI on article view)
 * Uses in-memory variable (same pattern as book reading context)
 */
export function syncRssContext(context: RssReadingContext): void {
  currentRssContext = { ...context };
}

/**
 * Get the current RSS context (called by Claude)
 */
export function getRssContext(): RssReadingContext | null {
  return currentRssContext;
}

/**
 * Clear the RSS context
 */
export function clearRssContext(): void {
  currentRssContext = null;
}
