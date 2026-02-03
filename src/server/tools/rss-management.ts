/**
 * RSS Management Tools
 * MCP tools for RSS feed subscription and article reading
 */
import { z } from 'zod';
import {
  subscribeFeed,
  unsubscribeFeed,
  refreshFeed,
  refreshAllFeeds,
  listFeeds,
  getArticles,
  getArticle,
  markRead,
  markAllRead,
  toggleSaved,
  searchArticles,
  getArticleAsMarkdown,
} from '../rss-engine.js';
import { getStorage } from '../../storage/index.js';

// ============================================================================
// Tool Schemas
// ============================================================================

export const SubscribeFeedSchema = z.object({
  url: z.string().url().describe('RSS/Atom feed URL to subscribe to'),
});

export const UnsubscribeFeedSchema = z.object({
  feedId: z.string().describe('Feed ID to unsubscribe from'),
});

export const RefreshFeedSchema = z.object({
  feedId: z.string().describe('Feed ID to refresh'),
});

export const GetFeedArticlesSchema = z.object({
  feedId: z.string().optional().describe('Feed ID (omit for all feeds)'),
  unreadOnly: z.boolean().optional().describe('Only show unread articles'),
  savedOnly: z.boolean().optional().describe('Only show saved articles'),
  limit: z.number().optional().describe('Max articles to return (default 50)'),
  offset: z.number().optional().describe('Offset for pagination'),
});

export const GetArticleContentSchema = z.object({
  articleId: z.string().describe('Article ID to get content for'),
});

export const MarkArticleReadSchema = z.object({
  articleId: z.string().describe('Article ID'),
  isRead: z.boolean().describe('Mark as read (true) or unread (false)'),
});

export const MarkAllReadSchema = z.object({
  feedId: z.string().describe('Feed ID to mark all articles as read'),
});

export const SaveArticleSchema = z.object({
  articleId: z.string().describe('Article ID to toggle saved state'),
});

export const SearchRssArticlesSchema = z.object({
  query: z.string().describe('Search query'),
  feedId: z.string().optional().describe('Limit search to specific feed'),
  limit: z.number().optional().describe('Max results (default 50)'),
});

// ============================================================================
// App-Only Tool Implementations
// ============================================================================

/**
 * Subscribe to a new RSS feed
 */
export async function subscribeFeedTool(args: z.infer<typeof SubscribeFeedSchema>) {
  try {
    const result = await subscribeFeed(args.url);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Subscribed to "${result.title}" with ${result.articles.length} articles.`,
        },
      ],
      structuredContent: {
        feed: {
          id: result.id,
          url: result.url,
          title: result.title,
          description: result.description,
          iconUrl: result.iconUrl,
          unreadCount: result.unreadCount,
        },
        articleCount: result.articles.length,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text' as const, text: `Failed to subscribe: ${message}` }],
      isError: true,
    };
  }
}

/**
 * Unsubscribe from a feed
 */
export function unsubscribeFeedTool(args: z.infer<typeof UnsubscribeFeedSchema>) {
  const storage = getStorage();
  const feed = storage.getFeed(args.feedId);

  if (!feed) {
    return {
      content: [{ type: 'text' as const, text: 'Feed not found.' }],
      isError: true,
    };
  }

  unsubscribeFeed(args.feedId);

  return {
    content: [{ type: 'text' as const, text: `Unsubscribed from "${feed.title}".` }],
    structuredContent: { success: true, feedId: args.feedId },
  };
}

/**
 * Refresh a single feed
 */
export async function refreshFeedTool(args: z.infer<typeof RefreshFeedSchema>) {
  try {
    const result = await refreshFeed(args.feedId);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Refreshed "${result.title}" - ${result.unreadCount} unread articles.`,
        },
      ],
      structuredContent: {
        feed: {
          id: result.id,
          title: result.title,
          unreadCount: result.unreadCount,
        },
        articles: result.articles.slice(0, 20).map((a) => ({
          id: a.id,
          title: a.title,
          author: a.author,
          pubDate: a.pubDate,
          isRead: a.isRead,
          isSaved: a.isSaved,
        })),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text' as const, text: `Failed to refresh: ${message}` }],
      isError: true,
    };
  }
}

/**
 * Refresh all feeds
 */
export async function refreshAllFeedsTool() {
  try {
    const result = await refreshAllFeeds();

    let message = `Refreshed ${result.refreshed} feeds.`;
    if (result.errors.length > 0) {
      message += ` Errors: ${result.errors.length}`;
    }

    return {
      content: [{ type: 'text' as const, text: message }],
      structuredContent: {
        refreshed: result.refreshed,
        errors: result.errors,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text' as const, text: `Failed to refresh feeds: ${message}` }],
      isError: true,
    };
  }
}

/**
 * List all subscribed feeds
 */
export function listFeedsTool() {
  const feeds = listFeeds();
  const totalUnread = feeds.reduce((sum, f) => sum + f.unreadCount, 0);

  return {
    content: [
      {
        type: 'text' as const,
        text: `${feeds.length} subscribed feeds, ${totalUnread} unread articles.`,
      },
    ],
    structuredContent: {
      feeds: feeds.map((f) => ({
        id: f.id,
        url: f.url,
        title: f.title,
        description: f.description,
        iconUrl: f.iconUrl,
        unreadCount: f.unreadCount,
        lastFetched: f.lastFetched,
      })),
      totalUnread,
    },
  };
}

/**
 * Get articles for a feed (or all feeds)
 */
export function getFeedArticlesTool(args: z.infer<typeof GetFeedArticlesSchema>) {
  const articles = getArticles({
    feedId: args.feedId,
    unreadOnly: args.unreadOnly,
    savedOnly: args.savedOnly,
    limit: args.limit || 50,
    offset: args.offset,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: `Found ${articles.length} articles.`,
      },
    ],
    structuredContent: {
      articles: articles.map((a) => ({
        id: a.id,
        feedId: a.feedId,
        title: a.title,
        author: a.author,
        pubDate: a.pubDate,
        summary: a.summary?.slice(0, 200),
        link: a.link,
        isRead: a.isRead,
        isSaved: a.isSaved,
      })),
    },
  };
}

/**
 * Get full article content
 */
export function getArticleContentTool(args: z.infer<typeof GetArticleContentSchema>) {
  const article = getArticle(args.articleId);

  if (!article) {
    return {
      content: [{ type: 'text' as const, text: 'Article not found.' }],
      isError: true,
    };
  }

  // Auto-mark as read when content is fetched
  markRead(args.articleId, true);

  return {
    content: [{ type: 'text' as const, text: `Article: ${article.title}` }],
    structuredContent: {
      id: article.id,
      feedId: article.feedId,
      title: article.title,
      author: article.author,
      pubDate: article.pubDate,
      link: article.link,
      summary: article.summary,
      content: article.content,
      isRead: true,
      isSaved: article.isSaved,
    },
  };
}

/**
 * Mark article as read/unread
 */
export function markArticleReadTool(args: z.infer<typeof MarkArticleReadSchema>) {
  markRead(args.articleId, args.isRead);

  return {
    content: [
      {
        type: 'text' as const,
        text: `Article marked as ${args.isRead ? 'read' : 'unread'}.`,
      },
    ],
    structuredContent: { articleId: args.articleId, isRead: args.isRead },
  };
}

/**
 * Mark all articles in feed as read
 */
export function markAllReadTool(args: z.infer<typeof MarkAllReadSchema>) {
  markAllRead(args.feedId);

  return {
    content: [{ type: 'text' as const, text: 'All articles marked as read.' }],
    structuredContent: { feedId: args.feedId },
  };
}

/**
 * Toggle article saved state
 */
export function saveArticleTool(args: z.infer<typeof SaveArticleSchema>) {
  const isSaved = toggleSaved(args.articleId);

  return {
    content: [
      {
        type: 'text' as const,
        text: isSaved ? 'Article saved.' : 'Article unsaved.',
      },
    ],
    structuredContent: { articleId: args.articleId, isSaved },
  };
}

// ============================================================================
// Model-Only Tool Implementations
// ============================================================================

/**
 * Get RSS article content by ID (fetches from database)
 * Called by Claude when user is reading an RSS article
 */
export function getRssContextTool(articleId?: string) {
  if (!articleId) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'No articleId provided. Check the widget context for an article ID.',
        },
      ],
    };
  }

  const article = getArticle(articleId);
  if (!article) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Article not found with ID: ${articleId}`,
        },
      ],
    };
  }

  // Get the feed title
  const storage = getStorage();
  const feed = storage.getFeed(article.feedId);
  const feedTitle = feed?.title || 'Unknown Feed';

  let text = `The user is reading an RSS article:\n\n`;
  text += `**Feed:** ${feedTitle}\n`;
  text += `**Article:** ${article.title}\n`;
  if (article.author) text += `**Author:** ${article.author}\n`;
  if (article.pubDate) text += `**Published:** ${article.pubDate}\n`;
  text += `\n---\n\n${article.content || article.summary || 'No content available.'}`;

  return {
    content: [{ type: 'text' as const, text }],
  };
}

/**
 * Search across RSS articles
 */
export function searchRssArticlesTool(args: z.infer<typeof SearchRssArticlesSchema>) {
  const results = searchArticles({
    query: args.query,
    feedId: args.feedId,
    limit: args.limit,
  });

  if (results.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `No articles found matching "${args.query}".`,
        },
      ],
    };
  }

  // Get feed titles for context
  const storage = getStorage();
  const feeds = storage.getFeeds();
  const feedMap = new Map(feeds.map((f) => [f.id, f.title]));

  let text = `Found ${results.length} articles matching "${args.query}":\n\n`;

  for (const article of results.slice(0, 10)) {
    const feedTitle = feedMap.get(article.feedId) || 'Unknown Feed';
    text += `- **${article.title}** (${feedTitle})\n`;
    if (article.summary) {
      text += `  ${article.summary.slice(0, 100)}...\n`;
    }
    text += '\n';
  }

  if (results.length > 10) {
    text += `...and ${results.length - 10} more results.`;
  }

  return {
    content: [{ type: 'text' as const, text }],
  };
}

/**
 * Get user's saved articles
 */
export function getSavedArticlesTool() {
  const articles = getArticles({ savedOnly: true, limit: 50 });

  if (articles.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: "The user hasn't saved any RSS articles yet.",
        },
      ],
    };
  }

  // Get feed titles for context
  const storage = getStorage();
  const feeds = storage.getFeeds();
  const feedMap = new Map(feeds.map((f) => [f.id, f.title]));

  let text = `The user has ${articles.length} saved articles:\n\n`;

  for (const article of articles.slice(0, 20)) {
    const feedTitle = feedMap.get(article.feedId) || 'Unknown Feed';
    text += `- **${article.title}** from ${feedTitle}`;
    if (article.pubDate) {
      text += ` (${new Date(article.pubDate).toLocaleDateString()})`;
    }
    text += '\n';
  }

  if (articles.length > 20) {
    text += `\n...and ${articles.length - 20} more saved articles.`;
  }

  return {
    content: [{ type: 'text' as const, text }],
  };
}

/**
 * List all RSS subscriptions (for Claude)
 */
export function listSubscriptionsTool() {
  const feeds = listFeeds();

  if (feeds.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: "The user isn't subscribed to any RSS feeds yet.",
        },
      ],
    };
  }

  const totalUnread = feeds.reduce((sum, f) => sum + f.unreadCount, 0);

  let text = `The user is subscribed to ${feeds.length} RSS feeds with ${totalUnread} unread articles:\n\n`;

  for (const feed of feeds) {
    text += `- **${feed.title}** (${feed.unreadCount} unread)\n`;
    if (feed.description) {
      text += `  ${feed.description.slice(0, 80)}...\n`;
    }
  }

  return {
    content: [{ type: 'text' as const, text }],
  };
}

// ============================================================================
// Image Proxy Tool (for bypassing CSP)
// ============================================================================

export const ProxyImageSchema = z.object({
  url: z.string().url().describe('External image URL to proxy'),
});

/**
 * Proxy an external image and return as base64 data URL
 * This bypasses CSP restrictions by fetching server-side
 */
export async function proxyImageTool(args: z.infer<typeof ProxyImageSchema>) {
  try {
    const response = await fetch(args.url, {
      headers: {
        'User-Agent': 'LibraLM-Reader/2.0 (RSS Image Proxy)',
        'Accept': 'image/*',
      },
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (!response.ok) {
      return {
        content: [{ type: 'text' as const, text: `Failed to fetch image: ${response.statusText}` }],
        structuredContent: { dataUrl: null, error: response.statusText },
        isError: true,
      };
    }

    const contentType = response.headers.get('content-type') || 'image/png';

    // Check if it's actually an image
    if (!contentType.startsWith('image/')) {
      return {
        content: [{ type: 'text' as const, text: 'URL does not point to an image' }],
        structuredContent: { dataUrl: null, error: 'Not an image' },
        isError: true,
      };
    }

    // Convert to base64 data URL
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const dataUrl = `data:${contentType};base64,${base64}`;

    return {
      content: [{ type: 'text' as const, text: 'Image loaded.' }],
      structuredContent: { dataUrl },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text' as const, text: `Failed to proxy image: ${message}` }],
      structuredContent: { dataUrl: null, error: message },
      isError: true,
    };
  }
}
