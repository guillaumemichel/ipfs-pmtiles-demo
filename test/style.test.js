import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';

import { buildStyle } from '../scripts/lib/style.js';

const style = buildStyle({
  mapAnchor: 'bafymap',
  elevationAnchor: 'bafyelevation',
  fontsAnchor: 'bafyfonts',
  spritesAnchor: 'bafysprites',
});
const ids = style.layers.map((layer) => layer.id);

test('the style is valid MapLibre', () => {
  assert.deepEqual(validateStyleMin(style), []);
});

test('every reference in the style names an anchor', () => {
  assert.equal(style.sources['pmtiles-source'].url, 'pmtiles://bafymap');
  const dem = Object.values(style.sources).filter((source) => source.type === 'raster-dem');
  assert.ok(dem.length > 0);
  for (const source of dem) assert.equal(source.url, 'elevation://bafyelevation');
  assert.equal(style.glyphs, 'verified://bafyfonts/{fontstack}/{range}.pbf');
  assert.equal(style.sprite, 'verified://bafysprites/light');
});

// The full planet carries detail the z0–6 set never had.
test('the style draws roads, rivers, buildings and land use', () => {
  const draws = (sourceLayer, type) =>
    style.layers.some((layer) => layer['source-layer'] === sourceLayer && layer.type === type);
  assert.ok(draws('roads', 'line'), 'roads');
  assert.ok(draws('water', 'line'), 'rivers');
  assert.ok(draws('buildings', 'fill'), 'buildings');
  assert.ok(draws('landuse', 'fill'), 'land use');
});

// Only Noto Sans Regular is bundled: a label in any other font would not render.
test('every label uses the bundled font', () => {
  const strings = (value) => (Array.isArray(value) ? value.flatMap(strings) : typeof value === 'string' ? [value] : []);
  const fonts = style.layers.flatMap((layer) => strings(layer.layout?.['text-font'])).filter((s) => /Noto|Sans|Serif/.test(s));
  assert.ok(fonts.length > 0);
  assert.deepEqual([...new Set(fonts)], ['Noto Sans Regular']);
});

test('hillshade shades the land, under the water', () => {
  assert.ok(ids.indexOf('earth') < ids.indexOf('hillshade'));
  assert.ok(ids.indexOf('hillshade') < ids.indexOf('water'));
});
