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
import { createLinearIssue, upsertCustomer } from './api/linear';
import { generateTitle } from './api/openai';
import type { AdminAccountItem, CreatorSearchItem, Priority } from './types';

type FormValues = {
  accounts: string[];
  creators: string[];
  fanId: string;
  description: string;
  priority: Priority;
  attachments: string[];
  intercomUrl: string;
};

export default function ReportIssue() {
  const [isLoading, setIsLoading] = useState(true);
  const [accounts, setAccounts] = useState<AdminAccountItem[]>([]);
  const [creators, setCreators] = useState<CreatorSearchItem[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [selectedCreators, setSelectedCreators] = useState<string[]>([]);
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority | ''>('');
  const [fanId, setFanId] = useState('');
  const [intercomUrl, setIntercomUrl] = useState('');
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
    if (!values.description.trim()) {
      showToast({
        style: Toast.Style.Failure,
        title: 'Description required',
        message: 'Please enter a description of the issue',
      });
      return;
    }

    if (!values.priority) {
      showToast({
        style: Toast.Style.Failure,
        title: 'Priority required',
        message: 'Please select a priority level',
      });
      return;
    }

    setIsSubmitting(true);
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: 'Creating Linear issue...',
    });

    try {
      // Generate title using OpenAI if configured, otherwise use first line
      let title: string;
      if (openaiConfigured) {
        toast.message = 'Generating title...';
        try {
          title = await generateTitle(values.description);
        } catch {
          // Fall back to first line if OpenAI fails
          const firstLine = values.description.split('\n')[0].slice(0, 80);
          title = firstLine.length >= 80 ? firstLine.slice(0, 77) + '...' : firstLine;
        }
      } else {
        const firstLine = values.description.split('\n')[0].slice(0, 80);
        title = firstLine.length >= 80 ? firstLine.slice(0, 77) + '...' : firstLine;
      }

      toast.message = 'Setting up customers...';

      // Use full cache for lookup in case selected account isn't in limited list
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

      // Upsert Linear customers for each workspace
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
          ? 'Creating issue and uploading files...'
          : 'Creating issue...';

      const response = await createLinearIssue({
        title,
        description: values.description,
        priority: values.priority,
        customerIds,
        workspaceUids,
        creatorIds,
        fanId: values.fanId || undefined,
        intercomUrl: values.intercomUrl || undefined,
        attachmentFiles: values.attachments,
      });

      toast.style = Toast.Style.Success;
      toast.title = 'Issue created';
      toast.message = response.identifier;

      setSelectedAccounts([]);
      setSelectedCreators([]);
      setDescription('');
      setPriority('');
      setFanId('');
      setIntercomUrl('');
      setAttachments([]);
    } catch (err) {
      toast.style = Toast.Style.Failure;
      toast.title = 'Failed to create issue';
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
    // Include comments for searchability (aliases, tags, notes)
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
          <Action.SubmitForm title="Submit Issue" icon={Icon.Upload} onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.Description
        title="Report Issue"
        text="Create a Linear issue in the CS & CX team with affected accounts and creators."
      />

      <Form.Separator />

      <Form.TagPicker
        id="accounts"
        title="Accounts"
        placeholder="Search by email, name, workspace UID, or alias..."
        value={selectedAccounts}
        onChange={setSelectedAccounts}
        info="Type to search. Aliased accounts shown first. Showing top 500."
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
        info="Type to search by username, name, or ID. Showing top 500."
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

      <Form.TextField
        id="fanId"
        title="Fan ID"
        placeholder="Enter fan ID (optional)..."
        value={fanId}
        onChange={setFanId}
        info="Optional: The fan ID related to this issue"
      />

      <Form.Separator />

      <Form.TextArea
        id="description"
        title="Description"
        placeholder="Describe the issue in detail..."
        value={description}
        onChange={setDescription}
        info="Describe the issue clearly. A title will be auto-generated from this."
        enableMarkdown
      />

      <Form.Dropdown
        id="priority"
        title="Priority"
        value={priority}
        onChange={(val) => setPriority(val as Priority | '')}
        info="Select the priority based on the impact"
      >
        <Form.Dropdown.Item value="" title="Select priority..." icon={Icon.QuestionMark} />
        <Form.Dropdown.Item
          value="urgent"
          title="Urgent - Core functionality broken"
          icon={Icon.ExclamationMark}
        />
        <Form.Dropdown.Item
          value="high"
          title="High - Daily functionality broken"
          icon={Icon.Warning}
        />
        <Form.Dropdown.Item
          value="medium"
          title="Medium - Non-critical functionality broken"
          icon={Icon.Info}
        />
        <Form.Dropdown.Item value="low" title="Low - UI glitches, minor issues" icon={Icon.Dot} />
      </Form.Dropdown>

      <Form.FilePicker
        id="attachments"
        title="Screenshots / Files"
        value={attachments}
        onChange={setAttachments}
        allowMultipleSelection
        info="Optional: Attach screenshots or files. File names will be noted in the issue."
      />

      <Form.Description
        title="Priority Guide"
        text={`• Urgent: Izzy, chatting, desktop app or similar core functionality not working
• High: Authentication, Izzy settings, products and similar daily functionality not working
• Medium: Analytics, dashboards and similar non-critical functionality not working
• Low: UI glitches or similar issues that don't impact daily work`}
      />

      <Form.Separator />

      <Form.TextField
        id="intercomUrl"
        title="Intercom Conversation"
        placeholder="https://app.intercom.com/..."
        value={intercomUrl}
        onChange={setIntercomUrl}
        info="Optional: Link to the Intercom conversation"
      />
    </Form>
  );
}
