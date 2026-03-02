import type { AdminAccountItem, CreatorSearchItem } from '../types';

export function formatAccountSubtitle(account: AdminAccountItem): string {
  const parts: string[] = [];

  if (account.email) {
    parts.push(account.email);
  }
  if (account.status) {
    parts.push(capitalize(account.status));
  }
  if (account.plan) {
    parts.push(capitalize(account.plan));
  }

  const creatorCount = account.creatorsConnected ?? 0;
  if (creatorCount > 0) {
    parts.push(`${creatorCount} creator${creatorCount === 1 ? '' : 's'}`);
  }

  return parts.join(' · ');
}

export function formatCreatorSubtitle(creator: CreatorSearchItem): string {
  const parts: string[] = [];

  if (creator.name) {
    parts.push(creator.name);
  }
  parts.push(creator.workspaceUid);

  if (creator.subscribersCount != null) {
    parts.push(`${formatNumber(creator.subscribersCount)} subs`);
  }

  return parts.join(' · ');
}

export function formatCreatorTitle(creator: CreatorSearchItem): string {
  const username = creator.username ? `@${creator.username}` : `Creator`;
  return `${username} (ID: ${creator.creatorId})`;
}

export function formatAccountTitle(account: AdminAccountItem): string {
  return account.displayName || account.email || account.workspaceUid || account.accountUid;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }
  return String(n);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
