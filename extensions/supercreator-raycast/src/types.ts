export type AdminAccountItem = {
  accountUid: string;
  email: string | null;
  displayName: string | null;
  type: string | null;
  workspaceUid: string | null;
  comments: string | null;
  status: string | null;
  plan: string | null;
  creatorsConnected: number | null;
  creatorsPending: number | null;
  creators: Record<string, string> | null;
};

export type CreatorSearchItem = {
  creatorId: number;
  name: string | null;
  username: string | null;
  workspaceUid: string;
  subscribersCount: number | null;
};

export type AccountsSearchResponse = {
  accounts: AdminAccountItem[];
  totalFound: number;
};

export type CreatorsSearchResponse = {
  creators: CreatorSearchItem[];
};

export type RawPreferences = {
  configBase64: string;
};

export type AppConfig = {
  configVersion?: number;
  readDatabaseUrl: string;
  writeDatabaseUrl: string;
  rootlyApiKey?: string;
  openaiApiKey?: string;
  linearApiKey?: string;
};

export type Severity = 'SEV0' | 'SEV1' | 'SEV2' | 'SEV3' | '';

export type Priority = 'urgent' | 'high' | 'medium' | 'low';

export type RootlyAlertFieldValue = {
  alert_field_id: string;
  value: string;
};

export type RootlyAlertAttributes = {
  source: string;
  summary: string;
  description: string;
  alert_urgency_id?: string;
  notification_target_type?: string;
  notification_target_id?: string;
  labels?: Array<{ key: string; value: string }>;
  alert_field_values_attributes?: RootlyAlertFieldValue[];
};

export type RootlyAlertPayload = {
  data: {
    type: 'alerts';
    attributes: RootlyAlertAttributes;
  };
};

export type RootlyAlertResponse = {
  data: {
    id: string;
    type: string;
    attributes: {
      short_id: string;
      summary: string;
      status: string;
    };
  };
};

export type OpenAIFormatResponse = {
  description: string;
  severity: Severity;
};

export type LinearCustomer = {
  id: string;
  name: string;
  externalIds: string[];
};

export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  url: string;
};

export type LinearCustomerResponse = {
  data: {
    customers: {
      nodes: LinearCustomer[];
    };
  };
};

export type LinearCustomerCreateResponse = {
  data: {
    customerCreate: {
      success: boolean;
      customer: LinearCustomer;
    };
  };
};

export type LinearIssueCreateResponse = {
  data: {
    issueCreate: {
      success: boolean;
      issue: LinearIssue;
    };
  };
};
