import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from './r1-digest';

const reference = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex');

describe('sha256Hex', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    [
      'The quick brown fox jumps over the lazy dog',
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    ],
  ])('matches the published vector for %j', (input, expected) => {
    expect(sha256Hex(input)).toBe(expected);
  });

  it('agrees with the platform implementation across every padding boundary', () => {
    for (let length = 0; length <= 200; length += 1) {
      const input = 'a'.repeat(length);
      expect(sha256Hex(input), `length ${length}`).toBe(reference(input));
    }
  });

  it('hashes multi-byte text as UTF-8', () => {
    for (const input of ['é', 'नमस्ते', 'camera 📷 on', 'x'.repeat(40) + 'é']) {
      expect(sha256Hex(input)).toBe(reference(input));
    }
  });

  it('agrees on a 64-character link token', () => {
    const token = 'd1'.repeat(32);
    expect(sha256Hex(token)).toBe(reference(token));
    expect(sha256Hex(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});
