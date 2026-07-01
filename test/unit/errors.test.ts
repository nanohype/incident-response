/**
 * Unit tests for stringifyError — the one error-normalization helper every
 * structured-log `error:` field goes through. Both ternary arms are hit
 * explicitly so error-path logging keeps full branch coverage.
 */

import { stringifyError } from '../../src/utils/errors.js';

describe('stringifyError()', () => {
  it('ERR-001: Error instances return err.message', () => {
    expect(stringifyError(new Error('boom'))).toBe('boom');
  });

  it('ERR-002: non-Error values return String(err)', () => {
    expect(stringifyError('plain string')).toBe('plain string');
    expect(stringifyError(42)).toBe('42');
    expect(stringifyError({ foo: 'bar' })).toBe('[object Object]');
    expect(stringifyError(null)).toBe('null');
    expect(stringifyError(undefined)).toBe('undefined');
  });
});
