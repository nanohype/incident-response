/**
 * Unit tests for slash-command input validation.
 * Protects the downstream audit write from an oversized-payload DOS.
 */

import { SlashCommandTextSchema, SlashCommandArgsSchema } from '../../src/services/command-registry.js';

describe('SlashCommandTextSchema', () => {
  it('SLASH-001: accepts empty text', () => {
    expect(SlashCommandTextSchema.safeParse('').success).toBe(true);
  });

  it('SLASH-002: accepts normal command text', () => {
    expect(SlashCommandTextSchema.safeParse('status draft').success).toBe(true);
  });

  it('SLASH-003: rejects text longer than 500 characters', () => {
    const big = 'a'.repeat(501);
    expect(SlashCommandTextSchema.safeParse(big).success).toBe(false);
  });

  it('SLASH-004: accepts exactly 500 characters', () => {
    expect(SlashCommandTextSchema.safeParse('a'.repeat(500)).success).toBe(true);
  });
});

describe('SlashCommandArgsSchema', () => {
  it('SLASH-ARGS-001: accepts empty args', () => {
    expect(SlashCommandArgsSchema.safeParse([]).success).toBe(true);
  });

  it('SLASH-ARGS-002: accepts up to 10 tokens', () => {
    expect(SlashCommandArgsSchema.safeParse(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']).success).toBe(true);
  });

  it('SLASH-ARGS-003: rejects more than 10 tokens', () => {
    expect(SlashCommandArgsSchema.safeParse(Array(11).fill('a')).success).toBe(false);
  });

  it('SLASH-ARGS-004: rejects a token longer than 100 characters', () => {
    expect(SlashCommandArgsSchema.safeParse(['a'.repeat(101)]).success).toBe(false);
  });

  it('SLASH-ARGS-005: accepts tokens exactly 100 characters', () => {
    expect(SlashCommandArgsSchema.safeParse(['a'.repeat(100)]).success).toBe(true);
  });
});
