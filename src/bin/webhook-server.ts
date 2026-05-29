/**
 * Webhook server — HTTP wrapper around the Lambda-shaped webhook handler.
 *
 * On AWS, src/handlers/webhook-ingress.ts ran behind API Gateway as
 * APIGatewayProxyHandlerV2. On k8s, this thin wrapper invokes the same
 * handler module over a node:http listener on PORT (default 3001). Same
 * HMAC verification, same idempotency check, same SQS enqueue — only the
 * transport layer changes.
 */

import * as http from 'http';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

import { handler } from '../handlers/webhook-ingress.js';
import { logger } from '../utils/logger.js';

const PORT = Number.parseInt(process.env['PORT'] ?? '3001', 10);

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function flattenHeaders(raw: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.join(',');
  }
  return out;
}

function buildLambdaEvent(req: http.IncomingMessage, body: string): APIGatewayProxyEventV2 {
  const path = req.url ?? '/';
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: flattenHeaders(req.headers),
    requestContext: {
      accountId: 'k8s',
      apiId: 'k8s-webhook',
      domainName: req.headers.host ?? 'k8s-webhook.local',
      domainPrefix: 'k8s-webhook',
      http: {
        method: req.method ?? 'POST',
        path,
        protocol: 'HTTP/1.1',
        sourceIp: req.socket.remoteAddress ?? '0.0.0.0',
        userAgent: req.headers['user-agent'] ?? '',
      },
      requestId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      routeKey: '$default',
      stage: '$default',
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
    },
    body,
    isBase64Encoded: false,
  };
}

function writeResult(res: http.ServerResponse, result: APIGatewayProxyResultV2): void {
  // The Lambda handler returns either a string (treated as 200 body) or an
  // APIGatewayProxyStructuredResultV2 object with statusCode/headers/body.
  if (typeof result === 'string') {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/plain');
    res.end(result);
    return;
  }
  res.statusCode = result.statusCode ?? 200;
  for (const [k, v] of Object.entries(result.headers ?? {})) {
    res.setHeader(k, String(v));
  }
  res.end(result.body ?? '');
}

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/healthz' || req.url === '/readyz') {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end('{"status":"ok"}');
    return;
  }

  // Only POST to the webhook endpoint is meaningful — Grafana OnCall
  // ships the payload there. Reject everything else cheaply.
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end('method not allowed');
    return;
  }

  readBody(req)
    .then(async (body) => {
      const event = buildLambdaEvent(req, body);
      try {
        // The Lambda type allows handler to return void / null when invoked
        // with a callback; here we use the promise form, so the result is
        // always defined.
        const result = (await (handler as (e: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>)(
          event,
        )) as APIGatewayProxyResultV2;
        writeResult(res, result);
      } catch (err) {
        logger.error({ err }, 'webhook handler error');
        res.statusCode = 500;
        res.end('internal error');
      }
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'webhook body read error');
      res.statusCode = 400;
      res.end('bad request');
    });
});

server.listen(PORT, () => {
  logger.info({ port: PORT }, 'webhook server listening');
});

const shutdown = (signal: string): void => {
  logger.info({ signal }, 'webhook server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
