/**
 * Number of columns a `.files-grid-view` (and the photos square grid share the
 * idea) renders at a given container width. Mirrors the CSS
 * `repeat(auto-fill, minmax(var(--grid-card-min), 1fr))` so a windowing list can
 * compute row counts that match the browser's actual wrapping exactly.
 *
 * Card-min / gap track the tokens in `lib/styles/base/variables.css` and the
 * ≤640px phone override in `lib/styles/ported/resourceList.css`.
 */
export function gridColumns(width: number): number {
	if (width <= 0) return 1;
	const mobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches;
	const cardMin = mobile ? 140 : 200;
	const gap = mobile ? 8 : 20;
	return Math.max(1, Math.floor((width + gap) / (cardMin + gap)));
}
