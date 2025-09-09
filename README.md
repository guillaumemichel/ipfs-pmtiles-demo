# IPFS PMTiles Demo

Author: [Guillaume Michel](https://github.com/guillaumemichel)

This demo showcases how to distribute and serve static maps over IPFS using
PMTiles format, providing a decentralized approach to map hosting.

**🌐 [View Live Demo](https://bafkreiclsdmwsgzkitv5g2akcdxugrotppn3mcg6lzukcjyj5cj5aferfy.ipfs.dweb.link/)**

## Overview

This project demonstrates:

- [**PMTiles**](https://protomaps.com/): A cloud-optimized format for storing
map tiles in a single static file.
- **IPFS Distribution**: Map data served via any [IPFS HTTP
Gateway](https://docs.ipfs.tech/concepts/ipfs-gateway/) (public, private or
local [kubo](https://github.com/ipfs/kubo)).
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
2. **Font Assets**: Map fonts are stored in a `fonts/` directory for text
   rendering.
3. **IPFS Pinning**: Both the PMTiles file and fonts directory are pinned to
   IPFS making them accessible to any IPFS node.
4. **Fetching Tiles**: Map tiles and fonts are fetched in the browser on demand
   using HTTP range requests from [`dweb.link`](https://dweb.link) or even
   better, from the local IPFS node if [IPFS
   Companion](https://docs.ipfs.tech/install/ipfs-companion/) is running in the
   browser.
5. **Client-Side Rendering**: MapLibre GL renders the map using the PMTiles
   protocol.

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

[`map.pmtiles`](/data/map.pmtiles) and the [`fonts/`](/data/fonts) directory
need to be pinned to IPFS, so that they can later be discovered and fetched by
the browser. The pinning operation returns the CID that will be used later in
the client to fetch the map.

> [!NOTE]
> Remember that you cannot _upload_ content to IPFS, the data must be
> **pinned** on a live node, and advertised with the network.

Content can be pinned using [Kubo](https://github.com/ipfs/kubo),
[Helia](https://helia.io/) or [third-party pinning
services](https://docs.ipfs.tech/how-to/work-with-pinning-services/#use-a-third-party-pinning-service).

Example using Kubo:

```sh
$ ipfs add --cid-version=1 data/map.pmtiles
added bafybeihcqkfxhjnpjqq4b4yjrombqoj2vjcabxeg2miindnzid5zjn7ceu map.pmtiles
$ ipfs add --cid-version=1 -r data/fonts
added bafybeigknf3p3vc5eq2q4odydrxhaxv7rtm74y53z3tobajkzdrx4gt4ia fonts
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

   - Vector source pointing to PMTiles file CID via the [Subdomain
   Gateway](https://docs.ipfs.tech/concepts/ipfs-gateway/#subdomain)
   [`dweb.link`](https://dweb.link).
   - Font glyphs directory root CID also via [`dweb.link`](https://dweb.link).
   - Most basic styling layers for land, water, and place labels

4. **Renders Interactive Map**:

   - Centered at [0, 0] with zoom level 2
   - Supports standard map interactions (pan, zoom, etc.), loading tiles on
   demand from IPFS

### Offline Maps

If [`IPFS Companion`](https://docs.ipfs.tech/install/ipfs-companion/) is used,
the browser fetches content from the local Kubo Gateway, not from a public HTTP
Gateway (like the configured [`dweb.link`](https://dweb.link)).

This means that the browser won't send any connections to the public internet.
The Kubo daemon will open connections to fetch the content directly from its
provider.

After the content is cached locally the map can be loaded offline from the
browser using IPFS Companion. Note that in the current state, Kubo fetches the
entire map and fonts.

## Future Work

Verifying the map tiles integrity isn't straightforward because of the HTTP
range requests.

It is possible to sidecar the CIDs or hashes corresponding to each map tile in
a tree used to verify the integrity of the tiles.

The fonts directory can simply use [`unixfs`](https://specs.ipfs.tech/unixfs/)
to allow verifiability.

The directory containing all the maps content could look as follow:

```sh
📁 /
├─ 🗺️ map.pmtiles
├─ 📄 metadata.json
├─ 📁 fonts/
│  └─ 📁 {fontstack}/
│     └─ 📄 {range}.pbf
└─ 📁 proofs/
   └─ 📄 {hashes}
```

The root directory CID would cryptographically bind together the map data,
fonts, and their corresponding integrity proofs.

The `proofs/` directory would contain hashes or CIDs for each tile, organized
to enable efficient partial verification. Hashes would be grouped into batch
files that can be cached and preloaded. This allows verifying subsets of tiles
without downloading proof data for the entire map, while maintaining reasonable
request overhead.

If pure hash digests are used for proofs (instead of CIDs), the hash function
has to be specified in `metadata.json`.

### Browser-Side Verification

Implementation approach:

1. Intercept tile requests in the browser before they reach MapLibre GL.
2. Fetch corresponding proofs from batched proof files for the requested tiles.
3. Verify tile integrity by comparing content hashes against expected values.
4. Release verified tiles to the map renderer only after validation.

This could be implemented by extending
[`pmtiles.js`](https://github.com/protomaps/PMTiles/tree/main/js) with a
verification layer. The enhanced library would accept a root CID and
automatically manage tile, font, and proof fetching during map navigation,
optimizing for minimal proof requests while avoiding unnecessary proof
downloads.
