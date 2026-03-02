import {
  Action,
  ActionPanel,
  Form,
  Icon,
  showToast,
  Toast,
  openExtensionPreferences,
  List,
} from '@raycast/api';
import { useEffect, useState } from 'react';
import {
  refreshCache,
  getAccountsForReportIssue,
  getCreatorsForReportIssue,
  getAccountsFromCache,
} from './api/client';
import {
  isConfigured,
  isLinearConfigured,
  isOpenAIConfigured,
  isConfigOutdated,
  CURRENT_CONFIG_VERSION,
  getConfigVersion,
} from './api/config';
import { createLinearIssue, upsertCustomer, RD_TEAM_ID } from './api/linear';
import { generateFeatureTitle } from './api/openai';
import type { AdminAccountItem, CreatorSearchItem } from './types';

type FormValues = {
  accounts: string[];
  creators: string[];
  description: string;
  attachments: string[];
};

export default function FeatureRequest() {
  const [isLoading, setIsLoading] = useState(true);
  const [accounts, setAccounts] = useState<AdminAccountItem[]>([]);
  const [creators, setCreators] = useState<CreatorSearchItem[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [selectedCreators, setSelectedCreators] = useState<string[]>([]);
  const [description, setDescription] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]);

  const configValid = isConfigured();
  const linearConfigured = isLinearConfigured();
  const openaiConfigured = isOpenAIConfigured();

  useEffect(() => {
    if (!configValid) {
      setIsLoading(false);
      return;
    }

    const loadData = async () => {
      try {
        await refreshCache();
        setAccounts(getAccountsForReportIssue());
        setCreators(getCreatorsForReportIssue());
      } catch (err) {
        showToast({
          style: Toast.Style.Failure,
          title: 'Failed to load data',
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setIsLoading(false);
      }
    };

    loadData();
  }, [configValid]);

  if (!configValid || !linearConfigured) {
    const missingConfigs: string[] = [];
    if (!configValid) {
      missingConfigs.push('Base64 config with database URLs');
    }
    if (!linearConfigured) {
      missingConfigs.push('linearApiKey in config');
    }

    return (
      <List>
        <List.EmptyView
          icon={Icon.Gear}
          title="Configuration Required"
          description={`Please configure: ${missingConfigs.join(', ')}. Create a JSON config with readDatabaseUrl, writeDatabaseUrl, linearApiKey, openaiApiKey and base64-encode it.`}
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

  const handleSubmit = async (values: FormValues) => {
    if (values.accounts.length === 0) {
      showToast({
        style: Toast.Style.Failure,
        title: 'Account required',
        message: 'Please select at least one account',
      });
      return;
    }

    if (!values.description.trim()) {
      showToast({
        style: Toast.Style.Failure,
        title: 'Description required',
        message: 'Please enter a description of the feature request',
      });
      return;
    }

    setIsSubmitting(true);
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: 'Creating feature request...',
    });

    try {
      let title: string;
      if (openaiConfigured) {
        toast.message = 'Generating title...';
        try {
          title = await generateFeatureTitle(values.description);
        } catch {
          const firstLine = values.description.split('\n')[0].slice(0, 80);
          title = firstLine.length >= 80 ? firstLine.slice(0, 77) + '...' : firstLine;
        }
      } else {
        const firstLine = values.description.split('\n')[0].slice(0, 80);
        title = firstLine.length >= 80 ? firstLine.slice(0, 77) + '...' : firstLine;
      }

      toast.message = 'Setting up customers...';

      const fullAccounts = getAccountsFromCache();
      const accountsWithWorkspace = values.accounts
        .map((uid) => {
          const account = fullAccounts.find((a) => a.accountUid === uid);
          return account ? { account, workspaceUid: account.workspaceUid } : null;
        })
        .filter(
          (
            item,
          ): item is {
            account: AdminAccountItem;
            workspaceUid: string | null;
          } => item !== null && item.workspaceUid !== null,
        );

      const workspaceUids = accountsWithWorkspace
        .map((item) => item.workspaceUid)
        .filter((uid): uid is string => uid !== null);

      const creatorIds = values.creators;

      const customerIds: string[] = [];
      for (const item of accountsWithWorkspace) {
        if (item.workspaceUid) {
          const customerName = item.account.displayName || item.account.email || item.workspaceUid;
          const customer = await upsertCustomer(item.workspaceUid, customerName);
          customerIds.push(customer.id);
        }
      }

      toast.message =
        values.attachments.length > 0
          ? 'Creating feature request and uploading files...'
          : 'Creating feature request...';

      const response = await createLinearIssue({
        title,
        description: values.description,
        teamId: RD_TEAM_ID,
        customerIds,
        workspaceUids,
        creatorIds,
        attachmentFiles: values.attachments,
      });

      toast.style = Toast.Style.Success;
      toast.title = 'Feature request created';
      toast.message = response.identifier;

      setSelectedAccounts([]);
      setSelectedCreators([]);
      setDescription('');
      setAttachments([]);
    } catch (err) {
      toast.style = Toast.Style.Failure;
      toast.title = 'Failed to create feature request';
      toast.message = err instanceof Error ? err.message : String(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const parseComments = (comments: string | null): string => {
    if (!comments) {
      return '';
    }
    try {
      const parsed = JSON.parse(comments);
      return typeof parsed === 'string' ? parsed : '';
    } catch {
      return '';
    }
  };

  const formatAccountLabel = (account: AdminAccountItem): string => {
    const parts: string[] = [];
    if (account.email) {
      parts.push(account.email);
    }
    if (account.displayName && account.displayName !== account.email) {
      parts.push(`(${account.displayName})`);
    }
    if (account.workspaceUid) {
      parts.push(`[${account.workspaceUid}]`);
    }
    const comments = parseComments(account.comments);
    if (comments) {
      parts.push(`- ${comments}`);
    }
    return parts.join(' ') || account.accountUid;
  };

  const formatCreatorLabel = (creator: CreatorSearchItem): string => {
    const parts: string[] = [];
    if (creator.username) {
      parts.push(`@${creator.username}`);
    }
    if (creator.name && creator.name !== creator.username) {
      parts.push(`(${creator.name})`);
    }
    parts.push(`[${creator.creatorId}]`);
    parts.push(`[${creator.workspaceUid}]`);
    return parts.join(' ');
  };

  return (
    <Form
      isLoading={isLoading || isSubmitting}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Submit Feature Request"
            icon={Icon.LightBulb}
            onSubmit={handleSubmit}
          />
        </ActionPanel>
      }
    >
      <Form.Description
        title="Feature Request"
        text="Submit a feature request to the R&D team with affected accounts and creators."
      />

      <Form.Separator />

      <Form.TagPicker
        id="accounts"
        title="Accounts"
        placeholder="Search by email, name, workspace UID, or alias..."
        value={selectedAccounts}
        onChange={setSelectedAccounts}
        info="Required. Type to search. Aliased accounts shown first. Showing top 500."
      >
        {accounts.map((account) => (
          <Form.TagPicker.Item
            key={account.accountUid}
            value={account.accountUid}
            title={formatAccountLabel(account)}
            icon={Icon.Building}
          />
        ))}
      </Form.TagPicker>

      <Form.TagPicker
        id="creators"
        title="Creators"
        placeholder="Search by username, name, creator ID, or workspace UID..."
        value={selectedCreators}
        onChange={setSelectedCreators}
        info="Optional. Type to search by username, name, or ID. Showing top 500."
      >
        {creators.map((creator) => (
          <Form.TagPicker.Item
            key={String(creator.creatorId)}
            value={String(creator.creatorId)}
            title={formatCreatorLabel(creator)}
            icon={Icon.Person}
          />
        ))}
      </Form.TagPicker>

      <Form.Separator />

      <Form.TextArea
        id="description"
        title="Description"
        placeholder="Describe the feature request in detail..."
        value={description}
        onChange={setDescription}
        info="Describe the feature clearly. A title will be auto-generated from this."
        enableMarkdown
      />

      <Form.FilePicker
        id="attachments"
        title="Screenshots / Files"
        value={attachments}
        onChange={setAttachments}
        allowMultipleSelection
        info="Optional: Attach screenshots, mockups, or reference files."
      />
    </Form>
  );
}
