/**
 * Streamable-HTTP MCP server — the read + draft pull surface.
 *
 * Runs inside the processor Deployment on its own port (`MCP_PORT`, default
 * 3002), separate from the processor health server (3001). Stateless mode: each
 * request gets a fresh `Server` + transport, so there is no session state to
 * carry across the tunnel. The mcp-tunnel (outbound-only `cloudflared`) is the
 * only ingress to this port — enforced by the chart NetworkPolicy locking it to
 * the `mcp-tunnel` namespace.
 */

import * as http from 'http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { registerTools, type McpToolDeps } from './tools.js';
import { logger } from '../utils/logger.js';
import { stringifyError } from '../utils/errors.js';

/** The path the streamable-HTTP transport is served on. */
export const MCP_PATH = '/mcp';

/**
 * Construct the MCP server for one connection. Tools are stateless functions
 * over the injected deps, so a fresh server per request is correct and avoids
 * session bookkeeping — the tunnel routes each request to this in-cluster
 * surface by hostname.
 */
export function createMcpServer(deps: McpToolDeps): Server {
  const server = new Server(
    { name: 'incident-response', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  registerTools(server, deps);
  return server;
}

export interface McpHttpServer {
  listen(port: number): Promise<void>;
  close(): Promise<void>;
}

/** Streamable-HTTP MCP server bound on its own port. */
export function createMcpHttpServer(deps: McpToolDeps): McpHttpServer {
  const httpServer = http.createServer((req, res) => {
    void handleRequest(req, res, deps);
  });

  return {
    listen: (port) => new Promise<void>((resolve) => httpServer.listen(port, resolve)),
    close: () =>
      new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: McpToolDeps,
): Promise<void> {
  const url = req.url ?? '';
  if (!url.startsWith(MCP_PATH)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'not_found' }));
    return;
  }

  const server = createMcpServer(deps);
  // Stateless: omitting `sessionIdGenerator` runs the transport with no session
  // id (the tunnel proxies plain request/response), and `enableJsonResponse`
  // returns a single JSON body rather than an SSE stream.
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    // The SDK transport class carries optional callbacks (onclose?, onmessage?)
    // that trip `exactOptionalPropertyTypes` when structurally matched against
    // the `Transport` parameter — the instance is a valid Transport at runtime.
    // Narrow the cast to this one seam rather than relaxing the flag repo-wide.
    await server.connect(transport as unknown as Transport);
    const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
    await transport.handleRequest(req, res, body);
  } catch (err) {
    logger.error({ error: stringifyError(err) }, 'mcp request failed');
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        }),
      );
    }
  }
}

/** Collect and parse a JSON request body; `undefined` for an empty body. */
async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw) return undefined;
  return JSON.parse(raw);
}
