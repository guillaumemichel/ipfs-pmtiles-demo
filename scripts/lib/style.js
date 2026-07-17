// The MapLibre style, built from the freshly derived CIDs so its trust
// references can never drift from the packages beside it. It ships as a
// verified *raw asset* (veritiles SPEC.md A2): the client fetches and hashes it
// against STYLE_CID, then hands the parsed JSON to MapLibre. Every trust
// reference inside points at a content-addressed identifier:
//   - the vector source at pmtiles://<mapRoot> (veritiles VerifiedSource),
//   - glyphs at verified://<fontsAnchor>/{fontstack}/{range}.pbf (VerifiedAsset),
//   - terrain/hillshade at elevation://{z}/{x}/{y} (the app's ocean-tile wrapper
//     over the elevation VerifiedSource), maxzoom baked from the archive header.
export function buildStyle({ mapRoot, fontsAnchor, elevationMaxZoom }) {
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
      'pmtiles-source': { type: 'vector', url: `pmtiles://${mapRoot}` },
      // Terrain and hillshade need separate sources: MapLibre manages terrain
      // tiles differently from layer tiles, and sharing one makes them fight
      // over loading.
      terrainSource: { ...demSource },
      hillshadeSource: { ...demSource },
    },
    glyphs: `verified://${fontsAnchor}/{fontstack}/{range}.pbf`,
    terrain: { source: 'terrainSource', exaggeration: 2.0 },
    sky: {
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0],
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#f0f8ff' } },
      {
        id: 'hillshade',
        type: 'hillshade',
        source: 'hillshadeSource',
        paint: {
          'hillshade-shadow-color': '#473B24',
          'hillshade-illumination-anchor': 'map',
        },
      },
      {
        id: 'land',
        type: 'fill',
        source: 'pmtiles-source',
        'source-layer': 'land',
        paint: { 'fill-color': '#f8f4f0', 'fill-opacity': 0.7 },
      },
      {
        id: 'water',
        type: 'fill',
        source: 'pmtiles-source',
        'source-layer': 'water',
        paint: { 'fill-color': '#a0c8f0' },
      },
      {
        id: 'places',
        type: 'symbol',
        source: 'pmtiles-source',
        'source-layer': 'places',
        layout: {
          'text-field': ['get', 'name'],
          'text-size': 12,
          'text-font': ['Noto Sans Regular'],
        },
        paint: {
          'text-color': '#333333',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1,
        },
      },
    ],
  };
}
