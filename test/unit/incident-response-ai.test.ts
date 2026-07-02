/**
 * Unit tests for IncidentResponseAI — Bedrock wrapper.
 *
 * Focus: the classification boundary. Haiku's output is untrusted text —
 * malformed JSON, wrong-shape JSON, and transport failures must all land on
 * the safe `{ is_status_update: false, confidence: 0 }` fallback, never throw
 * into the Slack message path. Model IDs must come from the zod-validated
 * env config defaults.
 */

import { BedrockRuntimeClient, InvokeModelCommand, type InvokeModelCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-vitest/extend';

import { IncidentResponseAI } from '../../src/ai/incident-response-ai.js';
import { config } from '../../src/config/index.js';
import type { GrafanaOnCallAlertPayload } from '../../src/types/index.js';

const bedrockMock = mockClient(BedrockRuntimeClient);

function bedrockTextResponse(text: string): { body: InvokeModelCommandOutput['body'] } {
  // The wrapper only Buffer.from()s the bytes — a plain Buffer satisfies it;
  // the blob-adapter methods on the SDK's response type are never touched.
  const bytes = Buffer.from(JSON.stringify({ content: [{ type: 'text', text }] }));
  return { body: bytes as unknown as InvokeModelCommandOutput['body'] };
}

const alert: GrafanaOnCallAlertPayload = {
  alert_group_id: 'ag-1',
  alert_group: { id: 'ag-1', title: 'API error rate breach', state: 'firing' },
  integration_id: 'int-1',
  route_id: 'r-1',
  team_id: 't-1',
  team_name: 'Payments',
  alerts: [],
};

describe('IncidentResponseAI', () => {
  let ai: IncidentResponseAI;

  beforeEach(() => {
    bedrockMock.reset();
    ai = new IncidentResponseAI('us-west-2');
  });

  describe('classifyAsStatusUpdate', () => {
    it('AI-CLS-001: returns the parsed result for well-formed classifier output', async () => {
      bedrockMock.on(InvokeModelCommand).resolves(bedrockTextResponse('{"is_status_update": true, "confidence": 0.92}'));
      const result = await ai.classifyAsStatusUpdate('DB failover complete, error rate recovering', 'inc-1');
      expect(result).toEqual({ is_status_update: true, confidence: 0.92 });
    });

    it('AI-CLS-002: falls back to {false, 0} when the output is valid JSON of the wrong shape', async () => {
      bedrockMock.on(InvokeModelCommand).resolves(bedrockTextResponse('{"is_status_update": "yes", "confidence": "high"}'));
      const result = await ai.classifyAsStatusUpdate('on it', 'inc-1');
      expect(result).toEqual({ is_status_update: false, confidence: 0 });
    });

    it('AI-CLS-003: falls back to {false, 0} when required fields are missing', async () => {
      bedrockMock.on(InvokeModelCommand).resolves(bedrockTextResponse('{"confidence": 0.5}'));
      const result = await ai.classifyAsStatusUpdate('checking dashboards', 'inc-1');
      expect(result).toEqual({ is_status_update: false, confidence: 0 });
    });

    it('AI-CLS-004: falls back to {false, 0} when the output is not JSON at all', async () => {
      bedrockMock.on(InvokeModelCommand).resolves(bedrockTextResponse('Sure! Here is the classification you asked for:'));
      const result = await ai.classifyAsStatusUpdate('ok', 'inc-1');
      expect(result).toEqual({ is_status_update: false, confidence: 0 });
    });

    it('AI-CLS-005: falls back to {false, 0} when Bedrock itself fails', async () => {
      bedrockMock.on(InvokeModelCommand).rejects(new Error('ThrottlingException'));
      const result = await ai.classifyAsStatusUpdate('mitigation deployed', 'inc-1');
      expect(result).toEqual({ is_status_update: false, confidence: 0 });
    });

    it('AI-CLS-006: invokes the Haiku model ID from the env config', async () => {
      bedrockMock.on(InvokeModelCommand).resolves(bedrockTextResponse('{"is_status_update": false, "confidence": 0.1}'));
      await ai.classifyAsStatusUpdate('@here', 'inc-1');
      expect(bedrockMock).toHaveReceivedCommandWith(InvokeModelCommand, { modelId: config.BEDROCK_HAIKU_MODEL_ID });
    });
  });

  describe('generateStatusDraft', () => {
    it('AI-DRAFT-001: returns the Bedrock draft with PII redacted (vendored typed tokens), using the Sonnet model ID from the env config', async () => {
      bedrockMock
        .on(InvokeModelCommand)
        .resolves(bedrockTextResponse('Some customers may see errors. Contact ops@example.com for updates.'));
      const draft = await ai.generateStatusDraft(alert, undefined, undefined, 'inc-1');
      expect(draft).toBe('Some customers may see errors. Contact [EMAIL] for updates.');
      expect(bedrockMock).toHaveReceivedCommandWith(InvokeModelCommand, { modelId: config.BEDROCK_SONNET_MODEL_ID });
    });

    it('AI-DRAFT-002: returns the safe template when Bedrock fails', async () => {
      bedrockMock.on(InvokeModelCommand).rejects(new Error('ServiceUnavailable'));
      const draft = await ai.generateStatusDraft(alert, undefined, undefined, 'inc-1');
      expect(draft).toContain('We are currently investigating an issue affecting payments services');
    });
  });
});
