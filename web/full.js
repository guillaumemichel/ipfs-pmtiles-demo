// The full-resolution archives take over from the small set as they open.

// Points every source that reads the archive `from` at the archive `to`.
// MapLibre reloads their tiles in place: the old ones stay on screen until
// the new ones arrive.
export function swapArchive(map, from, to) {
    for (const [id, { url }] of Object.entries(map.getStyle().sources)) {
        const [scheme, anchor] = url?.split('://') ?? [];
        if (anchor === from) map.getSource(id).setUrl(`${scheme}://${to}`);
    }
}
