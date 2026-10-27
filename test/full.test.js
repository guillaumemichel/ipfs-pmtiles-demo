import assert from 'node:assert/strict';
import { test } from 'node:test';

import { swapArchive } from '../web/full.js';

// A stand-in for the MapLibre map: the style's sources, and each source's
// setUrl calls.
function fakeMap(sources) {
  const urls = {};
  return {
    urls,
    getStyle: () => ({ sources }),
    getSource: (id) => ({ setUrl: (url) => { urls[id] = url; } }),
  };
}

test('every source reading the small archive reads the full one', () => {
  const map = fakeMap({
    terrain: { type: 'raster-dem', url: 'elevation://bafysmall' },
    relief: { type: 'raster-dem', url: 'elevation://bafysmall' },
    vector: { type: 'vector', url: 'pmtiles://bafymap' },
    inline: { type: 'raster', tiles: ['https://tiles.example/{z}/{x}/{y}.png'] },
  });
  swapArchive(map, 'bafysmall', 'bafyfull');
  assert.deepEqual(map.urls, { terrain: 'elevation://bafyfull', relief: 'elevation://bafyfull' });
});

test('an anchor is matched whole, never as a prefix', () => {
  const map = fakeMap({ vector: { type: 'vector', url: 'pmtiles://bafysmallest' } });
  swapArchive(map, 'bafysmall', 'bafyfull');
  assert.deepEqual(map.urls, {});
});
