/**
 * Command registry wiring — keeps index.ts thin.
 */

import { CommandRegistry } from '../services/command-registry.js';
import { makeHelpHandler } from '../commands/help.js';
import { makeSilenceHandler } from '../commands/silence.js';
import { makeChecklistHandler } from '../commands/checklist.js';
import { makeStatusHandler } from '../commands/status.js';
import { makeResolveHandler } from '../commands/resolve.js';
import type { Dependencies } from './dependencies.js';

export function buildCommandRegistry(deps: Dependencies): CommandRegistry {
  return new CommandRegistry()
    .register('help', makeHelpHandler())
    .register('silence', makeSilenceHandler({ nudgeScheduler: deps.nudgeScheduler, auditWriter: deps.auditWriter }))
    .register('checklist', makeChecklistHandler())
    .register(
      'status',
      makeStatusHandler({
        docClient: deps.dynamoDb,
        incidentsTableName: deps.incidentsTableName,
        marshalAI: deps.marshalAI,
        approvalGate: deps.approvalGate,
      }),
    )
    .register(
      'resolve',
      makeResolveHandler({
        docClient: deps.dynamoDb,
        incidentsTableName: deps.incidentsTableName,
        marshalAI: deps.marshalAI,
        linearClient: deps.linearClient,
        githubClient: deps.githubClient,
        nudgeScheduler: deps.nudgeScheduler,
        auditWriter: deps.auditWriter,
        githubRepoNames: deps.githubRepoNames,
        metrics: deps.metrics,
      }),
    );
}
