/**
 * Unit tests for EventRegistry.
 */

import { EventRegistry } from '../../src/services/event-registry.js';

interface Msg {
  type: string;
  data?: string;
}

describe('EventRegistry', () => {
  it('EVT-REG-001: dispatches by event type', async () => {
    const h = jest.fn();
    const registry = new EventRegistry<Msg>('test').on('FOO', h);
    await registry.dispatch({ type: 'FOO', data: 'x' });
    expect(h).toHaveBeenCalledWith({ type: 'FOO', data: 'x' });
  });

  it('EVT-REG-002: unknown event type is a no-op (logged warn)', async () => {
    const h = jest.fn();
    const registry = new EventRegistry<Msg>('test').on('FOO', h);
    await registry.dispatch({ type: 'UNKNOWN' });
    expect(h).not.toHaveBeenCalled();
  });

  it('EVT-REG-003: propagates handler errors', async () => {
    const h = jest.fn().mockRejectedValue(new Error('handler boom'));
    const registry = new EventRegistry<Msg>('test').on('FOO', h);
    await expect(registry.dispatch({ type: 'FOO' })).rejects.toThrow('handler boom');
  });

  it('EVT-REG-004: registeredTypes lists handlers in registration order', () => {
    const registry = new EventRegistry<Msg>('test').on('A', jest.fn()).on('B', jest.fn());
    expect(registry.registeredTypes()).toEqual(['A', 'B']);
  });
});
