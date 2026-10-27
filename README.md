# Verified PMTiles Demo

[View the live demo](https://guillaumemichel.github.io/ipfs-pmtiles-demo/).

This MapLibre globe verifies every fetched map tile, terrain tile, style file,
font proof, and font glyph before rendering it. It uses
[veritiles v0.6.1](https://github.com/guillaumemichel/veritiles/releases/tag/v0.6.1)
with ordinary static hosting: GitHub Pages, an object store, or any HTTP server
that supports single `Range` requests. At full resolution the planet comes from
a self-hosted server that a content router finds
([Full Resolution](#full-resolution)).

## Published Layout

`dist/` is the entire deployment:

```text
map.pmtiles
map.pmtiles.proofs/       # v0.5 descriptor (`root`) and proof tree
elevation.pmtiles
elevation.pmtiles.proofs/
assets/style.json         # raw-CID verified style
assets/fonts.car          # 32 KB MASL bundle proof: the manifest, nothing else
assets/sprites.car        # 52 KB MASL bundle: the basemap's icons, inside their proof
assets/fonts/             # the glyphs themselves, verified per file
assets/hints.json         # glyph locations, found by discovery
hints.json                # anchor and archive locations
vendor/                   # veritiles, MapLibre GL (module + worker + css), pmtiles,
                          # and the FISL router (fisl-router/)
web/full.js               # a full archive takes its layer over
index.html
preview.jpg               # link-preview screenshot (og:image)
```

## Anchors In The Page, Locations In `hints.json`

The page inlines five trust anchors — map, elevation, font bundle, sprite
bundle, style — plus two for the full-resolution archives, and a single URL:
the content router's, which locates those two ([Full
Resolution](#full-resolution)). Every other location lives in routing-hints
documents ([veritiles
`SPEC.md`](https://github.com/guillaumemichel/veritiles/blob/main/SPEC.md) §5),
which are untrusted and outside the root of trust: every byte they point at is
verified against the anchor in the page, so a hostile document can misdirect a
request but never alter a result that verifies. Moving the site to another host
is an edit to one JSON file and never touches a CID.

Two documents, because they change on different cadences and are needed at
different times:

- **`hints.json`**, beside the page — the client's default document. Seven
  entries: each archive's anchor names its proof directory and its BLAKE3
  `map` CID names the archive, each bundle anchor names its proof, the style
  CID names the style.
- **`assets/hints.json`** — one entry per glyph, mapping each resource's raw
  CID to its published file. The page never names this document; the client
  discovers it by probing the directory that holds `fonts.car` when a glyph
  location is missing, so it costs nothing until the first label renders.

`?hints=<url>` consults a different document first and falls back to the
packaged one.

## Full Resolution

The page also names two full-resolution archives: the Protomaps planet (z0–15,
139 GB) and Mapterhorn's planet (z0–12, 356 GB), served from a self-hosted
server. GitHub Pages cannot hold them, and `hints.json` does not name them: the
page asks a content router, the [FISL](https://dasl.ing/fisl.html) index at
`index.content-router.com`, where they are, through
[`@anymirror/fisl-router`](https://www.npmjs.com/package/@anymirror/fisl-router).
The index is untrusted like the hints documents: every byte still verifies
against the anchor in the page.

The small set paints first, from GitHub Pages. The full archives open
meanwhile, and each takes its layer, map or terrain, over once it opens and
the small set is on screen: the layer's sources reload from the full archive
in place, the small tiles stay drawn until the full ones arrive, and the
small archive's reads still in flight stop. A full archive
that never opens, because the index or the server is down, leaves its layer on
the small set. The badge names what is shown; `?small` keeps the small set.
Until `index.html` names the full anchors, the page shows the small set.

Both sets share one verified style. It names every archive by anchor, the
terrain's included, and takes each archive's max zoom from the archive's
header. When the full terrain takes over, the page lowers its exaggeration
from 3.5 to 1.5: the small set's z4 relief needs the lift, the full one does
not. The page shows the credits for Protomaps, OpenStreetMap and Mapterhorn
itself, since an archive's metadata may carry none.

## The Style

The layers are Protomaps' light basemap
([`@protomaps/basemaps`](https://www.npmjs.com/package/@protomaps/basemaps)),
the standard style for the schema of these tiles: roads and their names,
places, points of interest, transit, buildings, land use. The terrain's
hillshade lies under its water, and the 3D terrain under everything. Labels
use the bundled Noto Sans Regular. Icons come from the light sprite sheet, a
52 KB bundle verified like the fonts, whose files travel inside the proof:
one `GET` brings them all. The style itself is published minified, since a
raw asset is read whole, 256 KiB at most.

## The Font Bundle

`assets/fonts.car` is a _proof_, not a payload: the MASL manifest block alone,
32,214 B covering 256 glyphs. The glyphs themselves stay ordinary files under
`assets/fonts/`, fetched one at a time and hashed against the manifest as a
label needs them.

A bundle CAR may also carry the content inline as optional raw blocks
(veritiles `SPEC.md` §3.2); for a 6.24 MB glyph directory that would mean
publishing every byte twice and downloading the whole bundle before the first
label could render. Keeping the bag to the manifest is what makes the glyph
reads lazy, and it is free: the bundle anchor is the sha2-256 of the manifest
block itself, so which raw sections travel beside it never changes the anchor.
veritiles' packer inlines a directory only when it totals at most 256 KiB, so it
emits this one as the manifest alone, and the build checks that every glyph is
read from its own file.

## Build And Verify

```sh
npm ci
npm test
npm run build
npm run test:http
```

`npm run build` assembles `dist/`, derives both hints documents from the
anchors and the packaged bytes, then reads the site back through them with no
location configured anywhere else: representative byte ranges from both PMTiles
files, the style, and all 256 glyphs. `npm run test:http` repeats that through
the static HTTP server and asserts that map data uses `206` ranges, that the
hints documents, proofs, and assets are whole-file `GET`s, that the glyph
document is reached by discovery rather than by configuration, that a
tampered glyph is rejected, and that the page loads no script from another
host: the build copies each library from `node_modules/` at the version
`package-lock.json` pins.

Run locally with:

```sh
npm run serve
# http://127.0.0.1:8080/ (the server's root is dist/)
```

## Repacking Data

The checked-in proof data was generated by veritiles v0.5.0's published pack
tool. Recreate it after replacing either archive:

```sh
git clone --depth 1 --branch v0.5.0 https://github.com/guillaumemichel/veritiles.git /tmp/veritiles
cd /tmp/veritiles
npm install
npm run pack -- /path/to/map.pmtiles --unixfs --full-car /path/to/build/map.car --out /path/to/data/map.pmtiles.proofs
npm run pack -- /path/to/elevation.pmtiles --unixfs --full-car /path/to/build/elevation.car --out /path/to/data/elevation.pmtiles.proofs
npm run pack -- assets /path/to/data/fonts --out /path/to/data/fonts.car
npm run pack -- assets /path/to/data/sprites --out /path/to/data/sprites.car
```

The sprite files are Protomaps' light sheet,
`https://protomaps.github.io/basemaps-assets/sprites/v4/light{,@2x}.{json,png}`.
Copy the four printed anchors into `index.html`, `scripts/build.mjs`, and
`test/build.test.js`, then run `npm test && npm run build`; the build rewrites
both hints documents around them, keying each archive by the BLAKE3 `map` CID
it recomputes from the published bytes. The font anchor survives a repack of
the same glyphs.

The full-resolution archives are packed on the server that serves them, with
veritiles' Rust packer (`packer/` in veritiles): `veritiles-pack planet.pmtiles`
writes `planet.pmtiles.proofs/` beside the archive and prints the anchor to set
under `full` in `index.html`.

`--unixfs` embeds the standard 256 KiB UnixFS root in each PMTiles descriptor;
the `--full-car` outputs are pinnable publication artifacts in `build/`. The
packer chooses each archive's tile group itself (16 KiB for both here) and
prints it after the `proofs:` line.

## Hosting Requirements

- Archive requests must return exact single-range `206` responses.
- Both `hints.json` files, the proofs, the style, `fonts.car`, and the glyph
  files need ordinary `GET` support.
- Cross-origin hosts need `Access-Control-Allow-Origin`; Firefox hosts must
  also answer `OPTIONS` permitting `Range`.
- Serve HTTPS or localhost for WebCrypto.

The GitHub Actions workflow rebuilds and deploys `dist/` to Pages on pushes to
`main`.
