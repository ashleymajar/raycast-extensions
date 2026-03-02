import type {
  Severity,
  RootlyAlertPayload,
  RootlyAlertResponse,
  RootlyAlertFieldValue,
} from '../types';
import { getConfig } from './config';

const ROOTLY_API_BASE = 'https://api.rootly.com/v1';

const ESCALATION_POLICY_ID = '520c30ac-f059-4f91-aafb-814f1a3fc6d0';
const CREATORS_FIELD_ID = 'e8a3bd4a-97ad-47b6-94c0-8b800842b7e8';
const WORKSPACES_FIELD_ID = 'e0693694-1932-4d2e-b2fc-a6ff457a85eb';

function getRootlyApiKey(): string {
  const config = getConfig();
  if (!config.rootlyApiKey) {
    throw new Error('Rootly API key not configured');
  }
  return config.rootlyApiKey;
}

export type CreateAlertParams = {
  summary: string;
  description: string;
  severity?: Severity;
  workspaceUids?: string[];
  creatorIds?: string[];
};

export async function createAlert(params: CreateAlertParams): Promise<RootlyAlertResponse> {
  const apiKey = getRootlyApiKey();
  const { summary, description, severity, workspaceUids = [], creatorIds = [] } = params;

  const alertFieldValues: RootlyAlertFieldValue[] = [];

  if (workspaceUids.length > 0) {
    alertFieldValues.push({
      alert_field_id: WORKSPACES_FIELD_ID,
      value: workspaceUids.join(', '),
    });
  }

  if (creatorIds.length > 0) {
    alertFieldValues.push({
      alert_field_id: CREATORS_FIELD_ID,
      value: creatorIds.join(', '),
    });
  }

  // Add severity as a label since alert_urgency_id requires fetching urgency IDs from Rootly
  const labels: Array<{ key: string; value: string }> = [];
  if (severity) {
    labels.push({ key: 'severity', value: severity });
  }

  // Build attributes - notification_target requires On-Call to be enabled
  const attributes: RootlyAlertPayload['data']['attributes'] = {
    source: 'api',
    summary,
    description,
  };

  // Only add notification target if configured
  if (ESCALATION_POLICY_ID) {
    attributes.notification_target_type = 'EscalationPolicy';
    attributes.notification_target_id = ESCALATION_POLICY_ID;
  }

  if (labels.length > 0) {
    attributes.labels = labels;
  }

  if (alertFieldValues.length > 0) {
    attributes.alert_field_values_attributes = alertFieldValues;
  }

  const payload: RootlyAlertPayload = {
    data: {
      type: 'alerts',
      attributes,
    },
  };

  console.log('Rootly payload:', JSON.stringify(payload, null, 2));

  const response = await fetch(`${ROOTLY_API_BASE}/alerts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/vnd.api+json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  console.log('Rootly response:', response.status, responseText);

  if (!response.ok) {
    throw new Error(`Rootly API error (${response.status}): ${responseText}`);
  }

  return JSON.parse(responseText) as RootlyAlertResponse;
}
