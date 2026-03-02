import OpenAI from 'openai';
import type { Severity, OpenAIFormatResponse } from '../types';
import { getConfig } from './config';

const PRODUCT_CONTEXT = `
## Supercreator Product Knowledge

Supercreator is an AI-powered business management platform for OnlyFans creators and agencies.

### Core Features
- **Izzy** - AI chatbot trained on 500M+ OnlyFans conversations. Two modes: Autopilot (fully automated) or Assist (suggests responses). Handles fan conversations 24/7, sells PPV content automatically.
- **Super Inbox** - Prioritized conversation queue showing high-value fans first
- **Fan CRM** - Tracks all fan interactions, purchases, spending patterns. Fan segmentation (high-value vs freeloaders)
- **PriceGuard™** - AI-recommended PPV prices per fan based on spending history
- **Vault** - Content library with smart tagging. Tracks which content was sent to which fan. Prevents duplicate sends.
- **Automations** - Bump Messages (auto-message fans when online), Follow-Back Bot, Super Mass (automated message funnels)
- **Team Management** - For agencies: zero-password access, custom permissions, chatter performance dashboards
- **Analytics** - Revenue by channel, top-selling content, Fan LTV, subscriber trends

### Key Terminology
- **PPV** - Pay-Per-View: locked content sold to fans for a one-time fee via DM
- **Fan** - A subscriber/customer on a creator's OnlyFans page
- **Creator** - OnlyFans account owner who produces and sells content
- **Chatter** - Professional chat operator hired to manage fan conversations
- **Agency** - Business managing multiple creator accounts with teams of chatters
- **Bump Message** - Automated message sent to fans when they come online
- **Mass Message** - Broadcast message sent to multiple fans (often with PPV attached)
- **Freeloader** - Fan who engages but never purchases
- **Hidden Spender** - Quiet fan with high spending potential

### User Types
- Solo Creators - Individual OnlyFans content creators
- Agencies - Manage 5-50+ creator accounts with teams of chatters
- Chatters - Employees who handle fan conversations on behalf of creators
`;

const SYSTEM_PROMPT = `You are a technical support assistant for Supercreator.
${PRODUCT_CONTEXT}

Given an issue description, you need to:
1. Clean up and format the description for clarity (fix typos, improve structure, add bullet points if helpful)
2. Suggest a severity level (SEV0-SEV3) based on:
   - SEV0: Complete outage, all users affected, revenue impact, data loss
   - SEV1: Major feature broken, many users affected, significant functionality loss
   - SEV2: Feature degraded, some users affected, workaround may exist
   - SEV3: Minor issue, cosmetic problem, workaround available, low impact

Return ONLY valid JSON in this exact format: {"description": "formatted description here", "severity": "SEV0|SEV1|SEV2|SEV3"}

Do not include any explanation outside the JSON.`;

const TITLE_PROMPT = `You are a technical support assistant for Supercreator.
${PRODUCT_CONTEXT}

Given an issue description, generate a concise, clear title that describes what is broken or not working.

Rules:
- Maximum 80 characters
- Use correct product terminology (Izzy, Super Inbox, Fan CRM, PriceGuard, Vault, etc.)
- Describe the PROBLEM, not the solution
- Use phrases like "[Feature] isn't working", "[Feature] shows error", "Unable to [action]", "[Feature] not loading"
- Be specific about what's broken
- No punctuation at the end
- Never start with "Fix" or solution-oriented verbs

Examples:
- Good: "Izzy AI isn't responding to fan messages in Autopilot mode"
- Bad: "Fix Izzy AI functionality issue"
- Good: "PriceGuard showing incorrect PPV recommendations"
- Bad: "Price recommendations wrong"
- Good: "Super Inbox not prioritizing high-value fans"
- Bad: "Inbox sorting broken"
- Good: "Vault not tracking sent content to fans"
- Bad: "Content tracking issue"

Return ONLY the title text, nothing else.`;

const FEATURE_TITLE_PROMPT = `You are a product manager for Supercreator.
${PRODUCT_CONTEXT}

Given a feature request description, generate a concise, clear title that describes what feature should be added or improved.

Rules:
- Maximum 80 characters
- Use correct product terminology (Izzy, Super Inbox, Fan CRM, PriceGuard, Vault, etc.)
- Phrase as a REQUEST, not a bug
- Start with action verbs like "Add", "Enable", "Implement", "Support", "Allow", "Improve", "Integrate"
- Be specific about what feature is being requested
- No punctuation at the end
- Never use bug-like phrasing ("isn't working", "broken", "error", "fix")

Examples:
- Good: "Add bulk PPV pricing in PriceGuard"
- Bad: "PPV pricing feature"
- Good: "Enable Izzy to send voice messages"
- Bad: "Voice messages for AI"
- Good: "Add fan spending history to Super Inbox"
- Bad: "Show spending in inbox"
- Good: "Support multiple Vault folders per creator"
- Bad: "More folders needed"
- Good: "Integrate bump message scheduling with timezone"
- Bad: "Timezone for bumps"

Return ONLY the title text, nothing else.`;

function getOpenAIClient(): OpenAI {
  const config = getConfig();
  if (!config.openaiApiKey) {
    throw new Error('OpenAI API key not configured');
  }
  return new OpenAI({ apiKey: config.openaiApiKey });
}

export async function formatAndSuggestSeverity(
  rawDescription: string,
  context?: { accountCount?: number; creatorCount?: number },
): Promise<OpenAIFormatResponse> {
  const client = getOpenAIClient();

  let userMessage = rawDescription;
  if (context) {
    const contextParts: string[] = [];
    if (context.accountCount !== undefined) {
      contextParts.push(`${context.accountCount} account(s) affected`);
    }
    if (context.creatorCount !== undefined) {
      contextParts.push(`${context.creatorCount} creator(s) affected`);
    }
    if (contextParts.length > 0) {
      userMessage = `[Context: ${contextParts.join(', ')}]\n\n${rawDescription}`;
    }
  }

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.3,
    max_tokens: 1000,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('Empty response from OpenAI');
  }

  try {
    const parsed = JSON.parse(content) as {
      description: string;
      severity: string;
    };

    const validSeverities: Severity[] = ['SEV0', 'SEV1', 'SEV2', 'SEV3', ''];
    const severity = validSeverities.includes(parsed.severity as Severity)
      ? (parsed.severity as Severity)
      : 'SEV2';

    return {
      description: parsed.description || rawDescription,
      severity,
    };
  } catch {
    throw new Error(`Failed to parse OpenAI response: ${content}`);
  }
}

export async function generateTitle(description: string): Promise<string> {
  const client = getOpenAIClient();

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: TITLE_PROMPT },
      { role: 'user', content: description },
    ],
    temperature: 0.3,
    max_tokens: 100,
  });

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) {
    throw new Error('Empty response from OpenAI');
  }

  // Ensure max 80 chars
  return content.length > 80 ? content.slice(0, 77) + '...' : content;
}

export async function generateFeatureTitle(description: string): Promise<string> {
  const client = getOpenAIClient();

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: FEATURE_TITLE_PROMPT },
      { role: 'user', content: description },
    ],
    temperature: 0.3,
    max_tokens: 100,
  });

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) {
    throw new Error('Empty response from OpenAI');
  }

  // Ensure max 80 chars
  return content.length > 80 ? content.slice(0, 77) + '...' : content;
}
