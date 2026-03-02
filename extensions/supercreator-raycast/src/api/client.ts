import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import type {
  AdminAccountItem,
  CreatorSearchItem,
  AccountsSearchResponse,
  CreatorsSearchResponse,
} from '../types';
import { getConfig } from './config';

const AUTH_CODE_EXPIRY_SECONDS = 180;
const CODE_LENGTH = 32;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes - in-memory cache for current session
const MAX_REPORT_ISSUE_ITEMS = 500; // Limit for Report Issue form to prevent memory issues

let readPool: mysql.Pool | null = null;
let writePool: mysql.Pool | null = null;

// In-memory cache (not persisted - Raycast memory limits prevent storing 75k+ records)
let accountsCache: AdminAccountItem[] = [];
let creatorsCache: CreatorSearchItem[] = [];
let lastFetchTime = 0;
let isRefreshing = false;
let refreshPromise: Promise<void> | null = null;

/**
 * Parses a MySQL connection URL into pool options.
 * Format: mysql://user:password@host/database
 */
function parseConnectionUrl(url: string): mysql.PoolOptions {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? parseInt(parsed.port, 10) : 3306,
    user: parsed.username,
    password: parsed.password,
    database: parsed.pathname.slice(1),
    ssl: { rejectUnauthorized: false },
    connectionLimit: 2,
  };
}

function getReadPool(): mysql.Pool {
  if (!readPool) {
    const config = getConfig();
    readPool = mysql.createPool(parseConnectionUrl(config.readDatabaseUrl));
  }
  return readPool;
}

function getWritePool(): mysql.Pool {
  if (!writePool) {
    const appConfig = getConfig();
    const poolConfig = parseConnectionUrl(appConfig.writeDatabaseUrl);
    poolConfig.connectionLimit = 1;
    writePool = mysql.createPool(poolConfig);
  }
  return writePool;
}

/**
 * Fetches all accounts from the database (no filters).
 */
async function fetchAllAccounts(): Promise<AdminAccountItem[]> {
  const db = getReadPool();
  const [rows] = await db.query(
    `SELECT
      a.account_uid AS accountUid,
      a.email,
      a.display_name AS displayName,
      a.type,
      a.workspace_uid AS workspaceUid,
      a.comments,
      w.status,
      w.plan,
      JSON_LENGTH(COALESCE(w.creator_ids_connected, JSON_ARRAY())) AS creatorsConnected,
      JSON_LENGTH(COALESCE(w.creator_ids_pending, JSON_ARRAY())) AS creatorsPending
    FROM accounts a
    LEFT JOIN workspaces w ON a.workspace_uid = w.workspace_uid
    ORDER BY a.created_at DESC`,
  );
  return rows as AdminAccountItem[];
}

/**
 * Fetches all creators from the database (no filters).
 */
async function fetchAllCreators(): Promise<CreatorSearchItem[]> {
  const db = getReadPool();
  const [rows] = await db.query(
    `SELECT
      c.creator_id AS creatorId,
      c.name,
      c.username,
      c.workspace_uid AS workspaceUid,
      c.subscribers_count AS subscribersCount
    FROM creator_me_info c`,
  );
  return rows as CreatorSearchItem[];
}

/**
 * Refreshes the in-memory cache by fetching all accounts and creators from DB.
 * Called on first search and every 15 minutes within the same session.
 * Returns a promise that resolves when refresh completes (even if waiting on existing refresh).
 */
export async function refreshCache(): Promise<void> {
  if (isRefreshing && refreshPromise) {
    return refreshPromise;
  }
  isRefreshing = true;

  refreshPromise = (async () => {
    try {
      const [accounts, creators] = await Promise.all([fetchAllAccounts(), fetchAllCreators()]);
      accountsCache = accounts;
      creatorsCache = creators;
      lastFetchTime = Date.now();
    } finally {
      isRefreshing = false;
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

/**
 * Checks if in-memory cache needs refresh (older than TTL or empty).
 */
function isCacheStale(): boolean {
  return accountsCache.length === 0 || Date.now() - lastFetchTime > CACHE_TTL_MS;
}

/**
 * Ensures in-memory cache is populated, refreshing from DB if stale.
 */
async function ensureCache(): Promise<void> {
  if (isCacheStale()) {
    await refreshCache();
  }
}

/**
 * Parses comments JSON to string for searching.
 */
function parseCommentsForSearch(comments: string | null): string {
  if (!comments) {
    return '';
  }
  try {
    const parsed = JSON.parse(comments);
    return typeof parsed === 'string' ? parsed.toLowerCase() : JSON.stringify(parsed).toLowerCase();
  } catch {
    return String(comments).toLowerCase();
  }
}

/**
 * Searches accounts locally using the cached data.
 */
export async function searchAccounts(search: string): Promise<AccountsSearchResponse> {
  await ensureCache();

  const searchLower = search.toLowerCase();

  const matches = accountsCache.filter((account) => {
    const emailMatch = account.email?.toLowerCase().includes(searchLower);
    const accountUidMatch = account.accountUid.toLowerCase().includes(searchLower);
    const workspaceUidMatch = account.workspaceUid?.toLowerCase().includes(searchLower);
    const displayNameMatch = account.displayName?.toLowerCase().includes(searchLower);
    const commentsMatch = parseCommentsForSearch(account.comments).includes(searchLower);

    return emailMatch || accountUidMatch || workspaceUidMatch || displayNameMatch || commentsMatch;
  });

  // Sort with comment matches first
  matches.sort((a, b) => {
    const aCommentsMatch = parseCommentsForSearch(a.comments).includes(searchLower) ? 1 : 0;
    const bCommentsMatch = parseCommentsForSearch(b.comments).includes(searchLower) ? 1 : 0;
    return bCommentsMatch - aCommentsMatch;
  });

  const accounts = matches.slice(0, 20);
  return { accounts, totalFound: matches.length };
}

/**
 * Searches creators locally using the cached data.
 */
export async function searchCreators(search: string): Promise<CreatorsSearchResponse> {
  await ensureCache();

  const searchLower = search.toLowerCase();
  const searchAsNumber = /^\d+$/.test(search.trim()) ? Number(search.trim()) : null;

  const matches = creatorsCache.filter((creator) => {
    const nameMatch = creator.name?.toLowerCase().includes(searchLower);
    const usernameMatch = creator.username?.toLowerCase().includes(searchLower);
    const workspaceUidMatch = creator.workspaceUid.toLowerCase().includes(searchLower);
    const creatorIdMatch = searchAsNumber !== null && creator.creatorId === searchAsNumber;

    return nameMatch || usernameMatch || workspaceUidMatch || creatorIdMatch;
  });

  const creators = matches.slice(0, 20);
  return { creators };
}

/**
 * Generates a one-time impersonation code for the given account UID,
 * inserts it into app_auth_codes, and returns the deep link URL.
 * Same flow as the /im Slack bot command.
 */
export async function generateImpersonationLink(userUid: string): Promise<string> {
  const db = getWritePool();
  const code = crypto.randomBytes(CODE_LENGTH).toString('hex');

  await db.query(
    `INSERT INTO app_auth_codes (code, user_uid, is_support, expires_at)
     VALUES (?, ?, 1, NOW() + INTERVAL ? SECOND)`,
    [code, userUid, AUTH_CODE_EXPIRY_SECONDS],
  );

  return `supercreator://support-auth?auth=${code}&source=support`;
}

/**
 * Updates the comments field for an account.
 * Used for adding aliases/notes to accounts for easier searching.
 * The comments column is JSON type, so we JSON-encode the string.
 * Also updates the local cache.
 */
export async function updateAccountComments(accountUid: string, comments: string): Promise<void> {
  const db = getWritePool();
  const jsonValue = comments ? JSON.stringify(comments) : null;
  const [result] = await db.query<mysql.ResultSetHeader>(
    `UPDATE accounts SET comments = ? WHERE account_uid = ?`,
    [jsonValue, accountUid],
  );

  if (result.affectedRows === 0) {
    throw new Error(`Account not found: ${accountUid}`);
  }

  // Update local cache
  const cachedAccount = accountsCache.find((a) => a.accountUid === accountUid);
  if (cachedAccount) {
    cachedAccount.comments = jsonValue;
  }
}

/**
 * Returns cache status for debugging/display.
 */
export function getCacheStatus(): {
  accountCount: number;
  creatorCount: number;
  lastRefresh: number;
  isStale: boolean;
} {
  return {
    accountCount: accountsCache.length,
    creatorCount: creatorsCache.length,
    lastRefresh: lastFetchTime,
    isStale: isCacheStale(),
  };
}

/**
 * Gets an account by UID from the cache.
 */
export async function getAccountByUid(accountUid: string): Promise<AdminAccountItem | null> {
  await ensureCache();
  return accountsCache.find((a) => a.accountUid === accountUid) ?? null;
}

/**
 * Gets multiple accounts by UIDs from the cache, preserving order.
 */
export async function getAccountsByUids(accountUids: string[]): Promise<AdminAccountItem[]> {
  await ensureCache();
  const accounts: AdminAccountItem[] = [];
  for (const uid of accountUids) {
    const account = accountsCache.find((a) => a.accountUid === uid);
    if (account) {
      accounts.push(account);
    }
  }
  return accounts;
}

/**
 * Returns all cached accounts (synchronous, for use after cache is loaded).
 */
export function getAccountsFromCache(): AdminAccountItem[] {
  return accountsCache;
}

/**
 * Returns all cached creators (synchronous, for use after cache is loaded).
 */
export function getCreatorsFromCache(): CreatorSearchItem[] {
  return creatorsCache;
}

/**
 * Returns a limited subset of accounts for the Report Issue form.
 * Prioritizes accounts with comments (aliases) and limits total to prevent memory issues.
 */
export function getAccountsForReportIssue(): AdminAccountItem[] {
  // Sort: accounts with comments first, then by email
  const sorted = [...accountsCache].sort((a, b) => {
    const aHasComments = a.comments ? 1 : 0;
    const bHasComments = b.comments ? 1 : 0;
    if (aHasComments !== bHasComments) {
      return bHasComments - aHasComments;
    }
    return (a.email || '').localeCompare(b.email || '');
  });
  return sorted.slice(0, MAX_REPORT_ISSUE_ITEMS);
}

/**
 * Returns a limited subset of creators for the Report Issue form.
 * Deduplicates by creatorId to avoid React key conflicts.
 */
export function getCreatorsForReportIssue(): CreatorSearchItem[] {
  const seen = new Set<number>();
  const unique: CreatorSearchItem[] = [];
  for (const creator of creatorsCache) {
    if (!seen.has(creator.creatorId)) {
      seen.add(creator.creatorId);
      unique.push(creator);
      if (unique.length >= MAX_REPORT_ISSUE_ITEMS) {
        break;
      }
    }
  }
  return unique;
}
