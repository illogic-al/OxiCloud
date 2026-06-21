//! HTTP handlers for the People (faces) feature.
//!
//! Every route is mounted only when `OXICLOUD_ENABLE_FACES` is on (the service
//! is present in `AppState`); each handler is also defensive. All work is
//! strictly caller-scoped by `PeopleService` (the repository filters by user).

use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use uuid::Uuid;

use crate::common::di::AppState;
use crate::interfaces::errors::AppError;
use crate::interfaces::middleware::auth::AuthUser;

fn disabled() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({ "error": "People feature is disabled" })),
    )
        .into_response()
}

fn bad_id() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({ "error": "invalid id" })),
    )
        .into_response()
}

/// GET /api/people — identity clusters for the caller.
pub async fn list_people(State(state): State<Arc<AppState>>, auth_user: AuthUser) -> Response {
    let Some(svc) = state.people_service.as_ref() else {
        return disabled();
    };
    match svc.list_people(auth_user.id).await {
        Ok(people) => Json(people).into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}

/// GET /api/people/{id}/photos — file ids of a person's photos.
pub async fn person_photos(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Path(id): Path<String>,
) -> Response {
    let Some(svc) = state.people_service.as_ref() else {
        return disabled();
    };
    let Ok(person_id) = Uuid::parse_str(&id) else {
        return bad_id();
    };
    match svc.person_photos(auth_user.id, person_id).await {
        Ok(files) => Json(files).into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}

#[derive(Deserialize)]
pub struct RenameBody {
    pub name: Option<String>,
}

/// PATCH /api/people/{id} — name (or clear the name of) a person.
pub async fn rename_person(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<RenameBody>,
) -> Response {
    let Some(svc) = state.people_service.as_ref() else {
        return disabled();
    };
    let Ok(person_id) = Uuid::parse_str(&id) else {
        return bad_id();
    };
    match svc.rename_person(auth_user.id, person_id, body.name).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}

#[derive(Deserialize)]
pub struct MergeBody {
    pub into: String,
    pub from: String,
}

/// POST /api/people/merge — merge `from` into `into`.
pub async fn merge_people(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Json(body): Json<MergeBody>,
) -> Response {
    let Some(svc) = state.people_service.as_ref() else {
        return disabled();
    };
    let (Ok(into), Ok(from)) = (Uuid::parse_str(&body.into), Uuid::parse_str(&body.from)) else {
        return bad_id();
    };
    match svc.merge(auth_user.id, into, from).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}

/// POST /api/people/recluster — re-run identity clustering for the caller.
pub async fn recluster(State(state): State<Arc<AppState>>, auth_user: AuthUser) -> Response {
    let Some(svc) = state.people_service.as_ref() else {
        return disabled();
    };
    match svc.recluster(auth_user.id).await {
        Ok(n) => Json(serde_json::json!({ "persons_created": n })).into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}

/// DELETE /api/people/data — erase all of the caller's face data.
pub async fn delete_all(State(state): State<Arc<AppState>>, auth_user: AuthUser) -> Response {
    let Some(svc) = state.people_service.as_ref() else {
        return disabled();
    };
    match svc.delete_all(auth_user.id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}

/// GET /api/people/faces/{file_id} — face boxes within a photo (lightbox tags).
pub async fn faces_for_file(
    State(state): State<Arc<AppState>>,
    auth_user: AuthUser,
    Path(file_id): Path<String>,
) -> Response {
    let Some(svc) = state.people_service.as_ref() else {
        return disabled();
    };
    let Ok(fid) = Uuid::parse_str(&file_id) else {
        return bad_id();
    };
    match svc.faces_for_file(auth_user.id, fid).await {
        Ok(boxes) => Json(boxes).into_response(),
        Err(e) => AppError::from(e).into_response(),
    }
}
