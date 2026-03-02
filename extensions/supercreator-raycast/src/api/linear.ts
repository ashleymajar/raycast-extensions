import { readFileSync } from 'fs';
import { basename } from 'path';
import type {
  Priority,
  LinearCustomer,
  LinearCustomerResponse,
  LinearCustomerCreateResponse,
  LinearIssueCreateResponse,
} from '../types';
import { getConfig } from './config';

const LINEAR_API_URL = 'https://api.linear.app/graphql';
const CS_CX_TEAM_ID = '48aa2c92-12c5-45a1-bdf4-6e46a4ecb78f';
const RD_TEAM_ID = 'acf5ea32-54ba-474b-9484-c842ae3e8430';

export { CS_CX_TEAM_ID, RD_TEAM_ID };

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

function getContentType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop();
  const mimeTypes: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
  };
  return mimeTypes[ext || ''] || 'application/octet-stream';
}

function isImageFile(filename: string): boolean {
  const ext = filename.toLowerCase().split('.').pop();
  return IMAGE_EXTENSIONS.includes(ext || '');
}

function getLinearApiKey(): string {
  const config = getConfig();
  if (!config.linearApiKey) {
    throw new Error('Linear API key not configured');
  }
  return config.linearApiKey;
}

async function linearQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const apiKey = getLinearApiKey();

  const response = await fetch(LINEAR_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`Linear API error (${response.status}): ${responseText}`);
  }

  const result = JSON.parse(responseText);
  if (result.errors) {
    throw new Error(`Linear GraphQL error: ${JSON.stringify(result.errors)}`);
  }

  return result as T;
}

export async function findCustomerByExternalId(externalId: string): Promise<LinearCustomer | null> {
  const query = `
    query FindCustomers {
      customers(first: 250) {
        nodes {
          id
          name
          externalIds
        }
      }
    }
  `;

  const result = await linearQuery<LinearCustomerResponse>(query, {});
  const customers = result.data.customers.nodes;

  return customers.find((c) => c.externalIds?.includes(externalId)) ?? null;
}

export async function createCustomer(name: string, externalId: string): Promise<LinearCustomer> {
  const mutation = `
    mutation CreateCustomer($name: String!, $externalIds: [String!]!) {
      customerCreate(input: { name: $name, externalIds: $externalIds }) {
        success
        customer {
          id
          name
          externalIds
        }
      }
    }
  `;

  const result = await linearQuery<LinearCustomerCreateResponse>(mutation, {
    name,
    externalIds: [externalId],
  });

  if (!result.data.customerCreate.success) {
    throw new Error('Failed to create Linear customer');
  }

  return result.data.customerCreate.customer;
}

export async function upsertCustomer(workspaceUid: string, name: string): Promise<LinearCustomer> {
  const existing = await findCustomerByExternalId(workspaceUid);

  if (existing) {
    return existing;
  }

  return createCustomer(name, workspaceUid);
}

function priorityToLinearPriority(priority: Priority): number {
  switch (priority) {
    case 'urgent':
      return 1;
    case 'high':
      return 2;
    case 'medium':
      return 3;
    case 'low':
      return 4;
  }
}

export type CreateLinearIssueParams = {
  title: string;
  description: string;
  priority?: Priority;
  teamId?: string;
  customerIds?: string[];
  workspaceUids?: string[];
  creatorIds?: string[];
  fanId?: string;
  intercomUrl?: string;
  attachmentUrls?: string[];
  attachmentFiles?: string[];
};

export type CreateLinearIssueResult = {
  identifier: string;
  url: string;
};

async function linkCustomerToIssue(customerId: string, issueId: string): Promise<void> {
  const mutation = `
    mutation CreateCustomerNeed($customerId: String!, $issueId: String!) {
      customerNeedCreate(input: {
        customerId: $customerId
        issueId: $issueId
      }) {
        success
      }
    }
  `;

  await linearQuery<{ data: { customerNeedCreate: { success: boolean } } }>(mutation, {
    customerId,
    issueId,
  });
}

async function getTriageStateId(teamId: string): Promise<string | null> {
  const query = `
    query GetTriageState($teamId: String!) {
      team(id: $teamId) {
        states {
          nodes {
            id
            name
            type
          }
        }
      }
    }
  `;

  type StatesResponse = {
    data: {
      team: {
        states: {
          nodes: Array<{ id: string; name: string; type: string }>;
        };
      };
    };
  };

  const result = await linearQuery<StatesResponse>(query, { teamId });
  const states = result.data.team.states.nodes;

  const triageState = states.find(
    (s) => s.type === 'triage' || s.name.toLowerCase().includes('triage'),
  );
  return triageState?.id ?? null;
}

async function createAttachment(issueId: string, url: string, title: string): Promise<void> {
  const mutation = `
    mutation CreateAttachment($issueId: String!, $url: String!, $title: String!) {
      attachmentLinkURL(issueId: $issueId, url: $url, title: $title) {
        success
      }
    }
  `;

  await linearQuery<{ data: { attachmentLinkURL: { success: boolean } } }>(mutation, {
    issueId,
    url,
    title,
  });
}

type FileUploadResponse = {
  data: {
    fileUpload: {
      success: boolean;
      uploadFile: {
        uploadUrl: string;
        assetUrl: string;
        filename: string;
        contentType: string;
        size: number;
        headers: Array<{ key: string; value: string }>;
      };
    };
  };
};

async function uploadFileToLinear(filePath: string): Promise<string> {
  const filename = basename(filePath);
  const contentType = getContentType(filename);
  const fileBuffer = readFileSync(filePath);
  const size = fileBuffer.length;

  const mutation = `
    mutation FileUpload($filename: String!, $contentType: String!, $size: Int!) {
      fileUpload(filename: $filename, contentType: $contentType, size: $size) {
        success
        uploadFile {
          uploadUrl
          assetUrl
          filename
          contentType
          size
          headers {
            key
            value
          }
        }
      }
    }
  `;

  const result = await linearQuery<FileUploadResponse>(mutation, {
    filename,
    contentType,
    size,
  });

  if (!result.data.fileUpload.success) {
    throw new Error('Failed to get upload URL from Linear');
  }

  const { uploadUrl, assetUrl, headers: uploadHeaders } = result.data.fileUpload.uploadFile;

  const headers: Record<string, string> = {
    'Content-Type': contentType,
  };

  if (uploadHeaders && Array.isArray(uploadHeaders)) {
    for (const header of uploadHeaders) {
      headers[header.key] = header.value;
    }
  }

  const uploadResponse = await fetch(uploadUrl, {
    method: 'PUT',
    headers,
    body: fileBuffer,
  });

  if (!uploadResponse.ok) {
    throw new Error(`Failed to upload file: ${uploadResponse.status}`);
  }

  return assetUrl;
}

export async function createLinearIssue(
  params: CreateLinearIssueParams,
): Promise<CreateLinearIssueResult> {
  const {
    title,
    description,
    priority,
    teamId = CS_CX_TEAM_ID,
    customerIds = [],
    workspaceUids = [],
    creatorIds = [],
    fanId,
    intercomUrl,
    attachmentUrls = [],
    attachmentFiles = [],
  } = params;

  // Separate images from other files
  const imageFiles = attachmentFiles.filter((f) => isImageFile(basename(f)));
  const otherFiles = attachmentFiles.filter((f) => !isImageFile(basename(f)));

  // Upload images first so we can embed them in the description
  const uploadedImages: Array<{ filename: string; url: string }> = [];
  for (const filePath of imageFiles) {
    try {
      const assetUrl = await uploadFileToLinear(filePath);
      uploadedImages.push({ filename: basename(filePath), url: assetUrl });
    } catch {
      // Skip failed uploads
    }
  }

  // Build description with embedded images
  let fullDescription = description;

  // Add embedded images to description
  if (uploadedImages.length > 0) {
    fullDescription += '\n\n';
    for (const img of uploadedImages) {
      fullDescription += `![${img.filename}](${img.url})\n`;
    }
  }

  if (workspaceUids.length > 0) {
    fullDescription += `\n\n**Workspace UIDs:** ${workspaceUids.join(', ')}`;
  }

  if (creatorIds.length > 0) {
    fullDescription += `\n\n**Creator IDs:** ${creatorIds.join(', ')}`;
  }

  if (fanId) {
    fullDescription += `\n\n**Fan ID:** ${fanId}`;
  }

  if (intercomUrl) {
    fullDescription += `\n\n**Intercom Conversation:** ${intercomUrl}`;
  }

  const triageStateId = await getTriageStateId(teamId);

  // Build mutation based on whether we have priority and/or stateId
  const hasPriority = priority !== undefined;
  const hasState = triageStateId !== null;

  let mutation: string;
  if (hasPriority && hasState) {
    mutation = `
      mutation CreateIssue($teamId: String!, $title: String!, $description: String!, $priority: Int!, $stateId: String!) {
        issueCreate(input: {
          teamId: $teamId
          title: $title
          description: $description
          priority: $priority
          stateId: $stateId
        }) {
          success
          issue { id identifier title url }
        }
      }
    `;
  } else if (hasPriority) {
    mutation = `
      mutation CreateIssue($teamId: String!, $title: String!, $description: String!, $priority: Int!) {
        issueCreate(input: {
          teamId: $teamId
          title: $title
          description: $description
          priority: $priority
        }) {
          success
          issue { id identifier title url }
        }
      }
    `;
  } else if (hasState) {
    mutation = `
      mutation CreateIssue($teamId: String!, $title: String!, $description: String!, $stateId: String!) {
        issueCreate(input: {
          teamId: $teamId
          title: $title
          description: $description
          stateId: $stateId
        }) {
          success
          issue { id identifier title url }
        }
      }
    `;
  } else {
    mutation = `
      mutation CreateIssue($teamId: String!, $title: String!, $description: String!) {
        issueCreate(input: {
          teamId: $teamId
          title: $title
          description: $description
        }) {
          success
          issue { id identifier title url }
        }
      }
    `;
  }

  const variables: Record<string, unknown> = {
    teamId,
    title,
    description: fullDescription,
  };

  if (hasPriority) {
    variables.priority = priorityToLinearPriority(priority);
  }

  if (hasState) {
    variables.stateId = triageStateId;
  }

  const result = await linearQuery<LinearIssueCreateResponse>(mutation, variables);

  if (!result.data.issueCreate.success) {
    throw new Error('Failed to create Linear issue');
  }

  const issue = result.data.issueCreate.issue;

  // Link customers to the issue
  for (const customerId of customerIds) {
    try {
      await linkCustomerToIssue(customerId, issue.id);
    } catch {
      // Don't fail if customer linking fails
    }
  }

  // Upload and attach non-image files
  for (const filePath of otherFiles) {
    try {
      const assetUrl = await uploadFileToLinear(filePath);
      const filename = basename(filePath);
      await createAttachment(issue.id, assetUrl, filename);
    } catch {
      // Don't fail if file upload fails
    }
  }

  // Add URL attachments
  for (let i = 0; i < attachmentUrls.length; i++) {
    try {
      await createAttachment(issue.id, attachmentUrls[i], `Attachment ${i + 1}`);
    } catch {
      // Don't fail if attachment creation fails
    }
  }

  // Add Intercom link as attachment if provided
  if (intercomUrl) {
    try {
      await createAttachment(issue.id, intercomUrl, 'Intercom Conversation');
    } catch {
      // Don't fail if attachment creation fails
    }
  }

  return {
    identifier: issue.identifier,
    url: issue.url,
  };
}
