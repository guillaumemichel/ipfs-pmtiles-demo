# IPFS PMTiles Demo

Author: [Guillaume Michel](https://github.com/guillaumemichel)

This demo showcases how to distribute and serve static maps over IPFS using
PMTiles format, providing a decentralized approach to map hosting — rendered
as a globe with verified 3D terrain.

**🌐 [View Live Demo](https://guillaumemichel.github.io/ipfs-pmtiles-demo/)** —
built from this repo by CI and served by GitHub Pages, a "dumb host" that only
answers `GET` + `Range`. Try
[`?tamper=1`](https://guillaumemichel.github.io/ipfs-pmtiles-demo/?tamper=1)
to watch corrupted tile responses get rejected live.

## Overview

This project demonstrates:

- [**PMTiles**](https://protomaps.com/): A cloud-optimized format for storing
  map tiles in a single static file.
- **Verified distribution**: each package is identified by one IPFS root
  CID and can be served by any host with range-request support — a dumb
  HTTP endpoint (S3, GitHub Pages, `python -m http.server`) or any
  [IPFS HTTP Gateway](https://docs.ipfs.tech/concepts/ipfs-gateway/)
  (public, private or local [kubo](https://github.com/ipfs/kubo)) — while
  the browser verifies every byte against the root CID.
- [**MapLibre GL**](https://maplibre.org/maplibre-gl-js/docs/): Rendering
  interactive vector maps in the browser, with globe projection and 3D
  terrain built from a verified [Mapterhorn](https://mapterhorn.com)
  elevation package.

## Benefits of IPFS for Serving Map Tiles

- **Decentralized**: No single point of failure, maps are available as long as
  one IPFS node has the data.
- **Efficient**: PMTiles format allows range requests, fetching only needed tiles.
- **Cacheable**: IPFS content addressing enables aggressive caching.
- **Load sharing**: Bandwidth costs are shared across multiple IPFS nodes
  serving the same content.
- **Minimal infrastructure**: No need to manage CDNs, load balancers, or
  geographic server deployments.
- **Offline First**: PMTiles files can be cached locally for offline use.

## How It Works

### Architecture

1. **PMTiles File**: The entire map dataset is stored in a single `.pmtiles`
   file, which contains vector tiles optimized for web delivery using [HTTP
   range requests](https://en.wikipedia.org/wiki/Byte_serving).
2. **Two verified packages + two verified assets**: The build emits two
   range-verified packages — a **map package** (the vector archive + range
   proofs) and an **elevation package** (a raster-dem PMTiles archive + range
   proofs, the same package kind) — and two **verified assets** read by the
   veritiles library: the **font glyphs** (a UnixFS directory anchored by a
   CARv1 proof) and the **style** (a raw ≤ 256 KiB file that self-verifies).
   Fonts are map-independent: one font asset serves any number of maps.
3. **IPFS Pinning**: Each package/asset is content-addressed; pinning its root
   CID makes it accessible to any IPFS node.
4. **Fetching Tiles**: Map tiles and elevation tiles are fetched with HTTP
   range requests; the style and glyphs with plain whole-file GETs — by default
   from the same static host that serves the page, or from any other host (an
   S3 bucket, a range-capable IPFS gateway like [`dweb.link`](https://dweb.link))
   via the `?source=`, `?elevation=`, `?fonts=` and `?style=` flags.
5. **Client-Side Rendering**: MapLibre GL renders the map as a globe with 3D
   terrain and hillshading using the PMTiles protocol, verifying every byte
   against the inlined trust anchors via the veritiles library.

### Data

[`data/`](/data) contains all the data used in this demo.

#### PMTiles

[ProtoMaps](https://protomaps.com) distributes a [world map in PMTiles
format](https://maps.protomaps.com/builds/), from which [specific zoom levels
can be extracted](https://docs.protomaps.com/pmtiles/cli#extract).

In order to keep the demo lightweight, we only extracted zoom levels `0` to `6`
into [`map.pmtiles`](/data/map.pmtiles) (`42MiB`).

[map.pmtiles](/data/map.pmtiles) was extracted using [`pmtiles
cli`](https://docs.protomaps.com/pmtiles/cli):

```sh
pmtiles extract https://build.protomaps.com/20250902.pmtiles map.pmtiles --maxzoom=6
```

#### Elevation

[Mapterhorn](https://mapterhorn.com) distributes global elevation data as
PMTiles archives of 512 px terrarium-encoded WebP raster-dem tiles, from
which [`elevation.pmtiles`](/data/elevation.pmtiles) (`59MiB`) was extracted:

```sh
pmtiles extract planet.pmtiles elevation.pmtiles --maxzoom=4
```

Zoom levels `0` to `4` keep the demo lightweight (`z0-6` would be `822MiB`);
MapLibre oversamples the `z4` tiles at deeper zooms, so terrain and
hillshading stay on all the way in — just softer.

#### Fonts

The [`Noto Sans Regular`](/data/fonts/) font directory was copied from
ProtoMaps
[`basemaps-assets`](https://github.com/protomaps/basemaps-assets/tree/main/fonts).

### IPFS Pinning

The map, elevation and font packages need to be pinned to IPFS, so that they
can later be discovered and fetched by the browser. Each package is
identified by the root CID that the client is configured with.

> [!NOTE]
> Remember that you cannot _upload_ content to IPFS, the data must be
> **pinned** on a live node, and advertised with the network.

Content can be pinned using [Kubo](https://github.com/ipfs/kubo),
[Helia](https://helia.io/) or [third-party pinning
services](https://docs.ipfs.tech/how-to/work-with-pinning-services/#use-a-third-party-pinning-service).

The build writes one CAR per package; example using Kubo:

```sh
$ ipfs dag import build/map.car        # pins the map package root
$ ipfs dag import build/elevation.car  # pins the elevation package root
$ ipfs dag import build/fonts.car      # pins the font asset (all blocks, incl. glyphs)
```

### MapLibre Fetching and Rendering

The demo uses a simple HTML page (`index.html`) that:

1. **Loads Dependencies**:
   - MapLibre GL for map rendering
   - PMTiles library for tile protocol support

2. **Configures PMTiles Protocol**:

   ```javascript
   let protocol = new pmtiles.Protocol();
   maplibregl.addProtocol("pmtiles", protocol.tile);
   ```

3. **Defines Map Style**:
   - Vector source `pmtiles://<map root CID>`, served by a verifying `Source`
     that range-fetches tile bytes from a dumb static host and checks every
     block hash (see [How Verification Works](#how-verification-works)).
   - Terrain and hillshade raster-dem sources served through an
     `elevation://` MapLibre protocol backed by the elevation package's own
     verifying `Source` (a tile absent from the archive — pure ocean —
     rejects, which MapLibre renders as sea level).
   - Font glyphs resolved through the font asset's CAR anchor via veritiles'
     `verified://` MapLibre protocol (`assetProtocol`); the MapLibre style is
     itself a verified raw asset, fetched and hashed before the map is created.
   - Globe projection with a sky/atmosphere fading out at higher zooms
   - Most basic styling layers for hillshading, land, water, and place labels

4. **Renders Interactive Globe**:
   - Centered at [0, 20] with zoom level 1.5 and 2× terrain exaggeration
   - Supports standard map interactions (pan, zoom, pitch, etc.), loading
     tiles on demand from IPFS

### Offline Maps

The demo publishes each package under an `ipfs/<rootCID>/` path — the
convention IPFS-aware tooling recognizes. With
[`IPFS Companion`](https://docs.ipfs.tech/install/ipfs-companion/), package
fetches (or an explicit gateway source, e.g. `?source=https://dweb.link`)
can be redirected to the local Kubo Gateway instead of the public internet.

This means that the browser won't send any connections to the public internet.
The Kubo daemon will open connections to fetch the content directly from its
provider.

After the content is cached locally the map can be loaded offline from the
browser using IPFS Companion. Note that in the current state, Kubo fetches the
entire map, elevation and fonts.

## How Verification Works

Every byte the browser renders is verifiable against an inlined trust anchor —
the map package root, the elevation package root, the font asset's CAR anchor,
and the raw style CID — and **everything needed to verify ships inside each
published directory itself**: `ipfs get <id>` produces content any static file
host can serve and any client can verify:

```sh
📁 map / elevation package / (root CID — the only thing the map client must trust)
├─ 🗺️ map.pmtiles     (tile-aligned UnixFS DAG, bytes unchanged)
├─ 📄 metadata.json   (bootstrap manifest: sibling CIDs, sizes, proof digest)
└─ 📁 proofs/         (hashes of every tile-aligned byte range of the map)
   ├─ 📄 meta               (index: ranges + digests of the shards below)
   └─ 📄 {hex start offset} (shard: ~1,800 range hashes, ≤ 64 KiB each)

📁 fonts asset  ipfs/<fontsRoot>/{fontstack}/{range}.pbf   (plain glyph tree)
📄 fonts proof  ipfs/<fontsRoot>.car    (CARv1 of the directory's UnixFS nodes;
                                         anchored by its CAR CID — the trust input)
📄 style asset  ipfs/<styleCID>         (raw ≤ 256 KiB file; self-verifying)
```

The font glyphs and style are verified by the veritiles library
(`VerifiedAsset`, format in veritiles `SPEC.md` (Part 2)): a glyph read walks the CAR proof
to its leaf then does one plain GET; the style is fetched whole and hashed
against `<styleCID>`.

The archive is imported with a **tile-aligned chunker**, so every tile is one
IPFS block — a contiguous byte range of `map.pmtiles` whose sha2-256 digest
the `proofs/` shards record in file order (4-byte offset + 32-byte digest,
nothing else). Tiles are stored zoom-major, so the first shard covers the low
zoom levels every visitor touches; deeper zooms live in later shards (and, at
larger scales, nested subdirectories) that are fetched only when browsed.

### Bootstrap: from one CID to a verified package

1. Fetch `{base}/metadata.json` — the client's only unverified request.
2. Hash it, rebuild the root directory node from the manifest's `children`
   (`{name, cid, tsize}` for every sibling) plus that self-computed link, and
   require the rebuilt node's CID to **equal the configured root CID**. One
   hash comparison now authenticates every value in the manifest.

Both map packages bootstrap this way (elevation follows the map flow):

3. Map: fetch `proofs/meta` (digest pinned by the manifest), then, lazily,
   the shard covering each requested byte range (digest pinned by `meta`);
   range-fetch tile bytes and verify each range against its shard digest.

Fonts bootstrap differently (veritiles `VerifiedAsset`): fetch the CAR proof
whole (hashed against the CAR anchor), then read each glyph by walking the
proof's UnixFS nodes to a leaf and doing one plain GET. The style needs no
proof at all — the raw CID is the hash of its bytes. No range requests for
either asset.

A host can withhold data but cannot alter it undetected: tampering degrades
to missing tiles, counted on the on-map badge — never to wrong map data. The
published layout mirrors the DAG, so `{base}/{path}` serves the same bytes as
`/ipfs/{rootCID}/{path}`: `{base}` can be a static bucket, GitHub Pages,
`python -m http.server`, or any range-capable IPFS gateway path — one client,
anything that answers `GET` + a single `Range` (fonts need only plain `GET`).
The demo picks `{base} = ipfs/<rootCID>/` next to the page, so its URLs read
exactly like gateway paths — a legibility and interop convention (IPFS-aware
tools recognize `/ipfs/` paths) that carries **no trust**: a URL path is an
unenforced claim, and the client takes root CIDs only from the config inlined
in `index.html`, never from URLs.
The browser client is the [veritiles](https://github.com/guillaumemichel/veritiles)
library (a local `file:` dependency here, vendored into `dist/vendor/`): its
`VerifiedSource` is a pmtiles.js `Source` for the range-verified map and
elevation packages, and its `VerifiedAsset` + `assetProtocol` verify the font
glyphs and the style as whole-file **assets**. The map-package binary format is
specified in [SPEC.md](SPEC.md); the verified-asset format (fonts, style) in
veritiles' [`SPEC.md`](https://github.com/guillaumemichel/veritiles/blob/main/SPEC.md).

### Build

```sh
npm ci
node scripts/build.mjs          # --pin additionally imports + byte-verifies via Kubo
```

The build parses the map and elevation archives, asserts each is clustered
and deduplicated, re-imports each with tile-aligned cut points, and then:

- packs each archive's leaf digests into `proofs/` shards (≤ 64 KiB each)
  plus their `meta` index;
- generates each map package's `metadata.json` last, from the sibling CIDs it
  must attest;
- imports the glyph directory as a verified asset and emits its structure-only
  CARv1 proof at `dist/ipfs/<fontsRoot>.car` (anchored by the CAR CID), and
  bakes the built CIDs into the MapLibre style, published as a raw asset at
  `dist/ipfs/<styleCID>`;
- writes `build/map.car`, `build/elevation.car` and `build/fonts.car` (all
  blocks — the IPFS-publication artifacts, one root CID each);
- assembles **`dist/`** — a complete, self-contained static site: the page
  (`index.html`), the vendored veritiles client (`vendor/veritiles.js`), the
  map and elevation packages, the font asset, and the style, each under
  `dist/ipfs/<id>/`, byte-identical to what `ipfs get <id>` yields;
- re-reads the bootstrap, sample tiles, the style and a glyph back through the
  real veritiles resolvers over an in-process dumb host, asserting byte-identity
  and that a flipped glyph byte rejects;
- asserts the five CIDs inlined in `index.html` (`map`, `elevation`,
  `fontsRoot`, `fontsAnchor`, `style`) match the freshly built artifacts — the
  demo carries its trust anchors inline (no `config.json`), and this guard
  fails the build if they ever drift.

The build is deterministic — same inputs and tool versions yield the same
root CIDs _and_ the same proof bytes — guarded by golden tests.

### Run the demo

```sh
npm run build     # assembles the self-contained site into dist/
npm run serve     # dumb host at http://127.0.0.1:8080 serving dist/
# open http://127.0.0.1:8080/index.html
```

`scripts/serve.mjs` is a static file server with single-`Range` 206 support and
nothing else — the "dumb host" this demo targets. `dist/` is the whole
deployable unit; copying it to any static host (a bucket, GitHub Pages,
`python -m http.server`) is the entire deploy.

### Publish to GitHub Pages

`.github/workflows/pages.yml` runs the tests, builds the site and deploys it
on every push to `main`. One-time setup: enable Pages under **Settings →
Pages → Source → GitHub Actions** (or `gh api repos/OWNER/REPO/pages -X POST
-f build_type=workflow`). Nothing built is committed (`dist/`, the proofs,
the CARs stay out of git). The only host
requirement is single-`Range` `206` responses, which Pages (via Fastly)
provides — verify after the first deploy with:

```sh
curl -sI -H 'Range: bytes=0-99' \
  https://guillaumemichel.github.io/ipfs-pmtiles-demo/ipfs/<map rootCID>/map.pmtiles
# expect: HTTP/2 206  +  content-range: bytes 0-99/44199060
```

(`<map rootCID>` is inlined in `index.html` and printed by the build as
`MAP_ROOT_CID`.)

### Test

```sh
npm test                       # unit tests (formats, proofs, bootstrap, resolver, DAG build)
npm run test:http              # end-to-end over the dumb host (needs dist/); zero IPFS
```

### Demo flags

- `?source=<host>` — try another host first for the **map** package (falls
  back to the configured one). The client appends `ipfs/<map rootCID>` from
  its trusted config, so the host only needs to publish the standard layout:
  any IPFS gateway (`?source=https://dweb.link`, or
  `?source=http://127.0.0.1:8081` for a local Kubo) or any mirror of
  `dist/`.
- `?elevation=<host>` — same, for the **elevation** package.
- `?fonts=<host>` — same, for the **font** package.
- `?tamper=1` — corrupt a deterministic ~1/6 of tile range responses (sparing
  the bootstrap and every plain GET: `metadata.json`, proofs, fonts) to
  watch verification reject them live (missing tiles + red badge counter).
