/**
 * Unit tests for CommandRegistry.
 */

import { CommandRegistry, type CommandContext } from '../../src/services/command-registry.js';

function mkCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  const respond = jest.fn();
  return {
    subCommand: 'help',
    args: [],
    incidentId: 'C1',
    userId: 'U1',
    channelId: 'C1',
    rawCommand: {} as never,
    slack: {} as never,
    respond: respond as never,
    ...overrides,
  };
}

describe('CommandRegistry', () => {
  it('CMD-REG-001: dispatches to registered handler', async () => {
    const handler = jest.fn();
    const registry = new CommandRegistry().register('help', handler);
    await registry.dispatch(mkCtx({ subCommand: 'help' }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('CMD-REG-002: is case-insensitive', async () => {
    const handler = jest.fn();
    const registry = new CommandRegistry().register('Help', handler);
    await registry.dispatch(mkCtx({ subCommand: 'HELP' }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('CMD-REG-003: unknown subcommand replies with unknown-command text', async () => {
    const respond = jest.fn();
    const registry = new CommandRegistry().register('help', jest.fn());
    await registry.dispatch(mkCtx({ subCommand: 'nonsense', respond: respond as never }));
    expect(respond).toHaveBeenCalledWith({ text: expect.stringContaining('Unknown command') });
  });

  it('CMD-REG-004: registeredCommands returns lowercase names', () => {
    const registry = new CommandRegistry().register('Foo', jest.fn()).register('BAR', jest.fn());
    expect(registry.registeredCommands().sort()).toEqual(['bar', 'foo']);
  });

  it('CMD-REG-005: later register replaces earlier handler', async () => {
    const first = jest.fn();
    const second = jest.fn();
    const registry = new CommandRegistry().register('x', first).register('x', second);
    await registry.dispatch(mkCtx({ subCommand: 'x' }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
  });
});
