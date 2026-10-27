// The MapLibre style, built from the freshly derived CIDs so its trust
// references can never drift from the packages beside it. It ships as a
// verified *raw asset* (veritiles SPEC.md A2): the client fetches and hashes it
// against STYLE_CID, then hands the parsed JSON to MapLibre. Every trust
// reference inside points at a content-addressed identifier:
//   - the vector source at pmtiles://<mapAnchor> (veritiles VerifiedSource),
//   - terrain and hillshade at elevation://<elevationAnchor> (the app's
//     ocean-tile wrapper over the elevation VerifiedSource), their max zoom
//     from the archive's header,
//   - glyphs at verified://<fontsAnchor>/{fontstack}/{range}.pbf and icons at
//     verified://<spritesAnchor>/light (VerifiedAsset bundles).
//
// The layers are Protomaps' light basemap, the standard style for the schema
// of these tiles, with the elevation archive's relief under its water: the
// hillshade, and the 3D terrain.
import { layers, namedFlavor } from '@protomaps/basemaps';

// Only Noto Sans Regular is bundled, and its glyphs cover Latin, Greek and
// Cyrillic: every label uses it, and prefers English names.
const FONT = 'Noto Sans Regular';
const FLAVOR = { ...namedFlavor('light'), regular: FONT, bold: FONT, italic: FONT };

export function buildStyle({ mapAnchor, elevationAnchor, fontsAnchor, spritesAnchor }) {
  const demSource = {
    type: 'raster-dem',
    url: `elevation://${elevationAnchor}`,
    encoding: 'terrarium',
    tileSize: 512,
  };
  return {
    version: 8,
    projection: { type: 'globe' },
    sources: {
      'pmtiles-source': { type: 'vector', url: `pmtiles://${mapAnchor}` },
      // Terrain needs a source of its own: MapLibre manages terrain tiles
      // differently from layer tiles, and sharing one makes them fight over
      // loading. Hillshade has the other.
      terrainSource: { ...demSource },
      reliefSource: { ...demSource },
    },
    glyphs: `verified://${fontsAnchor}/{fontstack}/{range}.pbf`,
    sprite: `verified://${spritesAnchor}/light`,
    // The small set's DEM stops at z4 (~5 km/px), so relief is broad: 3.5
    // lifts it into view. The page lowers it once the full DEM takes over.
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
    layers: withHillshade(layers('pmtiles-source', FLAVOR, { lang: 'en' })),
  };
}

// The basemap's layers with the hillshade right under its water: it shades
// the land, and leaves the water, roads and labels above it flat.
function withHillshade(basemap) {
  const water = basemap.findIndex((layer) => layer.id === 'water');
  if (water < 0) throw new Error('the basemap has no water layer to put the hillshade under');
  const hillshade = {
    id: 'hillshade',
    type: 'hillshade',
    source: 'reliefSource',
    paint: {
      'hillshade-shadow-color': '#473B24',
      'hillshade-illumination-anchor': 'map',
      'hillshade-exaggeration': 0.6,
    },
  };
  return [...basemap.slice(0, water), hillshade, ...basemap.slice(water)];
}
