//! WASM plugin runtime (Extism) — M0 walking skeleton.
//!
//! Compiled only under the `plugins` cargo feature. The application layer talks
//! to [`manager::ExtismPluginManager`] through the
//! [`crate::application::ports::plugin_ports::PluginDispatchPort`] trait, so the
//! Extism types here never leak past the infrastructure boundary.

pub mod manager;
pub mod manifest;
pub mod runtime;

pub use manager::ExtismPluginManager;

#[cfg(test)]
mod manager_test;
#[cfg(test)]
mod runtime_test;
