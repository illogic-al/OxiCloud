use crate::common::config::AppConfig;
use crate::common::di::AppState;
use axum::Router;
use axum::http::header::{CACHE_CONTROL, HeaderValue};
use axum::routing::get_service;
use base64::Engine as _;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tower_http::compression::CompressionLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

/// Resolve the directory the SPA is actually served from.
///
/// Release builds prefer the Vite output next to the configured static path —
/// `static-dist/`, or `static/` under `PROFILE=dev` — falling back to the
/// configured path when that build dir is absent. Debug builds always use the
/// configured path. Shared with the CSP layer in `main.rs` so the inline-script
/// hashes are computed from exactly the bytes that get served.
pub fn resolve_static_path(config: &AppConfig) -> PathBuf {
    // `PROFILE=dev` (the `just front-dev`/legacy path) serves the unbuilt source
    // dir; normal release serves the Vite output in `static-dist/`.
    let is_dev = std::env::var("PROFILE").is_ok_and(|profile| profile == "dev");
    let assets_dir = if is_dev { "static" } else { "static-dist" };

    if cfg!(not(debug_assertions)) {
        let dist = config
            .static_path
            .parent()
            .unwrap_or(Path::new("."))
            .join(assets_dir);
        if dist.exists() {
            return dist;
        }
    }
    config.static_path.clone()
}

/// Serves the SvelteKit single-page app.
///
/// The frontend is built by Vite into `static-dist/` (repo root). Real files are
/// served from disk; any unmatched client route (deep links such as
/// `/files/<id>`, `/s/<token>`, `/login`) falls back to the SPA shell
/// `index.html`, which boots the client router.
///
/// Caching: content-hashed assets under `/_app/immutable` are cached forever;
/// everything else — crucially the `index.html` shell — is `no-cache` so a deploy
/// can't leave a stale app pinned in browsers.
pub fn create_web_routes() -> Router<Arc<AppState>> {
    let config = AppConfig::from_env();
    let is_dev = std::env::var("PROFILE").is_ok_and(|profile| profile == "dev");
    let static_path = resolve_static_path(&config);

    // SPA fallback: serve the file if it exists, else the app shell.
    let spa = ServeDir::new(&static_path).fallback(ServeFile::new(static_path.join("index.html")));

    // Hashed, immutable assets (SvelteKit emits these under /_app/immutable).
    let app_immutable = ServeDir::new(static_path.join("_app").join("immutable"));

    let shell_cache = if is_dev {
        "max-age=0, no-cache, no-store"
    } else {
        "no-cache"
    };

    Router::new()
        .nest_service(
            "/_app/immutable",
            get_service(app_immutable).layer(SetResponseHeaderLayer::overriding(
                CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=31536000, immutable"),
            )),
        )
        .fallback_service(spa)
        .layer(CompressionLayer::new().br(true).gzip(true))
        // `if_not_present` so the immutable assets above keep their long cache.
        .layer(SetResponseHeaderLayer::if_not_present(
            CACHE_CONTROL,
            HeaderValue::from_static(shell_cache),
        ))
}

/// Build the `content-security-policy` header value served on every response.
///
/// `script-src` stays strict — `'self'` with **no** `'unsafe-inline'` — and
/// additionally lists a `'sha256-…'` source for each inline `<script>` found in
/// the served HTML shells: the anti-FOUC theme init in `app.html` and
/// SvelteKit's hydration bootstrap. Without those hashes the browser blocks the
/// bootstrap and the SPA never mounts (a blank page behind the splash spinner).
/// Hashes are recomputed from the built assets on every startup, so a frontend
/// rebuild needs no edit here.
///
/// Other directives:
/// - `style-src` keeps `'unsafe-inline'` because the frontend sets inline styles
///   (`element.style.*`) for UI state — impractical to migrate to classes.
/// - `frame-src` lists `blob:` explicitly (`*` only matches network schemes) for
///   inline PDF/document viewers; `media-src` lists `blob:` for blob video/audio.
pub fn content_security_policy(config: &AppConfig) -> String {
    let static_path = resolve_static_path(config);
    let hashes = inline_script_csp_hashes(&static_path);
    if hashes.is_empty() {
        tracing::warn!(
            static_path = %static_path.display(),
            "CSP: no inline <script> hashes computed — if the SPA shell ships \
             inline scripts they will be blocked by script-src 'self'. Check the \
             static asset path (OXICLOUD_STATIC_PATH)."
        );
    }

    let mut script_src = String::from("script-src 'self'");
    for hash in &hashes {
        script_src.push(' ');
        script_src.push_str(hash);
    }

    format!(
        "default-src 'self'; \
         {script_src}; \
         worker-src 'self'; \
         style-src 'self' 'unsafe-inline'; \
         img-src 'self' data: blob: https:; \
         media-src 'self' blob:; \
         connect-src 'self'; \
         font-src 'self' data:; \
         frame-src * blob:; \
         frame-ancestors 'none'; \
         base-uri 'self'; \
         form-action 'self'"
    )
}

/// SHA-256 CSP source expressions (`'sha256-…'`) for every inline `<script>` in
/// the root-level HTML shells under `static_path`.
///
/// The browser hashes the exact bytes between `<script …>` and `</script>`, so
/// each shell is read verbatim and that slice hashed. Scripts carrying a `src`
/// attribute are external (already allowed by `'self'`) and skipped. Only the
/// directory root is scanned — the SPA is client-rendered (SSR/prerender off),
/// so the only inline-script shell is `index.html`; any legacy pages sit beside
/// it. Returns a deduplicated, sorted list; empty when the dir is unreadable
/// (e.g. a Vite dev server serving HTML on its own port instead).
fn inline_script_csp_hashes(static_path: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(static_path) else {
        return Vec::new();
    };

    let mut hashes = BTreeSet::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("html") {
            continue;
        }
        let Ok(html) = std::fs::read_to_string(&path) else {
            continue;
        };
        for script in inline_scripts(&html) {
            hashes.insert(csp_hash(script));
        }
    }
    hashes.into_iter().collect()
}

/// The CSP `'sha256-<base64>'` source expression for one inline script body.
fn csp_hash(script: &str) -> String {
    let digest = Sha256::digest(script.as_bytes());
    let encoded = base64::engine::general_purpose::STANDARD.encode(digest);
    format!("'sha256-{encoded}'")
}

/// Text content of every inline `<script>` (no `src`) in `html`, returned as
/// byte-exact slices suitable for CSP hashing.
fn inline_scripts(html: &str) -> Vec<&str> {
    let mut scripts = Vec::new();
    let mut cursor = 0;
    while let Some(rel) = find_ci(&html[cursor..], "<script") {
        let tag_start = cursor + rel;
        // End of the opening tag.
        let Some(gt) = html[tag_start..].find('>') else {
            break;
        };
        let open_tag = &html[tag_start..tag_start + gt + 1];
        let content_start = tag_start + gt + 1;
        // Matching close tag.
        let Some(close_rel) = find_ci(&html[content_start..], "</script>") else {
            break;
        };
        let content_end = content_start + close_rel;
        if !opening_tag_has_src(open_tag) {
            scripts.push(&html[content_start..content_end]);
        }
        cursor = content_end + "</script>".len();
    }
    scripts
}

/// Whether a `<script …>` opening tag carries a `src` attribute (i.e. it loads
/// an external file rather than inlining code).
fn opening_tag_has_src(open_tag: &str) -> bool {
    open_tag
        .to_ascii_lowercase()
        .split(|c: char| c.is_whitespace() || c == '/')
        .any(|token| token == "src" || token.starts_with("src="))
}

/// ASCII-case-insensitive substring search. The returned byte offset is a valid
/// `str` boundary because `needle` (and therefore every matched byte) is ASCII.
fn find_ci(haystack: &str, needle: &str) -> Option<usize> {
    let (hay, ndl) = (haystack.as_bytes(), needle.as_bytes());
    if ndl.is_empty() || hay.len() < ndl.len() {
        return None;
    }
    (0..=hay.len() - ndl.len())
        .find(|&start| hay[start..start + ndl.len()].eq_ignore_ascii_case(ndl))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_inline_script_content_verbatim() {
        // Leading/trailing whitespace inside the tag is part of what the browser
        // hashes, so it must be preserved exactly.
        let html = "<head><script>\n  alert(1);\n</script></head>";
        assert_eq!(inline_scripts(html), vec!["\n  alert(1);\n"]);
    }

    #[test]
    fn skips_external_src_scripts() {
        let html = r#"<script src="/app.js"></script><script>boot();</script>"#;
        assert_eq!(inline_scripts(html), vec!["boot();"]);
    }

    #[test]
    fn keeps_inline_module_skips_module_with_src() {
        let html =
            r#"<script type="module" src="/x.js"></script><script type="module">go();</script>"#;
        assert_eq!(inline_scripts(html), vec!["go();"]);
    }

    #[test]
    fn case_insensitive_tag_matching() {
        let html = "<SCRIPT>run();</SCRIPT>";
        assert_eq!(inline_scripts(html), vec!["run();"]);
    }

    #[test]
    fn empty_inline_script_hash_matches_known_sha256_vector() {
        // SHA-256 of the empty string, base64 — the canonical empty digest.
        assert_eq!(
            csp_hash(""),
            "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='"
        );
    }

    #[test]
    fn identical_scripts_produce_one_deduplicated_hash() {
        let html = "<script>x()</script><script>x()</script>";
        let mut set = BTreeSet::new();
        for s in inline_scripts(html) {
            set.insert(csp_hash(s));
        }
        assert_eq!(set.len(), 1);
    }

    #[test]
    fn distinct_scripts_produce_distinct_hashes() {
        assert_ne!(csp_hash("a()"), csp_hash("b()"));
    }
}
