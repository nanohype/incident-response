/**
 * IncidentResponse AI Layer — Bedrock-backed generation and classification.
 *
 * Models:
 *   - claude-sonnet-4-6: status page drafts, postmortem narrative
 *   - claude-haiku-4-5: message classification, checklist routing
 *
 * Prompt caching on system prompts (Anthropic cache_control ephemeral).
 * Invocation logging: NONE — enforced at the account level by landing-zone, not in-app.
 * Guardrails: strip customer-identifying patterns; safe fallback on Bedrock failure.
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { z } from 'zod';
import { GrafanaContextSnapshot, GrafanaOnCallAlertPayload } from '../types/index.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { stringifyError } from '../utils/errors.js';

// Model IDs come from the zod-validated env config (BEDROCK_*_MODEL_ID),
// so an environment can pin a snapshot or inference profile without a deploy.
const SONNET_MODEL_ID = config.BEDROCK_SONNET_MODEL_ID;
const HAIKU_MODEL_ID = config.BEDROCK_HAIKU_MODEL_ID;

// The classifier's contract with the Haiku prompt. LLM output is an untrusted
// boundary like any webhook body — validate the shape, never cast it.
const ClassificationResultSchema = z.object({
  is_status_update: z.boolean(),
  confidence: z.number(),
});

const STATUS_DRAFT_SYSTEM_PROMPT = `You are IncidentResponse, an incident assistant. Draft a customer-facing status page message about a service disruption.

RULES (no exceptions):
1. Generic language only: "some customers", "a subset of requests", "certain features"
2. NEVER include: customer names, account IDs, internal hostnames, employee names, DB names, IP addresses
3. IC reviews before publishing; write for customers who depend on the service
4. Clear, calm, professional; acknowledge impact; state team is investigating; no root-cause speculation
5. 2-4 sentences maximum; plain language; transparent and reassuring without over-promising

FORMAT: Return only the draft body text. No preamble, no explanation.`;

const POSTMORTEM_SYSTEM_PROMPT = `You are IncidentResponse, an incident assistant. Populate a postmortem document template with factual incident data.

RULES:
1. Only facts from provided incident data — do not speculate or infer root causes
2. Precise, chronological timelines
3. Root Cause Analysis and Action Items: leave as [IC to complete] — do NOT fill them in
4. Past tense, technical but readable by any senior engineer
5. Clean Markdown for Linear issue description

FORMAT: Return only the Markdown content. No preamble.`;

const CLASSIFICATION_SYSTEM_PROMPT = `Classify whether a Slack message by an Incident Commander constitutes a status update.

Status update = reports current status, describes findings/actions, updates next steps, communicates impact/timeline.
NOT a status update = @mentions, short acks ("ok", "on it"), questions, bot commands (/incident-response...), emoji reactions.

Respond ONLY with JSON: {"is_status_update": true|false, "confidence": 0.0-1.0}`;

const CUSTOMER_PATTERNS = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  /\bcust-[0-9]+\b/gi,
  /\baccount[-_]?id[:=\s][^\s,]+/gi,
  /\b(?:10|172|192)\.(?:\d{1,3}\.){2}\d{1,3}\b/g,
  /\bprod-[a-z0-9-]+\.[a-z]+\b/gi,
  /\bdb-[a-z0-9-]+\b/gi,
];

function stripPII(text: string): string {
  let t = text;
  for (const p of CUSTOMER_PATTERNS) t = t.replace(p, '[REDACTED]');
  return t;
}

export interface PostmortemInput {
  incident_id: string;
  title: string;
  slack_channel_name: string;
  duration_minutes: number;
  timeline_events: Array<{ timestamp: string; description: string }>;
  participants: Array<{ name: string; role: string }>;
  metrics_summary: string;
  recent_deploys: string[];
  statuspage_updates: Array<{ timestamp: string; body: string }>;
  ic_rating?: number;
}

export class IncidentResponseAI {
  private readonly bedrock: BedrockRuntimeClient;

  constructor(awsRegion: string) {
    this.bedrock = new BedrockRuntimeClient({
      region: awsRegion,
      requestHandler: new NodeHttpHandler({ requestTimeout: 10000 }),
    });
  }

  async generateStatusDraft(
    alert: GrafanaOnCallAlertPayload,
    snap: GrafanaContextSnapshot | undefined,
    icMsg: string | undefined,
    incidentId: string,
  ): Promise<string> {
    const parts = [`INCIDENT: ${alert.alert_group.title}`, `TEAM: ${alert.team_name}`, `FIRED AT: ${new Date().toISOString()}`];
    if (snap)
      parts.push(
        `ERROR RATE: ${(snap.error_rate_2h.current * 100).toFixed(2)}%`,
        `P99 LATENCY: ${snap.p99_latency_ms.current.toFixed(0)}ms`,
        `ERROR BUDGET BURN: ${snap.error_budget_burn_rate.toFixed(1)}x`,
      );
    if (icMsg) parts.push(`IC RECENT MESSAGE (context only): ${icMsg.substring(0, 300)}`);
    parts.push('', 'Draft a customer-facing status page message. Follow all rules from the system prompt.');
    try {
      const resp = await this.invoke(SONNET_MODEL_ID, STATUS_DRAFT_SYSTEM_PROMPT, parts.join('\n'), 500);
      logger.info({ incident_id: incidentId }, 'Status page draft generated by Bedrock');
      return stripPII(resp.trim());
    } catch (err) {
      logger.warn({ incident_id: incidentId, error: stringifyError(err) }, 'Bedrock status draft failed — returning template');
      return `We are currently investigating an issue affecting ${alert.team_name.toLowerCase()} services. Some customers may be experiencing [describe impact]. Our team is actively working to resolve this issue and will provide updates every 30 minutes.`;
    }
  }

  async generatePostmortemSections(data: PostmortemInput, incidentId: string): Promise<string> {
    const userContent = `INCIDENT ID: ${data.incident_id}\nTITLE: ${data.title}\nSEVERITY: P1\nSLACK CHANNEL: ${data.slack_channel_name}\nDURATION: ${data.duration_minutes} minutes\n\nTIMELINE:\n${data.timeline_events.map((e) => `- ${e.timestamp}: ${e.description}`).join('\n')}\n\nPARTICIPANTS:\n${data.participants.map((p) => `- ${p.name} (${p.role})`).join('\n')}\n\nMETRICS:\n${data.metrics_summary}\n\nRECENT DEPLOYS:\n${data.recent_deploys.map((d) => `- ${d}`).join('\n')}\n\nSTATUS PAGE UPDATES:\n${data.statuspage_updates.map((u) => `- ${u.timestamp}: ${u.body}`).join('\n')}\n\nIC RATING: ${data.ic_rating ?? 'Not provided'}\n\nGenerate postmortem sections 1-10 as Markdown. Root Cause Analysis = [IC to complete]. Action Items = empty table.`;
    try {
      const resp = await this.invoke(SONNET_MODEL_ID, POSTMORTEM_SYSTEM_PROMPT, userContent, 2000);
      logger.info({ incident_id: incidentId }, 'Postmortem sections generated by Bedrock');
      return resp.trim();
    } catch (err) {
      logger.warn({ incident_id: incidentId, error: stringifyError(err) }, 'Bedrock postmortem failed — returning template');
      return `## Incident Summary\n\n**ID:** ${data.incident_id} | **Severity:** P1 | **Duration:** ${data.duration_minutes}min\n\n## Timeline\n\n${data.timeline_events.map((e) => `- **${e.timestamp}** — ${e.description}`).join('\n')}\n\n## Participants\n\n${data.participants.map((p) => `- ${p.name} — ${p.role}`).join('\n')}\n\n## Metrics\n\n${data.metrics_summary}\n\n## Root Cause Analysis\n\n[IC to complete]\n\n## Action Items\n\n| Action | Owner | Due Date |\n|--------|-------|----------|\n| | | |\n\n## What Went Well\n\n[IC to complete]\n`;
    }
  }

  async classifyAsStatusUpdate(messageText: string, incidentId: string): Promise<{ is_status_update: boolean; confidence: number }> {
    try {
      const resp = await this.invoke(
        HAIKU_MODEL_ID,
        CLASSIFICATION_SYSTEM_PROMPT,
        `Message to classify: "${messageText.substring(0, 500)}"`,
        50,
      );
      const parsed = ClassificationResultSchema.safeParse(JSON.parse(resp.trim()));
      if (!parsed.success) {
        logger.debug(
          { incident_id: incidentId, error: parsed.error.message },
          'Message classification returned an unexpected shape — defaulting to false',
        );
        return { is_status_update: false, confidence: 0 };
      }
      return parsed.data;
    } catch (err) {
      logger.debug({ incident_id: incidentId, error: stringifyError(err) }, 'Message classification failed — defaulting to false');
      return { is_status_update: false, confidence: 0 };
    }
  }

  private async invoke(modelId: string, systemPrompt: string, userContent: string, maxTokens: number): Promise<string> {
    const body = Buffer.from(
      JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: maxTokens,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userContent }],
      }),
    );
    const resp = await this.bedrock.send(
      new InvokeModelCommand({ modelId, contentType: 'application/json', accept: 'application/json', body }),
    );
    const parsed = JSON.parse(Buffer.from(resp.body).toString('utf8')) as { content: Array<{ type: string; text: string }> };
    const text = parsed.content.find((c) => c.type === 'text');
    if (!text) throw new Error('Bedrock response contained no text content');
    return text.text;
  }
}
