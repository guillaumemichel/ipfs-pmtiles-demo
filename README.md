# IPFS PMTiles Demo

Author: [Guillaume Michel](https://github.com/guillaumemichel)

This demo showcases how to distribute and serve static maps over IPFS using
PMTiles format, providing a decentralized approach to map hosting.

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
  interactive vector maps in the browser.

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
2. **Two Verified Packages**: The build emits two independent, individually
   verifiable packages — a **map package** (the archive + range proofs) and a
   **font package** (glyph files + one digest per file). Fonts are
   map-independent: one font package serves any number of maps, and any map
   can be paired with any font package.
3. **IPFS Pinning**: Each package is one root CID; pinning either makes it
   accessible to any IPFS node.
4. **Fetching Tiles**: Map tiles and fonts are fetched in the browser on demand
   using HTTP range requests — by default from the same static host that
   serves the page, or from any other host (an S3 bucket, a range-capable
   IPFS gateway like [`dweb.link`](https://dweb.link)) via the `?source=` and
   `?fonts=` flags.
5. **Client-Side Rendering**: MapLibre GL renders the map using the PMTiles
   protocol, verifying every byte against the two root CIDs.

### Data

[`data/`](/data) contains all the data used in this demo.

#### PMTiles

[ProtoMaps](https://protomaps.com) distributes a [world map in PMTiles
format](https://maps.protomaps.com/builds/), from which [specific zoom levels
can be extracted](https://docs.protomaps.com/pmtiles/cli#extract).

In order to keep the demo lightweight, we only extracted zoom levels `0` to `6`
into [`map.pmtiles`](/data/map.pmtiles) (`44MiB`).

[map.pmtiles](/data/map.pmtiles) was extracted using [`pmtiles
cli`](https://docs.protomaps.com/pmtiles/cli):

```sh
pmtiles extract https://build.protomaps.com/20250902.pmtiles map.pmtiles --maxzoom=6
```

#### Fonts

The [`Noto Sans Regular`](/data/fonts/) font directory was copied from
ProtoMaps
[`basemaps-assets`](https://github.com/protomaps/basemaps-assets/tree/main/fonts).

### IPFS Pinning

The map and font packages need to be pinned to IPFS, so that they can later
be discovered and fetched by the browser. Each package is identified by the
root CID that the client is configured with.

> [!NOTE]
> Remember that you cannot _upload_ content to IPFS, the data must be
> **pinned** on a live node, and advertised with the network.

Content can be pinned using [Kubo](https://github.com/ipfs/kubo),
[Helia](https://helia.io/) or [third-party pinning
services](https://docs.ipfs.tech/how-to/work-with-pinning-services/#use-a-third-party-pinning-service).

The build writes one CAR per package; example using Kubo:

```sh
$ ipfs dag import build/map.car     # pins the map package root
$ ipfs dag import build/fonts.car   # pins the font package root
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
   - Font glyphs resolved through the font package's own root CID via a
     `verified://` MapLibre protocol.
   - Most basic styling layers for land, water, and place labels

4. **Renders Interactive Map**:
   - Centered at [0, 0] with zoom level 2
   - Supports standard map interactions (pan, zoom, etc.), loading tiles on
     demand from IPFS

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
entire map and fonts.

## How Verification Works

Every byte the browser renders is verifiable against one of two root CIDs —
one for the map package, one for the font package — and **everything needed
to verify ships inside each published directory itself**: `ipfs get
<rootCID>` produces a package that any static file host can serve and any
client can verify:

```sh
📁 map package / (root CID — the only thing the map client must trust)
├─ 🗺️ map.pmtiles     (tile-aligned UnixFS DAG, bytes unchanged)
├─ 📄 metadata.json   (bootstrap manifest: sibling CIDs, sizes, proof digest)
└─ 📁 proofs/         (hashes of every tile-aligned byte range of the map)
   ├─ 📄 meta               (index: ranges + digests of the shards below)
   └─ 📄 {hex start offset} (shard: ~1,800 range hashes, ≤ 64 KiB each)

📁 font package / (its own root CID — reusable with any map)
├─ 📄 metadata.json   (bootstrap manifest: sibling CIDs)
├─ 📄 proofs          (one hash per font file, binary records)
└─ 📁 fonts/
   └─ 📁 {fontstack}/
      └─ 📄 {range}.pbf
```

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

Both packages bootstrap this way; they differ only in what hangs below:

3. Map: fetch `proofs/meta` (digest pinned by the manifest), then, lazily,
   the shard covering each requested byte range (digest pinned by `meta`);
   range-fetch tile bytes and verify each range against its shard digest.
4. Fonts: fetch `proofs` whole (digest pinned by the manifest's child CID),
   then fetch each glyph file whole and verify it against its record. No
   range requests anywhere.

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
The [`src/`](src/) modules implement a custom pmtiles.js `Source` and a
MapLibre glyph protocol, hash with WebCrypto, and reject on mismatch. The
binary formats and client protocol are specified in [SPEC.md](SPEC.md).

### Build

```sh
npm ci
node scripts/build.mjs          # --pin additionally imports + byte-verifies via Kubo
```

The build parses the archive, asserts it is clustered and deduplicated,
re-imports it with tile-aligned cut points, and then:

- packs the map's leaf digests into `proofs/` shards (≤ 64 KiB each) plus
  their `meta` index, and all font digests into the font package's `proofs`;
- generates each package's `metadata.json` last, from the sibling CIDs it
  must attest;
- writes `build/map.car` and `build/fonts.car` (all blocks — the
  IPFS-publication artifacts, one root CID each);
- assembles **`dist/`** — a complete, self-contained static site: the page
  (`index.html`), the client (`src/`), and the two data packages, each under
  `dist/ipfs/<rootCID>/`, byte-identical to what `ipfs get <rootCID>`
  yields;
- re-reads the bootstrap, sample tiles and a glyph back through the real
  client resolvers over an in-process dumb host, asserting byte-identity;
- asserts the two root CIDs inlined in `index.html` match the freshly built
  packages — the demo carries its trust anchors inline (no `config.json`),
  and this guard fails the build if they ever drift.

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
- `?fonts=<host>` — same, for the **font** package.
- `?tamper=1` — corrupt a deterministic ~1/6 of tile range responses (sparing
  the bootstrap and every plain GET: `metadata.json`, proofs, fonts) to
  watch verification reject them live (missing tiles + red badge counter).
