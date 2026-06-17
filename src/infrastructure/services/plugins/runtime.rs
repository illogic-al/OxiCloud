//! The Extism runtime wrapper — one sandboxed, per-invocation WASM instance.
//!
//! Isolation is the point: no WASI, no filesystem, no network, a memory cap, and
//! a wall-clock timeout. The only authority a plugin has is the host `log`
//! function. Every boundary crossing is wrapped so a trap/timeout/OOM/malformed
//! output is captured as an [`InvokeOutcome`] and never propagates to the caller.

use std::time::Duration;

use extism::{Manifest as ExtismManifest, PTR, PluginBuilder, UserData, Wasm};

use crate::application::ports::plugin_ports::{HOST_NAMESPACE, OXICLOUD_PLUGIN_ABI, PluginOutput};
use crate::common::config::PluginConfig;

/// Per-invocation host state: the plugin's identity (for log attribution) plus
/// the buffer the `log` host function appends to. Shared with the running
/// instance via [`UserData`]; read back after the call via [`drain`].
#[derive(Default)]
pub struct LogContext {
    pub plugin_id: String,
    pub invocation_id: String,
    pub lines: Vec<(String, String)>,
}

// The entire authority surface: log(level, message) -> (). Observe-only — it
// reads nothing and mutates no host state. Unknown levels clamp to "info".
extism::host_fn!(oxi_log(user_data: LogContext; level: String, message: String) {
    let level = match level.as_str() {
        "debug" | "info" | "warn" | "error" => level,
        _ => "info".to_string(),
    };
    let ud = user_data.get()?;
    let mut ctx = ud.lock().unwrap();
    tracing::info!(
        target: "oxicloud::plugins",
        plugin_id = %ctx.plugin_id,
        invocation_id = %ctx.invocation_id,
        plugin_level = %level,
        "plugin log: {message}"
    );
    ctx.lines.push((level, message));
    Ok(())
});

/// The result of one boundary crossing. Only `Ok` is a success; every other
/// variant is a contained failure the host audit-logs and moves past.
#[derive(Debug)]
pub enum InvokeOutcome {
    /// `handle` returned `{"ok": true}`.
    Ok,
    /// `handle` returned `{"ok": false, "error": ...}`.
    PluginError(String),
    /// A wasm trap (panic/`unreachable`/OOM/etc.).
    Trap(String),
    /// The wall-clock timeout cancelled the call.
    Timeout,
    /// The instance could not be built (bad/unloadable wasm, unresolved import).
    LoadError(String),
    /// `abi_version` returned a value the host does not speak.
    AbiMismatch { got: u32 },
    /// A subscribed event has no matching `on_<event>` export in the module.
    MissingExport(String),
    /// The event handler returned bytes that are not a valid `PluginOutput`.
    MalformedOutput(String),
    /// The serialized input exceeded the configured cap; nothing was invoked.
    MalformedInput { size: usize, max: usize },
}

impl InvokeOutcome {
    pub fn is_ok(&self) -> bool {
        matches!(self, InvokeOutcome::Ok)
    }

    /// Stable, machine-readable key for audit logs.
    pub fn reason(&self) -> &'static str {
        match self {
            InvokeOutcome::Ok => "ok",
            InvokeOutcome::PluginError(_) => "plugin_error",
            InvokeOutcome::Trap(_) => "trap",
            InvokeOutcome::Timeout => "timeout",
            InvokeOutcome::LoadError(_) => "load_error",
            InvokeOutcome::AbiMismatch { .. } => "abi_mismatch",
            InvokeOutcome::MissingExport(_) => "missing_export",
            InvokeOutcome::MalformedOutput(_) => "malformed_output",
            InvokeOutcome::MalformedInput { .. } => "malformed_input",
        }
    }
}

/// Outcome plus whatever the plugin logged (for tests and tracing).
pub struct InvokeResult {
    pub outcome: InvokeOutcome,
    pub logs: Vec<(String, String)>,
}

/// A loaded-but-not-instantiated plugin: the wasm bytes plus identity. A fresh
/// instance is built for every invocation (no reuse → no cross-user state).
pub struct PluginRuntime {
    plugin_id: String,
    wasm_bytes: Vec<u8>,
}

impl PluginRuntime {
    pub fn new(plugin_id: impl Into<String>, wasm_bytes: Vec<u8>) -> Self {
        Self {
            plugin_id: plugin_id.into(),
            wasm_bytes,
        }
    }

    pub fn plugin_id(&self) -> &str {
        &self.plugin_id
    }

    /// Build a fresh, fully locked-down instance for one invocation.
    fn build(
        &self,
        cfg: &PluginConfig,
        logs: UserData<LogContext>,
    ) -> Result<extism::Plugin, extism::Error> {
        let manifest = ExtismManifest::new([Wasm::data(self.wasm_bytes.clone())])
            .with_memory_max(cfg.max_memory_pages) // pages × 64 KiB
            .with_timeout(Duration::from_millis(cfg.invocation_timeout_ms))
            .disallow_all_hosts(); // no outbound network
        // No allowed_paths -> no filesystem. with_wasi(false) -> no ambient authority.
        PluginBuilder::new(manifest)
            .with_wasi(false)
            .with_function_in_namespace(HOST_NAMESPACE, "log", [PTR, PTR], [], logs, oxi_log)
            .build()
    }

    /// Probe a throwaway instance at load time: check `abi_version`, then verify
    /// every `required_export` (the `on_<event>` symbol for each subscribed
    /// event) actually exists in the module. Rejects lying, unloadable, or
    /// incompletely-implemented plugins before they are ever registered.
    pub fn check_loadable(&self, cfg: &PluginConfig, required_exports: &[String]) -> InvokeOutcome {
        let logs = UserData::new(LogContext::default());
        let mut plugin = match self.build(cfg, logs) {
            Ok(p) => p,
            Err(e) => return InvokeOutcome::LoadError(e.to_string()),
        };
        match plugin.call::<(), u32>("abi_version", ()) {
            Ok(v) if v == OXICLOUD_PLUGIN_ABI => {}
            Ok(v) => return InvokeOutcome::AbiMismatch { got: v },
            Err(e) => return classify_call_error(e),
        }
        for export in required_exports {
            if !plugin.function_exists(export) {
                return InvokeOutcome::MissingExport(export.clone());
            }
        }
        InvokeOutcome::Ok
    }

    /// Run one event-handler invocation, fully fault-isolated. `export` is the
    /// `on_<event>` symbol to call (see `event_export_name`).
    pub fn invoke(
        &self,
        cfg: &PluginConfig,
        export: &str,
        invocation_id: &str,
        input_json: &str,
    ) -> InvokeResult {
        if input_json.len() > cfg.max_input_bytes {
            return InvokeResult {
                outcome: InvokeOutcome::MalformedInput {
                    size: input_json.len(),
                    max: cfg.max_input_bytes,
                },
                logs: Vec::new(),
            };
        }

        let logs = UserData::new(LogContext {
            plugin_id: self.plugin_id.clone(),
            invocation_id: invocation_id.to_string(),
            lines: Vec::new(),
        });

        let mut plugin = match self.build(cfg, logs.clone()) {
            Ok(p) => p,
            Err(e) => {
                return InvokeResult {
                    outcome: InvokeOutcome::LoadError(e.to_string()),
                    logs: drain(&logs),
                };
            }
        };

        // Version negotiation at the door.
        match plugin.call::<(), u32>("abi_version", ()) {
            Ok(v) if v == OXICLOUD_PLUGIN_ABI => {}
            Ok(v) => {
                return InvokeResult {
                    outcome: InvokeOutcome::AbiMismatch { got: v },
                    logs: drain(&logs),
                };
            }
            Err(e) => {
                return InvokeResult {
                    outcome: classify_call_error(e),
                    logs: drain(&logs),
                };
            }
        }

        // The actual call. Traps, timeouts, and OOM all surface here as Err.
        let outcome = match plugin.call::<&str, String>(export, input_json) {
            Ok(out) => match serde_json::from_str::<PluginOutput>(&out) {
                Ok(parsed) if parsed.ok => InvokeOutcome::Ok,
                Ok(parsed) => {
                    InvokeOutcome::PluginError(parsed.error.unwrap_or_else(|| "unspecified".into()))
                }
                Err(e) => InvokeOutcome::MalformedOutput(e.to_string()),
            },
            Err(e) => classify_call_error(e),
        };

        InvokeResult {
            outcome,
            logs: drain(&logs),
        }
        // `plugin` dropped here -> sandbox memory reclaimed.
    }
}

/// Extism signals a wall-clock timeout with `Error::msg("timeout")`; everything
/// else from a `call` is a trap (panic, `unreachable`, OOM, etc.).
fn classify_call_error(e: extism::Error) -> InvokeOutcome {
    let msg = e.to_string();
    if msg.to_ascii_lowercase().contains("timeout") {
        InvokeOutcome::Timeout
    } else {
        InvokeOutcome::Trap(msg)
    }
}

fn drain(logs: &UserData<LogContext>) -> Vec<(String, String)> {
    logs.get()
        .ok()
        .map(|m| m.lock().unwrap().lines.clone())
        .unwrap_or_default()
}
