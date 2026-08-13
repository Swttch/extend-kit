import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { packKeyterms, DEFAULT_KEYTERMS } from './keyterms.js';

describe('packKeyterms', () => {
  it('joins terms with commas', () => {
    assert.equal(packKeyterms(['grep', 'regex']), 'grep,regex');
  });

  it('turns a comma inside a term into a space, so it stays one term', () => {
    // A raw comma would split the term in two on the wire.
    assert.equal(packKeyterms(['hello, world']), 'hello world');
  });

  it('drops non-ASCII, which cannot travel in an HTTP header', () => {
    assert.equal(packKeyterms(['카페', 'cafe']), 'cafe');
  });

  it('collapses runs of whitespace and trims', () => {
    assert.equal(packKeyterms(['  VS   Code  ']), 'VS Code');
  });

  it('removes duplicates so a repeated term does not eat the budget twice', () => {
    assert.equal(packKeyterms(['grep', 'grep', 'regex']), 'grep,regex');
  });

  it('skips terms that are empty once cleaned', () => {
    assert.equal(packKeyterms(['', '   ', '★', 'grep']), 'grep');
  });

  it('stops at the byte cap instead of sending an over-long header', () => {
    const terms = Array.from({ length: 500 }, (_, i) => `term${i}`);
    const packed = packKeyterms(terms);
    assert.ok(packed.length <= 1024, `packed ${packed.length} bytes, expected <= 1024`);
    // It should still carry as much as fits, not give up entirely.
    assert.ok(packed.startsWith('term0,term1,'));
  });

  it('returns an empty string for no terms, so the header can be omitted', () => {
    assert.equal(packKeyterms([]), '');
  });

  it('packs the shipped defaults without hitting the cap', () => {
    const packed = packKeyterms(DEFAULT_KEYTERMS);
    assert.ok(packed.includes('MCP'));
    assert.ok(packed.includes('worktree'));
    assert.ok(packed.length <= 1024);
  });
});
