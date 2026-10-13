// The MapLibre style, built from the freshly derived CIDs so its trust
// references can never drift from the packages beside it. It ships as a
// verified *raw asset* (veritiles SPEC.md A2): the client fetches and hashes it
// against STYLE_CID, then hands the parsed JSON to MapLibre. Every trust
// reference inside points at a content-addressed identifier:
//   - the vector source at pmtiles://<mapRoot> (veritiles VerifiedSource),
//   - glyphs at verified://<fontsAnchor>/{fontstack}/{range}.pbf (VerifiedAsset),
//   - terrain, hillshade and elevation tint at elevation://{z}/{x}/{y} (the
//     app's ocean-tile wrapper over the elevation VerifiedSource), maxzoom baked
//     from the archive header.
//
// The layers read the Protomaps basemap schema of map.pmtiles; colours follow
// a physical atlas: elevation tint under landcover under hillshade.
const COLORS = {
  water: '#a3c7e8',
  earth: '#eee8da',
  border: '#8a7a6c',
  regionBorder: '#b0a497',
  oceanLabel: '#4f77a8',
  countryLabel: '#5b4636',
  placeLabel: '#333333',
  halo: '#ffffff',
};

// Hypsometric tint, metres → colour: green lowlands, tan uplands, white peaks.
const ELEVATION_TINT = [
  0, '#d3e2bd',
  300, '#e3e5bd',
  800, '#e8d9ab',
  1500, '#d8bf98',
  2500, '#c4a68a',
  3500, '#b8a59a',
  4500, '#e2dcd8',
  5500, '#ffffff',
];

const LANDCOVER = [
  'forest', '#9fc79a',
  'grassland', '#cfe3b4',
  'farmland', '#dde9c0',
  'scrub', '#d6dcae',
  'barren', '#f0e2c0',
  'glacier', '#ffffff',
  'urban_area', '#d8d2cc',
];

// Only Noto Sans Regular is bundled, and its glyphs cover Latin, Greek and
// Cyrillic: prefer English names so labels never render as missing glyphs.
const NAME = ['coalesce', ['get', 'name:en'], ['get', 'name']];
const FONT = ['Noto Sans Regular'];

export function buildStyle({ mapAnchor, fontsAnchor, elevationMaxZoom }) {
  const demSource = {
    type: 'raster-dem',
    tiles: ['elevation://{z}/{x}/{y}'],
    encoding: 'terrarium',
    tileSize: 512,
    maxzoom: elevationMaxZoom,
  };
  return {
    version: 8,
    projection: { type: 'globe' },
    sources: {
      'pmtiles-source': { type: 'vector', url: `pmtiles://${mapAnchor}` },
      // Terrain needs a source of its own: MapLibre manages terrain tiles
      // differently from layer tiles, and sharing one makes them fight over
      // loading. Hillshade and the elevation tint share the other.
      terrainSource: { ...demSource },
      reliefSource: { ...demSource },
    },
    glyphs: `verified://${fontsAnchor}/{fontstack}/{range}.pbf`,
    // The DEM stops at z4 (~5 km/px), so relief is broad: 3.5 lifts it into
    // view without the ranges swelling into blobs.
    terrain: { source: 'terrainSource', exaggeration: 3.5 },
    sky: {
      'sky-color': '#5d9cec',
      'horizon-color': '#dcebf7',
      'fog-color': '#eaf2f8',
      // Keep the haze at the horizon, not over the terrain in view.
      'fog-ground-blend': 0.9,
      // The glow frames the globe but washes out pitched views: gone by z5.
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 3, 1, 5, 0],
    },
    layers: [...groundLayers(), ...boundaryLayers(), ...labelLayers()],
  };
}

function groundLayers() {
  return [
    // Anything the vector tiles leave uncovered is open sea.
    { id: 'background', type: 'background', paint: { 'background-color': COLORS.water } },
    {
      id: 'earth',
      type: 'fill',
      source: 'pmtiles-source',
      'source-layer': 'earth',
      paint: { 'fill-color': COLORS.earth },
    },
    {
      id: 'elevation-tint',
      type: 'color-relief',
      source: 'reliefSource',
      paint: {
        'color-relief-color': ['interpolate', ['linear'], ['elevation'], ...ELEVATION_TINT],
        'color-relief-opacity': 0.8,
      },
    },
    {
      id: 'landcover',
      type: 'fill',
      source: 'pmtiles-source',
      'source-layer': 'landcover',
      paint: {
        'fill-color': ['match', ['get', 'kind'], ...LANDCOVER, COLORS.earth],
        // Ice stays white; the rest tints the elevation colour beneath it.
        'fill-opacity': ['match', ['get', 'kind'], 'glacier', 0.9, 0.5],
      },
    },
    {
      id: 'hillshade',
      type: 'hillshade',
      source: 'reliefSource',
      paint: {
        'hillshade-shadow-color': '#473B24',
        'hillshade-illumination-anchor': 'map',
        // Shading is all the relief a top-down globe shows; default is 0.5.
        'hillshade-exaggeration': 0.8,
      },
    },
    {
      id: 'water',
      type: 'fill',
      source: 'pmtiles-source',
      'source-layer': 'water',
      paint: { 'fill-color': COLORS.water },
    },
  ];
}

function boundaryLayers() {
  const boundary = (id, filter, paint) => ({
    id, type: 'line', source: 'pmtiles-source', 'source-layer': 'boundaries', filter, paint,
  });
  const width = (low, high) => ['interpolate', ['linear'], ['zoom'], 1, low, 6, high];
  const country = ['<=', ['get', 'kind_detail'], 2];
  const disputed = ['==', ['get', 'disputed'], true];
  return [
    {
      ...boundary('region-borders', ['==', ['get', 'kind_detail'], 4], {
        'line-color': COLORS.regionBorder,
        'line-width': 0.6,
        'line-dasharray': [3, 2],
      }),
      minzoom: 3,
    },
    boundary('country-borders', ['all', country, ['!', disputed]], {
      'line-color': COLORS.border,
      'line-width': width(0.5, 1.4),
    }),
    boundary('disputed-borders', ['all', country, disputed], {
      'line-color': COLORS.border,
      'line-width': width(0.5, 1.4),
      'line-dasharray': [2, 2],
    }),
  ];
}

function labelLayers() {
  const halo = { 'text-halo-color': COLORS.halo, 'text-halo-width': 1.2 };
  // Larger populations get larger labels; population_rank runs 0–15.
  const bySize = (small, large) => ['interpolate', ['linear'], ['get', 'population_rank'], 6, small, 15, large];
  return [
    {
      id: 'ocean-labels',
      type: 'symbol',
      source: 'pmtiles-source',
      'source-layer': 'water',
      filter: ['all', ['==', ['geometry-type'], 'Point'], ['in', ['get', 'kind'], ['literal', ['ocean', 'sea']]]],
      layout: {
        'text-field': NAME,
        'text-font': FONT,
        'text-size': ['interpolate', ['linear'], ['zoom'], 1, 11, 6, 15],
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.25,
        'text-max-width': 8,
      },
      paint: { 'text-color': COLORS.oceanLabel },
    },
    {
      id: 'country-labels',
      type: 'symbol',
      source: 'pmtiles-source',
      'source-layer': 'places',
      filter: ['==', ['get', 'kind'], 'country'],
      layout: {
        'symbol-sort-key': ['get', 'min_zoom'],
        'text-field': NAME,
        'text-font': FONT,
        'text-size': ['interpolate', ['linear'], ['zoom'], 2, bySize(9, 12), 6, bySize(12, 18)],
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.1,
        'text-max-width': 7,
      },
      paint: { 'text-color': COLORS.countryLabel, ...halo },
    },
    {
      id: 'city-labels',
      type: 'symbol',
      source: 'pmtiles-source',
      'source-layer': 'places',
      filter: ['==', ['get', 'kind'], 'locality'],
      layout: {
        'symbol-sort-key': ['get', 'min_zoom'],
        'text-field': NAME,
        'text-font': FONT,
        'text-size': ['interpolate', ['linear'], ['zoom'], 2, bySize(9, 12), 6, bySize(11, 16)],
        'text-max-width': 8,
      },
      paint: { 'text-color': COLORS.placeLabel, ...halo },
    },
  ];
}
