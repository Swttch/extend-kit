import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitForSpeech } from './stream.js';

describe('splitForSpeech', () => {
  it('gives nothing for empty text', () => {
    assert.deepEqual(splitForSpeech('   '), []);
  });

  it('keeps short text in one piece', () => {
    assert.deepEqual(splitForSpeech('Hello there.'), ['Hello there.']);
  });

  it('cuts long text at sentence ends, each piece within the limit', () => {
    const sentence = 'This is a sentence of a reasonable length that is read aloud.';
    const text = Array.from({ length: 40 }, () => sentence).join(' ');
    const pieces = splitForSpeech(text);
    assert.ok(pieces.length > 1);
    for (const piece of pieces) assert.ok(piece.length <= 800);
    assert.equal(pieces.join(' ').replace(/\s+/g, ' '), text);
  });

  it('cuts a single endless sentence where it stands', () => {
    const pieces = splitForSpeech('x'.repeat(2000));
    assert.deepEqual(pieces.map((p) => p.length), [800, 800, 400]);
  });
});
