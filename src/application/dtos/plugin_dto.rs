//! DTOs for the admin plugin-management API.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::application::ports::plugin_ports::PluginInfo;

/// A single installed plugin as returned by `GET /api/admin/plugins`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PluginInfoDto {
    pub id: String,
    pub name: String,
    pub version: String,
    pub abi: u32,
    /// Events the plugin subscribes to (e.g. `file.uploaded`).
    pub subscriptions: Vec<String>,
    pub enabled: bool,
}

impl From<PluginInfo> for PluginInfoDto {
    fn from(p: PluginInfo) -> Self {
        Self {
            id: p.id,
            name: p.name,
            version: p.version,
            abi: p.abi,
            subscriptions: p.subscriptions,
            enabled: p.enabled,
        }
    }
}

/// Request body for `PUT /api/admin/plugins/{id}/enabled`.
#[derive(Debug, Deserialize, ToSchema)]
pub struct SetEnabledDto {
    pub enabled: bool,
}
