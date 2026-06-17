//! WASM plugin runtime ports (ABI v0 — M0 walking skeleton).
//!
//! This module is the *entire* contract surface the rest of the application
//! talks to. Concrete Extism types live in the infrastructure layer behind
//! [`PluginDispatchPort`], keeping the hexagonal boundary intact: nothing in
//! `application/` or `domain/` depends on the WASM runtime.
//!
//! The ABI is intentionally tiny (see the M0 spec):
//! - constant [`OXICLOUD_PLUGIN_ABI`] / namespace [`HOST_NAMESPACE`];
//! - plugin exports `abi_version` plus one handler per event it subscribes to,
//!   named `on_<event>` (see [`event_export_name`]) — e.g. `on_file_uploaded`,
//!   `on_user_login`;
//! - one host import `log` (observe-only — the only authority a plugin has).

use serde::{Deserialize, Serialize};

/// The single ABI version this host speaks. A breaking change bumps this and
/// the namespace suffix ([`HOST_NAMESPACE`]); plugins built against a different
/// value are rejected at load, never silently mis-run.
pub const OXICLOUD_PLUGIN_ABI: u32 = 0;

/// Namespace of the host functions a plugin may import. The `:v0` suffix is
/// part of the import path so a future `v1` is a *different* symbol.
pub const HOST_NAMESPACE: &str = "oxicloud:host:v0";

/// File committed (created or content-replaced). Payload is metadata only.
pub const EVENT_FILE_UPLOADED: &str = "file.uploaded";
/// A user authenticated successfully.
pub const EVENT_USER_LOGIN: &str = "user.login";

/// Every event the host can emit. Manifest validation accepts only these — a
/// `subscribe` entry outside this set rejects the plugin at load. Adding an
/// event is purely additive (no ABI bump): append its name here, build the
/// payload in a bridge, register that bridge in DI.
pub const KNOWN_EVENTS: &[&str] = &[EVENT_FILE_UPLOADED, EVENT_USER_LOGIN];

/// The plugin export the host calls for `event`: `on_<event>` with dots replaced
/// by underscores (a WASM export must be a valid identifier). A plugin handles an
/// event by exporting this symbol; the host calls exactly the export matching the
/// dispatched event. `file.uploaded` → `on_file_uploaded`; `user.login` →
/// `on_user_login`.
pub fn event_export_name(event: &str) -> String {
    format!("on_{}", event.replace('.', "_"))
}

/// Outbound port: the application asks the (infrastructure) plugin runtime to
/// dispatch an event to every subscribed plugin. Dispatch is fire-and-forget —
/// the implementation owns all isolation, timeouts, and fault handling, and the
/// caller (a lifecycle hook bridge) never awaits it.
pub trait PluginDispatchPort: Send + Sync + 'static {
    /// Dispatch an event to every plugin subscribed to `event.name`.
    fn dispatch(&self, event: PluginEvent);

    /// Cheap predicate so a bridge can skip building the payload entirely when
    /// no plugin subscribes to `event`.
    fn has_subscribers(&self, event: &str) -> bool;
}

/// Inbound port: admin management of installed plugins (list / toggle / install
/// / remove). The concrete implementation (the infrastructure
/// `ExtismPluginManager`) owns the same in-memory plugin set the dispatch port
/// reads, so a toggle or install takes effect on the live dispatch path with no
/// restart. All operations are admin-gated at the HTTP layer.
pub trait PluginManagementPort: Send + Sync + 'static {
    /// Every installed plugin, enabled or not, with its load-time metadata.
    fn list(&self) -> Vec<PluginInfo>;

    /// Enable or disable a plugin by id. The change is persisted so it survives
    /// a restart, and is reflected immediately by [`PluginDispatchPort`].
    fn set_enabled(&self, id: &str, enabled: bool) -> Result<(), PluginMgmtError>;

    /// Validate and install a new plugin from its `plugin.toml` text and `.wasm`
    /// bytes, writing it to the plugins directory and loading it (enabled). The
    /// id is taken from the manifest; a clash with an existing plugin is
    /// rejected with [`PluginMgmtError::IdExists`].
    fn install(&self, manifest_toml: &str, wasm: Vec<u8>) -> Result<PluginInfo, PluginMgmtError>;

    /// Install a plugin from a `.zip` bundle containing `plugin.toml` and the
    /// `.wasm` named by its `entrypoint` (both at the archive root or together
    /// under a single top-level folder). Extracts the two and delegates to
    /// [`PluginManagementPort::install`].
    fn install_bundle(&self, zip: Vec<u8>) -> Result<PluginInfo, PluginMgmtError>;

    /// Unload a plugin and delete its directory.
    fn remove(&self, id: &str) -> Result<(), PluginMgmtError>;
}

/// A single installed plugin's load-time metadata, as surfaced to the admin UI.
#[derive(Debug, Clone)]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub abi: u32,
    pub subscriptions: Vec<String>,
    pub enabled: bool,
}

/// Why a management operation failed. `reason()` yields the stable, machine
/// readable key used in audit logs and surfaced to the UI.
#[derive(Debug)]
pub enum PluginMgmtError {
    /// No plugin with that id is installed.
    NotFound,
    /// An install was attempted for an id that already exists.
    IdExists,
    /// The bundle failed manifest or runtime validation. Carries the stable
    /// reason key from `ManifestError::reason()` / `InvokeOutcome::reason()`,
    /// plus a few install-only keys (`bad_id`, `bad_entrypoint`, `bad_zip`,
    /// `no_manifest_in_zip`, `entrypoint_not_in_zip`).
    Rejected(&'static str),
    /// A filesystem error while writing or removing the plugin.
    Io(String),
}

impl PluginMgmtError {
    /// Stable key for `tracing` audit lines; never reworded across releases.
    pub fn reason(&self) -> &'static str {
        match self {
            PluginMgmtError::NotFound => "not_found",
            PluginMgmtError::IdExists => "id_exists",
            PluginMgmtError::Rejected(r) => r,
            PluginMgmtError::Io(_) => "io_error",
        }
    }
}

/// A single event to fan out to plugins. The `payload` JSON shape is specific to
/// each `name` and is built by that event's bridge — the runtime is event-blind
/// and never inspects it. Payloads carry metadata only, never file contents.
#[derive(Debug, Clone)]
pub struct PluginEvent {
    /// One of [`KNOWN_EVENTS`].
    pub name: &'static str,
    /// Opaque id of the user the event concerns, when known.
    pub user_id: Option<String>,
    /// Unique id minted per dispatch, correlating host logs with plugin output.
    pub invocation_id: String,
    /// Event-specific payload handed to the plugin as `PluginInput.payload`.
    pub payload: serde_json::Value,
}

// ---- Wire DTOs (ABI v0 JSON shapes, §3.4 of the spec) ----------------------

/// Serialized host → plugin and handed to `handle` as a UTF-8 JSON string.
#[derive(Debug, Clone, Serialize)]
pub struct PluginInput {
    pub abi: u32,
    pub event: String,
    pub context: PluginContext,
    pub payload: serde_json::Value,
}

/// Invocation context. `user_id` is the owner of the event; because each
/// invocation is a fresh instance, a plugin never sees two users at once.
#[derive(Debug, Clone, Serialize)]
pub struct PluginContext {
    pub plugin_id: String,
    pub user_id: Option<String>,
    pub invocation_id: String,
}

/// Returned from `handle`. M0 has no `actions` array — the plugin cannot ask the
/// host to do anything (observe-only). Unknown fields are ignored.
#[derive(Debug, Clone, Deserialize)]
pub struct PluginOutput {
    pub ok: bool,
    #[serde(default)]
    pub error: Option<String>,
}
