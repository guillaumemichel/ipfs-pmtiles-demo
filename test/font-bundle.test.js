import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FontBundle } from '../src/font-bundle.js';
import { deterministicBytes, flipByte, rangeFetch, testFontBundle } from './helpers.js';

const glyphBytes = deterministicBytes(150, 31);
const fixture = await testFontBundle({
  fonts: [{ path: 'fonts/Noto Sans Regular/0-255.pbf', content: glyphBytes }],
});

function openBundle(opts = {}) {
  return FontBundle.open(fixture.rootCid, [{ type: 'range', url: '.' }], {
    ...opts,
    fetchFn: rangeFetch(opts.files ?? fixture.files, opts),
  });
}

test('glyph protocol resolves URL-encoded nested paths', async () => {
  const bundle = await openBundle();
  const { data } = await bundle.protocolHandler()({
    url: 'verified://Noto%20Sans%20Regular/0-255.pbf',
  });
  assert.deepEqual(new Uint8Array(data), glyphBytes);
  assert.ok(bundle.stats.verified >= 2); // proofs file + glyph
});

test('missing glyph range resolves to an empty response, not an error', async () => {
  const bundle = await openBundle();
  const handler = bundle.protocolHandler();
  for (const url of [
    'verified://Noto%20Sans%20Regular/64512-64767.pbf',
    'verified://No%20Such%20Font/0-255.pbf',
  ]) {
    const { data } = await handler({ url });
    assert.equal(data.byteLength, 0, url);
  }
});

test('opening with a wrong root CID fails reconstruction', async () => {
  const other = fixture.dag.children.find((c) => c.name === 'fonts').cid.toString();
  await assert.rejects(
    FontBundle.open(other, [{ type: 'range', url: '.' }], {
      fetchFn: rangeFetch(fixture.files),
    }),
    /does not reconstruct/,
  );
});

test('a tampered proofs file blocks glyphs', async () => {
  const files = new Map(fixture.files);
  files.set('proofs', flipByte(files.get('proofs')));
  const bundle = await openBundle({ files });
  await assert.rejects(
    bundle.protocolHandler()({ url: 'verified://Noto%20Sans%20Regular/0-255.pbf' }),
    AggregateError,
  );
  assert.ok(bundle.stats.rejected > 0);
});

test('a failed proofs fetch stays retryable', async () => {
  const files = new Map(fixture.files);
  files.delete('proofs');
  const bundle = await openBundle({ files });
  const handler = bundle.protocolHandler();
  const url = 'verified://Noto%20Sans%20Regular/0-255.pbf';
  await assert.rejects(handler({ url }), AggregateError);

  files.set('proofs', fixture.files.get('proofs')); // host recovers
  const { data } = await handler({ url });
  assert.deepEqual(new Uint8Array(data), glyphBytes);
});

test('tampered glyph bytes are rejected', async () => {
  const bundle = await openBundle({
    tamper: (path, _range, bytes) => (path.endsWith('.pbf') ? flipByte(bytes) : bytes),
  });
  await assert.rejects(
    bundle.protocolHandler()({ url: 'verified://Noto%20Sans%20Regular/0-255.pbf' }),
    AggregateError,
  );
  assert.ok(bundle.stats.rejected > 0);
});
