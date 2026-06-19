/** Folder endpoints — ported from filesModel.js + fileOperations.js. */
import { apiFetch, apiJson } from '$lib/api/client';
import { getCsrfHeaders } from '$lib/api/csrf';
import type { FileItem, FolderItem } from '$lib/api/types';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const NO_CACHE: RequestInit = {
	credentials: 'same-origin',
	cache: 'no-store',
	headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
};

export interface FolderListing {
	folders: FolderItem[];
	files: FileItem[];
	/** Ids in this listing the caller has favorited (server-computed badge set). */
	favoriteIds: string[];
	/** Ids in this listing the caller has an outgoing share/grant on. */
	sharedIds: string[];
}

/** Result of a (possibly conditional) listing fetch. */
export interface FolderListingResult {
	/** 200 with a fresh `listing`, or 304 → the caller should keep its cache. */
	status: number;
	listing?: FolderListing;
	etag?: string;
}

// ── In-memory listing cache (stale-while-revalidate) ─────────────────────────
// Lets the files view paint a previously-visited folder instantly on
// back/forward navigation, then revalidate with `If-None-Match` (304 = no body).
interface CachedFolder {
	listing: FolderListing;
	etag?: string;
}
const FOLDER_CACHE_MAX = 40;
const folderCache = new Map<string, CachedFolder>();

/** Cached listing for a folder, bumped to most-recently-used. */
export function getCachedFolder(folderId: string): CachedFolder | undefined {
	const hit = folderCache.get(folderId);
	if (hit) {
		folderCache.delete(folderId);
		folderCache.set(folderId, hit);
	}
	return hit;
}

export function cacheFolder(folderId: string, listing: FolderListing, etag?: string): void {
	folderCache.delete(folderId);
	folderCache.set(folderId, { listing, etag });
	// Evict the least-recently-used entries past the cap.
	while (folderCache.size > FOLDER_CACHE_MAX) {
		const oldest = folderCache.keys().next().value;
		if (oldest === undefined) break;
		folderCache.delete(oldest);
	}
}

/** Drop one folder, or the whole cache (no id), after a mutation. */
export function invalidateFolderCache(folderId?: string): void {
	if (folderId === undefined) folderCache.clear();
	else folderCache.delete(folderId);
}

function parseListing(raw: unknown): FolderListing {
	const o = (raw ?? {}) as {
		folders?: FolderItem[];
		files?: FileItem[];
		favorite_ids?: string[];
		shared_ids?: string[];
	};
	return {
		folders: Array.isArray(o.folders) ? o.folders : [],
		files: Array.isArray(o.files) ? o.files : [],
		favoriteIds: Array.isArray(o.favorite_ids) ? o.favorite_ids : [],
		sharedIds: Array.isArray(o.shared_ids) ? o.shared_ids : []
	};
}

/** Top-level folders for the user; the first entry is the home folder. */
export function listRootFolders(): Promise<FolderItem[]> {
	return apiJson<FolderItem[]>('/api/folders', { credentials: 'same-origin' });
}

export function getFolder(id: string): Promise<FolderItem> {
	return apiJson<FolderItem>(`/api/folders/${id}`, NO_CACHE);
}

/**
 * Fetch a folder listing, optionally conditionally. With `etag` set it sends
 * `If-None-Match`; the server replies 304 (empty body) when nothing changed —
 * the ETag covers folders + files + favorite/share badges — so the caller can
 * keep its cached copy. `cache: 'no-store'` keeps the browser HTTP cache out of
 * the way; revalidation is driven entirely by our own ETag.
 */
export async function fetchFolderListing(
	folderId: string,
	opts: { etag?: string; forceRefresh?: boolean } = {}
): Promise<FolderListingResult> {
	const headers: Record<string, string> = {};
	if (opts.etag) headers['If-None-Match'] = opts.etag;
	let url = `/api/folders/${folderId}/listing`;
	if (opts.forceRefresh) {
		url += '?force_refresh=true';
		headers['X-Force-Refresh'] = 'true';
	}
	const res = await apiFetch(url, { credentials: 'same-origin', cache: 'no-store', headers });
	if (res.status === 304) return { status: 304 };
	if (res.status === 403) throw Object.assign(new Error('Forbidden'), { status: 403 });
	if (!res.ok) throw new Error(`listing failed: ${res.status}`);
	return {
		status: 200,
		listing: parseListing(await res.json()),
		etag: res.headers.get('ETag') ?? undefined
	};
}

/** Non-conditional listing fetch (e.g. the move-dialog folder tree). */
export async function listFolder(folderId: string, forceRefresh = false): Promise<FolderListing> {
	const res = await fetchFolderListing(folderId, { forceRefresh });
	return res.listing ?? { folders: [], files: [], favoriteIds: [], sharedIds: [] };
}

export async function createFolder(name: string, parentId: string | null): Promise<FolderItem> {
	const res = await apiFetch('/api/folders', {
		method: 'POST',
		credentials: 'same-origin',
		headers: { ...JSON_HEADERS, ...getCsrfHeaders() },
		body: JSON.stringify({ name, parent_id: parentId })
	});
	if (!res.ok) throw new Error(`create folder failed: ${res.status}`);
	return (await res.json()) as FolderItem;
}

export async function renameFolder(folderId: string, name: string): Promise<void> {
	const res = await apiFetch(`/api/folders/${folderId}/rename`, {
		method: 'PUT',
		credentials: 'same-origin',
		headers: { ...JSON_HEADERS, ...getCsrfHeaders() },
		body: JSON.stringify({ name })
	});
	if (!res.ok) throw new Error(`rename folder failed: ${res.status}`);
}

export async function moveFolder(folderId: string, targetFolderId: string | null): Promise<void> {
	const res = await apiFetch(`/api/folders/${folderId}/move`, {
		method: 'PUT',
		credentials: 'same-origin',
		headers: { ...JSON_HEADERS, ...getCsrfHeaders() },
		body: JSON.stringify({ parent_id: targetFolderId || null })
	});
	if (!res.ok) throw new Error(`move folder failed: ${res.status}`);
}

export async function deleteFolder(folderId: string): Promise<void> {
	const res = await apiFetch(`/api/folders/${folderId}`, {
		method: 'DELETE',
		credentials: 'same-origin',
		headers: getCsrfHeaders()
	});
	if (!res.ok) throw new Error(`delete folder failed: ${res.status}`);
}

export function folderZipUrl(folderId: string): string {
	return `/api/folders/${folderId}/download?format=zip`;
}
