import {
  Action,
  ActionPanel,
  Detail,
  Form,
  Icon,
  List,
  LocalStorage,
  open,
  openExtensionPreferences,
  Clipboard,
  showToast,
  Toast,
  Color,
  useNavigation,
} from '@raycast/api';
import { usePromise } from '@raycast/utils';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  searchAccounts,
  searchCreators,
  generateImpersonationLink,
  updateAccountComments,
  refreshCache,
  getAccountsByUids,
} from './api/client';
import {
  isConfigured,
  isConfigOutdated,
  CURRENT_CONFIG_VERSION,
  getConfigVersion,
} from './api/config';
import type { AdminAccountItem, CreatorSearchItem } from './types';
import {
  formatAccountSubtitle,
  formatAccountTitle,
  formatCreatorSubtitle,
  formatCreatorTitle,
} from './utils/format';

const CONSOLE_BASE = 'https://console.supercreator.app';
const MIN_SEARCH_LENGTH = 2;
const CACHE_REFRESH_INTERVAL_MS = 60_000; // 1 minute
const RECENT_STORAGE_KEY = 'recentlyAccessedAccounts';
const MAX_RECENT_ITEMS = 10;

type RecentItem = {
  accountUid: string;
  accessedAt: number;
};

async function getRecentItems(): Promise<RecentItem[]> {
  const stored = await LocalStorage.getItem<string>(RECENT_STORAGE_KEY);
  if (!stored) {
    return [];
  }
  try {
    return JSON.parse(stored) as RecentItem[];
  } catch {
    return [];
  }
}

async function addRecentItem(accountUid: string): Promise<void> {
  const items = await getRecentItems();
  const filtered = items.filter((item) => item.accountUid !== accountUid);
  const updated = [{ accountUid, accessedAt: Date.now() }, ...filtered].slice(0, MAX_RECENT_ITEMS);
  await LocalStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(updated));
}

function useRecentItems() {
  const [recentItems, setRecentItems] = useState<RecentItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    getRecentItems().then((items) => {
      setRecentItems(items);
      setIsLoading(false);
    });
  }, []);

  const trackAccess = useCallback(async (accountUid: string) => {
    await addRecentItem(accountUid);
    const updated = await getRecentItems();
    setRecentItems(updated);
  }, []);

  return { recentItems, isLoading, trackAccess };
}

export default function SearchAccounts() {
  const [searchText, setSearchText] = useState('');
  const [cacheLoading, setCacheLoading] = useState(true);
  const accountsAbortable = useRef<AbortController>(null);
  const creatorsAbortable = useRef<AbortController>(null);
  const configValid = isConfigured();
  const { recentItems, trackAccess } = useRecentItems();
  const [recentAccounts, setRecentAccounts] = useState<AdminAccountItem[]>([]);

  // Initialize cache on mount and refresh every 60 seconds
  useEffect(() => {
    if (!configValid) {
      setCacheLoading(false);
      return;
    }

    let isMounted = true;

    const loadCache = async () => {
      try {
        await refreshCache();
      } catch (err) {
        showToast({
          style: Toast.Style.Failure,
          title: 'Failed to load data',
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (isMounted) {
          setCacheLoading(false);
        }
      }
    };

    loadCache();

    const interval = setInterval(() => {
      refreshCache();
    }, CACHE_REFRESH_INTERVAL_MS);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [configValid]);

  // Load recent accounts when recentItems or cache changes
  useEffect(() => {
    if (cacheLoading || recentItems.length === 0) {
      setRecentAccounts([]);
      return;
    }

    const loadRecentAccounts = async () => {
      const uids = recentItems.map((item) => item.accountUid);
      const accounts = await getAccountsByUids(uids);
      setRecentAccounts(accounts);
    };

    loadRecentAccounts();
  }, [recentItems, cacheLoading]);

  if (!configValid) {
    return (
      <List>
        <List.EmptyView
          icon={Icon.Gear}
          title="Configuration Required"
          description="Please configure your base64-encoded JSON config containing readDatabaseUrl, writeDatabaseUrl, linearApiKey, and openaiApiKey. Encode with: cat config.json | base64"
          actions={
            <ActionPanel>
              <Action
                title="Open Extension Preferences"
                icon={Icon.Gear}
                onAction={openExtensionPreferences}
              />
            </ActionPanel>
          }
        />
      </List>
    );
  }

  if (isConfigOutdated()) {
    return (
      <List>
        <List.EmptyView
          icon={Icon.ArrowClockwise}
          title="Configuration Update Required"
          description={`Your config is version ${getConfigVersion()}, but version ${CURRENT_CONFIG_VERSION} is required. Please get the latest config string and update your extension preferences.`}
          actions={
            <ActionPanel>
              <Action
                title="Open Extension Preferences"
                icon={Icon.Gear}
                onAction={openExtensionPreferences}
              />
            </ActionPanel>
          }
        />
      </List>
    );
  }

  const shouldSearch = searchText.trim().length >= MIN_SEARCH_LENGTH;

  const {
    data: accountsData,
    isLoading: accountsLoading,
    error: accountsError,
    revalidate: revalidateAccounts,
  } = usePromise(
    async (query: string) => {
      if (!query || query.trim().length < MIN_SEARCH_LENGTH) {
        return { accounts: [], totalFound: 0 };
      }
      return searchAccounts(query.trim());
    },
    [searchText],
    { abortable: accountsAbortable, execute: shouldSearch },
  );

  const {
    data: creatorsData,
    isLoading: creatorsLoading,
    error: creatorsError,
  } = usePromise(
    async (query: string) => {
      if (!query || query.trim().length < MIN_SEARCH_LENGTH) {
        return { creators: [] };
      }
      return searchCreators(query.trim());
    },
    [searchText],
    { abortable: creatorsAbortable, execute: shouldSearch },
  );

  const isLoading = cacheLoading || accountsLoading || creatorsLoading;
  const error = accountsError || creatorsError;

  useEffect(() => {
    if (error) {
      showToast({
        style: Toast.Style.Failure,
        title: 'Search failed',
        message: error.message,
      });
    }
  }, [error]);

  const rawAccounts = accountsData?.accounts ?? [];
  const creators = creatorsData?.creators ?? [];

  // Sort accounts: recently accessed first, then by match quality
  const recentUidSet = new Set(recentItems.map((r) => r.accountUid));
  const recentUidOrder = new Map(recentItems.map((r, i) => [r.accountUid, i]));

  const accounts = [...rawAccounts].sort((a, b) => {
    const aRecent = recentUidSet.has(a.accountUid);
    const bRecent = recentUidSet.has(b.accountUid);
    if (aRecent && !bRecent) {
      return -1;
    }
    if (!aRecent && bRecent) {
      return 1;
    }
    if (aRecent && bRecent) {
      return (recentUidOrder.get(a.accountUid) ?? 0) - (recentUidOrder.get(b.accountUid) ?? 0);
    }
    return 0;
  });

  return (
    <List
      isLoading={isLoading}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="Search by workspace UID, creator ID, email, name..."
      throttle
    >
      {cacheLoading ? (
        <List.EmptyView
          icon={Icon.Download}
          title="Loading accounts..."
          description="Fetching data from database"
        />
      ) : !shouldSearch ? (
        recentAccounts.length > 0 ? (
          <List.Section title="Recently Accessed">
            {recentAccounts.map((account) => (
              <AccountListItem
                key={account.accountUid}
                account={account}
                onUpdate={revalidateAccounts}
                onAccess={trackAccess}
                isRecent
              />
            ))}
          </List.Section>
        ) : (
          <List.EmptyView
            icon={Icon.MagnifyingGlass}
            title="Type to search"
            description="Search by ID, name, email, or workspace UID (min 2 characters)"
          />
        )
      ) : accounts.length === 0 && creators.length === 0 && !isLoading ? (
        <List.EmptyView
          icon={Icon.XMarkCircle}
          title="No results"
          description={`No workspaces or creators found for "${searchText}"`}
        />
      ) : (
        <>
          {accounts.length > 0 && (
            <List.Section title={`Workspaces (${accountsData?.totalFound ?? accounts.length})`}>
              {accounts.map((account) => (
                <AccountListItem
                  key={account.accountUid}
                  account={account}
                  onUpdate={revalidateAccounts}
                  onAccess={trackAccess}
                  isRecent={recentUidSet.has(account.accountUid)}
                />
              ))}
            </List.Section>
          )}
          {creators.length > 0 && (
            <List.Section title={`Creators (${creators.length})`}>
              {creators.map((creator) => (
                <CreatorListItem
                  key={`${creator.creatorId}-${creator.workspaceUid}`}
                  creator={creator}
                />
              ))}
            </List.Section>
          )}
        </>
      )}
    </List>
  );
}

function AccountListItem({
  account,
  onUpdate,
  onAccess,
  isRecent,
}: {
  account: AdminAccountItem;
  onUpdate: () => void;
  onAccess?: (accountUid: string) => void;
  isRecent?: boolean;
}) {
  const statusColor = getStatusColor(account.status);

  const trackAndRun = async (action: () => Promise<void> | void) => {
    onAccess?.(account.accountUid);
    await action();
  };

  const impersonate = async () => {
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: 'Generating link...',
    });
    try {
      const deeplink = await generateImpersonationLink(account.accountUid);
      toast.style = Toast.Style.Success;
      toast.title = 'Opening app...';
      await open(deeplink);
    } catch (err) {
      toast.style = Toast.Style.Failure;
      toast.title = 'Failed to generate link';
      toast.message = err instanceof Error ? err.message : String(err);
    }
  };

  const commentsText = parseComments(account.comments);

  return (
    <List.Item
      icon={{ source: Icon.Building, tintColor: statusColor }}
      title={formatAccountTitle(account)}
      subtitle={formatAccountSubtitle(account)}
      accessories={[
        ...(isRecent ? [{ icon: { source: Icon.Clock, tintColor: Color.SecondaryText } }] : []),
        ...(commentsText ? [{ tag: { value: commentsText, color: Color.Yellow } }] : []),
        ...(account.workspaceUid
          ? [{ tag: { value: account.workspaceUid, color: Color.Blue } }]
          : []),
      ]}
      actions={
        <ActionPanel>
          <Action
            title="Impersonate"
            icon={Icon.PersonCircle}
            onAction={() => trackAndRun(impersonate)}
          />
          <ActionPanel.Section title="Edit">
            <Action.Push
              title="Edit Comments"
              icon={Icon.Pencil}
              shortcut={{ modifiers: ['cmd'], key: 'e' }}
              target={<EditCommentsForm account={account} onUpdate={onUpdate} />}
              onPush={() => onAccess?.(account.accountUid)}
            />
          </ActionPanel.Section>
          <ActionPanel.Section title="Open">
            {account.workspaceUid && (
              <Action
                title="Open in Admin"
                icon={Icon.Globe}
                onAction={() =>
                  trackAndRun(() =>
                    open(`${CONSOLE_BASE}/admin/accounts?search=${account.workspaceUid}`),
                  )
                }
              />
            )}
          </ActionPanel.Section>
          <ActionPanel.Section title="Copy">
            {account.workspaceUid && (
              <Action
                title="Copy Workspace UID"
                icon={Icon.Clipboard}
                shortcut={{ modifiers: ['cmd'], key: 'c' }}
                onAction={() =>
                  trackAndRun(() => copyToClipboard(account.workspaceUid!, 'Workspace UID'))
                }
              />
            )}
            <Action
              title="Copy Account UID"
              icon={Icon.Clipboard}
              shortcut={{ modifiers: ['cmd', 'shift'], key: 'c' }}
              onAction={() => trackAndRun(() => copyToClipboard(account.accountUid, 'Account UID'))}
            />
            {account.email && (
              <Action
                title="Copy Email"
                icon={Icon.Envelope}
                onAction={() => trackAndRun(() => copyToClipboard(account.email!, 'Email'))}
              />
            )}
          </ActionPanel.Section>
          <ActionPanel.Section title="Details">
            <Action.Push
              title="View Details"
              icon={Icon.Eye}
              target={<AccountDetail account={account} />}
              onPush={() => onAccess?.(account.accountUid)}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

function CreatorListItem({ creator }: { creator: CreatorSearchItem }) {
  return (
    <List.Item
      icon={{ source: Icon.Person, tintColor: Color.Purple }}
      title={formatCreatorTitle(creator)}
      subtitle={formatCreatorSubtitle(creator)}
      accessories={[{ tag: { value: creator.workspaceUid, color: Color.Blue } }]}
      actions={
        <ActionPanel>
          <ActionPanel.Section title="Open">
            <Action
              title="Open Workspace in Admin"
              icon={Icon.Globe}
              onAction={() => open(`${CONSOLE_BASE}/admin/accounts?search=${creator.workspaceUid}`)}
            />
          </ActionPanel.Section>
          <ActionPanel.Section title="Copy">
            <Action
              title="Copy Creator ID"
              icon={Icon.Clipboard}
              shortcut={{ modifiers: ['cmd'], key: 'c' }}
              onAction={() => copyToClipboard(String(creator.creatorId), 'Creator ID')}
            />
            <Action
              title="Copy Workspace UID"
              icon={Icon.Clipboard}
              shortcut={{ modifiers: ['cmd', 'shift'], key: 'c' }}
              onAction={() => copyToClipboard(creator.workspaceUid, 'Workspace UID')}
            />
            {creator.username && (
              <Action
                title="Copy Username"
                icon={Icon.AtSymbol}
                onAction={() => copyToClipboard(creator.username!, 'Username')}
              />
            )}
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

function AccountDetail({ account }: { account: AdminAccountItem }) {
  const creatorEntries = account.creators ? Object.entries(account.creators) : [];
  const commentsText = parseComments(account.comments);

  const markdown = `
# ${formatAccountTitle(account)}

| Field | Value |
|-------|-------|
| **Workspace UID** | \`${account.workspaceUid ?? 'N/A'}\` |
| **Account UID** | \`${account.accountUid}\` |
| **Email** | ${account.email ?? 'N/A'} |
| **Type** | ${account.type ?? 'N/A'} |
| **Status** | ${account.status ?? 'N/A'} |
| **Plan** | ${account.plan ?? 'N/A'} |
| **Creators Connected** | ${account.creatorsConnected ?? 0} |
| **Creators Pending** | ${account.creatorsPending ?? 0} |
| **Comments** | ${commentsText ?? 'N/A'} |

${
  creatorEntries.length > 0
    ? `## Creators\n\n| Creator ID | Username |\n|------------|----------|\n${creatorEntries.map(([id, username]) => `| ${id} | @${username} |`).join('\n')}`
    : ''
}
  `.trim();

  return (
    <Detail
      navigationTitle={formatAccountTitle(account)}
      markdown={markdown}
      actions={
        <ActionPanel>
          {account.workspaceUid && (
            <Action
              title="Open in Admin"
              icon={Icon.Globe}
              onAction={() => open(`${CONSOLE_BASE}/admin/accounts?search=${account.workspaceUid}`)}
            />
          )}
          {account.workspaceUid && (
            <Action
              title="Copy Workspace UID"
              icon={Icon.Clipboard}
              onAction={() => copyToClipboard(account.workspaceUid!, 'Workspace UID')}
            />
          )}
          <Action
            title="Copy Account UID"
            icon={Icon.Clipboard}
            onAction={() => copyToClipboard(account.accountUid, 'Account UID')}
          />
        </ActionPanel>
      }
    />
  );
}

function EditCommentsForm({
  account,
  onUpdate,
}: {
  account: AdminAccountItem;
  onUpdate: () => void;
}) {
  const { pop } = useNavigation();
  const [comments, setComments] = useState(parseComments(account.comments) ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    setIsSubmitting(true);
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: 'Saving...',
    });
    try {
      await updateAccountComments(account.accountUid, comments);
      toast.style = Toast.Style.Success;
      toast.title = 'Comments saved';
      onUpdate();
      pop();
    } catch (err) {
      toast.style = Toast.Style.Failure;
      toast.title = 'Failed to save';
      toast.message = err instanceof Error ? err.message : String(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Form
      navigationTitle={`Edit Comments - ${formatAccountTitle(account)}`}
      isLoading={isSubmitting}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save Comments" icon={Icon.Check} onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.Description
        title="Account"
        text={`${account.email ?? account.accountUid} (${account.workspaceUid ?? 'no workspace'})`}
      />
      <Form.TextArea
        id="comments"
        title="Comments"
        placeholder="Add aliases, notes, or tags for easier searching..."
        value={comments}
        onChange={setComments}
        info="These comments are searchable - add aliases like team names, account nicknames, etc."
      />
    </Form>
  );
}

function parseComments(comments: string | null): string | null {
  if (!comments) {
    return null;
  }
  try {
    const parsed = JSON.parse(comments);
    if (typeof parsed === 'string') {
      return parsed;
    }
    if (typeof parsed === 'object' && parsed !== null) {
      return JSON.stringify(parsed);
    }
    return String(parsed);
  } catch {
    return comments;
  }
}

function getStatusColor(status: string | null): Color {
  switch (status) {
    case 'active':
      return Color.Green;
    case 'trialing':
      return Color.Orange;
    case 'past_due':
      return Color.Red;
    case 'canceled':
    case 'suspended':
      return Color.SecondaryText;
    default:
      return Color.PrimaryText;
  }
}

async function copyToClipboard(text: string, label: string) {
  await Clipboard.copy(text);
  await showToast({ style: Toast.Style.Success, title: `${label} copied` });
}
