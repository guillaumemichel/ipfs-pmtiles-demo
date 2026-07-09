# Verified Map & Font Packages — Format & Client Protocol

**formatVersion: 2** · Status: implemented; all numbers measured on the demo
archive (PMTiles, 44,199,060 B, 2,905 leaves) and font set (256 glyph files).

A _package_ is a directory of plain files published on any static host and
identified by a single IPFS root CID. A client that knows only that CID can
fetch the package's content and verify every byte it renders, with no trust
in the host. This document defines two package kinds sharing one trust
mechanism:

- a **map package** — a range-readable map archive plus the integrity
  proofs for arbitrary byte ranges of it;
- a **font package** — glyph files plus one digest per file, fetched whole.

Fonts ship separately from maps because a font set is map-independent: one
font package serves any number of maps, and any map can be paired with any
font package. The two kinds differ only in the manifest section they carry
and the shape of their proofs; bootstrap, verification, transport, and
caching are the same code.

## 1. Design goal: optimize for the client, not the server

The server is deliberately as dumb as possible: it stores files and answers
`GET`, optionally with one `Range` header. It never assembles proofs, never
computes, never runs IPFS software; publishing is `cp`, mirroring is `rsync`.
Every design decision below spends _server-side generality_ (a few percent
more proof bytes, one discarded request per session) to buy down the three
client budgets:

- **Client CPU.** Verification costs one SHA-256 over exactly the bytes
  fetched, plus an O(log n) binary search — and nothing else. Map proof
  files are fixed-size records, so the fetched buffer **is** the lookup structure:
  no parsing step, no decoded copies, no per-record allocation. Hex/string
  work happens only for the 1–2 records a read actually uses. Measured: a
  warm verified tile read costs ~13 µs of CPU; validating a full 64 KiB
  shard costs ~8 µs against its mandatory ~55 µs hash.
- **Latency.** A warm tile read is one exact-range request. A tile in a
  not-yet-proven region is _still one round trip_: the data range is fetched
  speculatively in parallel with the proof descent (§8.3). The absolute cold
  start (nothing cached, first paint) is bounded by the manifest + one
  meta + one shard + one range.
- **Bandwidth.** Tile requests carry zero overhead — exactly the tile's
  stored bytes, same shape as an unverified client. The entire proof
  apparatus is 36 B per leaf, 0.24 % of this archive, split into ≤ 64 KiB
  files fetched only for regions actually browsed, each immutable and
  cacheable forever.
- **Client memory.** One copy of everything: verified buffers live in a
  single digest-keyed LRU and are queried in place. There is no derived
  index to build, size, or evict for map data; the font client's one decoded
  structure is its ~17 KB path → digest table (§9).

## 2. Package layouts

```
map package /ipfs/<rootCID>/
├─ map.pmtiles        the archive; a valid PMTiles file, byte-identical on the host
├─ metadata.json      bootstrap manifest (§6) — the only unverified fetch
└─ proofs/
   ├─ meta            index records for this directory (§5.2)
   ├─ {hex16}         shard files (§5.1), named by absolute start offset
   └─ {hex16}/        subdirectories (same rule, recursive) at larger scales

font package /ipfs/<rootCID>/
├─ metadata.json      bootstrap manifest (§6) — the only unverified fetch
├─ proofs             one digest per font file (§5.3)
└─ fonts/{stack}/{range}.pbf
```

`{hex16}` is the 16-digit zero-padded lowercase hex of the **absolute byte
offset** where the file's (or directory's) coverage begins. Names are never
parsed for trust — they are derived by the client from verified prefix sums
and used only to build URLs. `{base}/{path}` must serve the same bytes as
`/ipfs/<rootCID>/{path}`; a range-capable IPFS gateway path is therefore a
conforming base URL. Publishers MAY name a static base by the same
convention — `…/ipfs/<rootCID>/` (the demo site does) — for legibility and
IPFS-tool interop; the name carries no trust. Clients take root CIDs only
from configuration and MUST NOT parse them out of URLs: a path is an
unenforced claim, and a source URL may be attacker-supplied (§3 still holds
because a wrong source merely fails verification).

## 3. Trust model

Each package's root CID is the only trust input for that package.
`metadata.json` is authenticated by reconstructing the root directory node
from it (§7); every other value is then authenticated strictly downward:

- map: manifest → meta digest → shard digest → leaf digest → tile bytes;
- fonts: manifest → proofs digest → font-file digest → glyph bytes.

The host and network are untrusted: they can withhold bytes (denial of
service, visible) but cannot alter any byte undetected (verification fails
closed; the client retries the next source or surfaces an error). All
digests are raw 32-byte SHA-256; the algorithm is declared once in the
manifest.

## 4. Single-leaf rule

Every published file except the map archive MUST be imported as a single
raw UnixFS leaf of ≤ 256 KiB (262,144 B, the default chunker's split point).
A single-raw-leaf file's CID multihash **is** the SHA-256 of its served
bytes, so a digest committed one level up (a `children[].cid`, a meta entry,
a proofs record) doubles as the content hash of a whole-file fetch. Clients
cap these digest-pinned whole-file reads at 256 KiB accordingly;
`metadata.json`, authenticated by root reconstruction instead (§7), carries
its own 1 MiB cap (§11). Publishers with font sets
whose proofs file would exceed the cap must shard it (deferred; see §11).

## 5. Binary formats

Every proof file is a bare sequence of records with no header, no padding,
and no trailer; a file that does not parse to exactly EOF is rejected.
Every integer is fixed-width little-endian — there is no varint anywhere in
the format.

### 5.1 Shard files — `proofs/…/{hex16}` (map packages)

```
shard := ( u32le(relativeOffset) digest32 )+        exactly 36 B per record
```

A shard proves one contiguous byte range (its _span_) of the map file. Its
absolute start is its filename; each record's offset is **relative to that
start**. A record covers the bytes from its offset up to the next record's
offset; the last record covers up to the span committed by the parent meta
entry. Validity rules (all MUST, checked once per fetched file):

1. file size is a non-zero multiple of 36 and at most **64 KiB**
   (⇒ ≤ 1,820 records);
2. the first offset is 0 (a shard starts proving at its own name);
3. offsets ascend strictly (⇒ every leaf is ≥ 1 byte);
4. the last offset is less than the parent-committed span.

These rules make gaps, overlaps, and zero-length leaves _unrepresentable_:
verified shards always partition their span exactly.

Rationale (client-first): fixed-width records let the client binary-search
the verified buffer directly — no decode pass, no in-memory index, no
second copy. Offsets are relative so 4 bytes suffice at any archive scale:
a shard's span is bounded by records × max leaf size (1,820 × 1 MiB
≈ 1.8 GB < 2³²), independent of file size. A variable-width encoding would
save a few percent of proof bytes at the cost of that in-place bisect — not
worth it: the entire client-side proof machinery is a fixed-stride index
lookup.

### 5.2 Meta files — `proofs/…/meta` (map packages)

```
meta := ( kind:u8 u64le(rangeLength ≥ 1) digest32 )+        exactly 41 B per record
```

`kind` 0 = shard file, 1 = subdirectory; anything else rejects. Entries are
range-contiguous in file order: entry _i_ starts where entry _i−1_ ended
(the directory's own start for the first — the top directory starts at 0),
so absolute positions are prefix sums and the child's filename is derived,
not stored. The entry lengths MUST sum exactly to the directory's committed
range. A directory holds at most 256 entries by build policy (an honest meta
is then ≤ 10,496 B); publishers with more shards nest subdirectories (each
with their own `meta`) — the descent rule is byte arithmetic only, so tree
shape is publisher policy, invisible to clients, which bound a meta only by
the whole-file read cap (§4), not the entry count. Lengths are u64 because an
entry's
range is bounded only by that publisher-chosen shape (u32 would silently
cap an entry at 4 GiB); clients MUST reject values ≥ 2⁵³, past JS integer
precision and far beyond any archive.

### 5.3 `proofs` (font packages)

```
proofs := ( u16le(pathLength ≥ 1) path:utf8 digest32 )+
```

One record per font file, path relative to the fonts directory, strictly
ascending (UTF-16 code-unit order); rejects duplicates, disorder, or invalid
UTF-8. Glyph files are fetched whole and hashed against their record.
Measured: 256 files → 17,064 B, fetched once per session.

## 6. `metadata.json` (formatVersion 2)

Common fields, both kinds:

```json
{
  "formatVersion": 2,
  "hash": "sha2-256",
  "children": [{ "name": "…", "cid": "…", "tsize": 0 }]
}
```

Clients MUST reject any other `formatVersion`. `children` lists `{name,
cid, tsize}` for every root entry **except `metadata.json` itself** (a file
cannot contain its own hash). Every referenced name (a `children[].name`,
`map.file`, `proofs.dir`, `fonts.dir`, `fonts.proofs`) MUST be a single
non-empty path segment of ≤ 255 UTF-16 code units — no `/`, and not `.` or
`..` — so a
tampered manifest can never steer a fetch outside the package base; names
must be unique. Provenance fields (`source`, `attribution`, `chunking`, …)
are informational and ignored by verification.

A **map package** adds:

```json
{
  "map": { "file": "map.pmtiles", "size": 44199060 },
  "proofs": { "dir": "proofs", "metaDigest": "<hex64>", "shardCapBytes": 65536 }
}
```

`metaDigest` is explicit because `proofs` is a directory: its child CID
commits to a dag-pb node the dumb host cannot serve, so the manifest pins
the top `meta` file's content digest directly. `shardCapBytes` is build
documentation — the client enforces the format's own 64 KiB cap instead.

A **font package** adds:

```json
{
  "fonts": { "dir": "fonts", "proofs": "proofs" }
}
```

No explicit digest: `proofs` is a root-level single-leaf file, so its
`children[].cid` multihash (which MUST be raw + sha2-256) is its content
digest (§4).

## 7. Bootstrap: reconstructing the root

1. GET `{base}/metadata.json` (the single unverified fetch); hash the bytes.
2. Build the dag-pb directory node from `children` plus the self link
   `{Name: "metadata.json", Hash: cidv1-raw(hash), Tsize: byteLength}`,
   links sorted by name (dag-pb's canonical UTF-8 byte order; a manifest
   whose names cannot be encoded in that order is rejected).
3. The node's CIDv1 (dag-pb, SHA-256) MUST equal the configured root CID;
   otherwise reject. Every manifest field is now authenticated.

The same three steps bootstrap both package kinds; a map client then
requires the `map` + `proofs` sections, a font client the `fonts` section.

## 8. Client read protocol — map packages

### 8.1 Verification chain (amortized, never re-walked)

Each fetched artifact is hashed once against the digest committed one level
up, then cached by digest; "walking back to the root" happens implicitly
and at most once per artifact per session:

| Artifact      | Checked against                              | Frequency          |
| ------------- | -------------------------------------------- | ------------------ |
| metadata.json | root CID (reconstruction)                    | once per session   |
| proofs/…/meta | parent meta / manifest digest + coverage sum | once per directory |
| shard file    | meta entry digest + §5.1 structure           | once per region    |
| tile bytes    | shard record digest                          | once per leaf      |

### 8.2 Warm reads

If every meta and shard covering `[a, b)` is already cached, the covering
leaves are resolved synchronously (bisect per shard), cached leaves are
copied, and the remainder is fetched as maximal file-contiguous runs — one
`Range` request per run, rounded out to leaf boundaries so every leaf can
be hashed whole. A single-tile read is one exact-range request; leaf slices
are verified against their record digests before use, all-before-any
caching per run.

### 8.3 Cold reads — speculative parallel fetch

When the proof descent would touch the network, the client MUST NOT
serialize data behind proofs. It instead:

1. immediately issues an **unverified** `Range: bytes=a..b-1` for exactly
   the requested range (the _speculation_), deduplicated against concurrent
   identical requests and body-capped at the requested length;
2. runs the proof descent in parallel;
3. when the covering leaves arrive, any run of uncached leaves lying
   **entirely inside `[a, b)`** is _adopted_: sliced out of the speculative
   body and digest-verified per leaf, all slices before any caching;
4. runs extending outside `[a, b)` (a read not aligned to leaf boundaries)
   are fetched normally per §8.2, and a speculation no run can use is
   aborted;
5. a speculative body that fails any digest is discarded and the run is
   re-fetched through the verified path — tampering costs one retry and a
   `rejected` statistic, never integrity, and never a cache entry.

Because the archive is chunked tile-aligned, tile reads are leaf-aligned by
construction: the speculation adopts, and a region's first tile costs **one
round trip** (proof fetches ride in parallel) instead of two. The known
misaligned case is the format's header probe (e.g. pmtiles' 16 KiB read),
which discards one small speculative body once per session.

### 8.4 Caching

One digest-keyed LRU per package holds every verified artifact — tile
leaves, shards, metas, glyphs. Proof buffers are queried in place (no
parsed forms), so eviction is uniform and re-validation after re-fetch is
one structural scan marked on the buffer. In-flight requests are
deduplicated; aborts release a shared fetch only when its last consumer
leaves.

## 9. Client read protocol — font packages

No range requests anywhere. The proofs file is fetched whole on first
glyph use (digest from `children`, §6), decoded into a path → digest table,
and cached; each glyph file is then one plain GET, hashed against its
record before use. A path absent from the table resolves to an empty glyph
response (the renderer tolerates missing ranges); a digest mismatch rejects.
A failed proofs fetch is not cached — the next glyph request retries.

### Measured request budgets

| Situation             | Requests                                                          | Bytes on the wire                            |
| --------------------- | ----------------------------------------------------------------- | -------------------------------------------- |
| Map bootstrap trust   | 1 (metadata.json)                                                 | ~1.2 KB                                      |
| Header probe, cold    | 1 meta + 1 shard + 1 discarded speculation + 1 run                | ~158 KB                                      |
| Tile, warm region     | **1 exact range**                                                 | tile bytes + 0                               |
| Tile, cold region     | **1 adopted range** (+1 shard in parallel, off the critical path) | tile + ≤ 65.5 KB amortized over ~1,800 tiles |
| Font bootstrap trust  | 1 (metadata.json)                                                 | ~0.7 KB                                      |
| First glyph           | 1 proofs + 1 glyph                                                | 17.1 KB + glyph bytes                        |
| Later glyphs          | **1 plain GET each**                                              | glyph bytes + 0                              |
| Full-map worst case   | —                                                                 | 44 MB + 105 KB proofs (0.24 %)               |

## 10. Host contract

| Requirement                                                         | Why                                                                                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET {base}/{path}` for published files                             | manifest, proofs, fonts                                                                                                                     |
| Single `Range: bytes=a-b` → `206` with exactly those stored bytes   | tile reads (map packages only); identity encoding — transparent compression of ranged responses corrupts slices (detected, fails closed)    |
| HTTPS or localhost                                                  | WebCrypto requires a secure context                                                                                                         |
| Immutable content per URL                                           | convention: root CID in the path; then `Cache-Control: immutable` is safe                                                                   |
| CORS `Access-Control-Allow-Origin: *` (cross-origin embedding only) | single-range `Range` is CORS-safelisted in Chromium; Firefox still preflights, so cross-origin hosts must answer `OPTIONS` allowing `Range` |

Nothing else: no `Content-Length` required, no multi-range, no HEAD, no
custom headers, no server-side proof logic. A font package host needs only
the first row. The client trusts only hashes.

## 11. Limits

| Limit                      | Value                                        | Enforced by                              |
| -------------------------- | -------------------------------------------- | ---------------------------------------- |
| Shard file size            | ≤ 64 KiB (1,820 records)                     | build + client (§5.1)                    |
| Shard record               | exactly 36 B                                 | format                                   |
| Relative offset            | < 2³² (guaranteed by ≤ 1 MiB leaves × 1,820) | build assert + u32 encoding              |
| Leaf (chunk) size          | ≥ 1 B, ≤ 1 MiB                               | build (chunker splits)                   |
| Meta record                | exactly 41 B; rangeLength ≥ 1, < 2⁵³         | format + client (§5.2)                   |
| Meta entries per directory | ≤ 256                                        | build; client caps meta reads at 256 KiB |
| Font path length           | 1 – 65,535 UTF-8 bytes                       | build assert + u16 encoding              |
| Non-map published files    | single raw leaf ≤ 256 KiB                    | build assert; client read cap (§4)       |
| metadata.json              | ≤ 1 MiB, ≤ 64 children                       | client                                   |

Sharding the font proofs file (same shard format, keyed by path instead of
offset) is deferred until a font set outgrows the single-leaf cap; at the
demo's measured record size (17,064 B / 256 files ≈ 67 B) one file holds
~3,900 records.

## 12. Versioning

`formatVersion` is a single integer shared by both package kinds; a client
MUST reject a manifest whose version it does not implement. This document
defines version 2: version 1 bundled fonts and their proofs inside the map
package and is obsolete. Changing any binary format, the manifest schema,
or the verification rules requires a new version and yields new root CIDs;
content updates alone also yield a new root CID (packages are immutable
snapshots — there is no in-place mutation to version).
