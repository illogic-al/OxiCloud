use sqlx::{Error as SqlxError, PgPool, Postgres, Transaction};
use std::future::Future;
use std::sync::Arc;
use tracing::{debug, error, info, warn};

/// Helper function to execute database operations in a transaction
/// Takes a database pool and a closure that will be executed within a transaction
/// The closure receives a transaction object that should be used for all database operations
/// If the closure returns an error, the transaction is rolled back
/// If the closure returns Ok, the transaction is committed
pub async fn with_transaction<F, T, E>(
    pool: &Arc<PgPool>,
    operation_name: &str,
    operation: F,
) -> Result<T, E>
where
    F: for<'c> FnOnce(
        &'c mut Transaction<'_, Postgres>,
    ) -> futures::future::BoxFuture<'c, Result<T, E>>,
    E: From<SqlxError> + std::fmt::Display,
{
    debug!("Starting database transaction for: {}", operation_name);

    // Begin transaction
    let mut tx = pool.begin().await.map_err(|e| {
        error!("Failed to begin transaction for {}: {}", operation_name, e);
        E::from(e)
    })?;

    // Execute the operation within the transaction
    match operation(&mut tx).await {
        Ok(result) => {
            // If operation succeeds, commit the transaction
            match tx.commit().await {
                Ok(_) => {
                    debug!("Transaction committed successfully for: {}", operation_name);
                    Ok(result)
                }
                Err(e) => {
                    error!("Failed to commit transaction for {}: {}", operation_name, e);
                    Err(E::from(e))
                }
            }
        }
        Err(e) => {
            // If operation fails, rollback the transaction
            if let Err(rollback_err) = tx.rollback().await {
                error!(
                    "Failed to rollback transaction for {}: {}",
                    operation_name, rollback_err
                );
                // Still return the original error
            } else {
                info!("Transaction rolled back for {}: {}", operation_name, e);
            }
            Err(e)
        }
    }
}

/// True when the error is a PostgreSQL deadlock abort (SQLSTATE `40P01`).
///
/// Deadlock victims are safe to re-run when the statement is a single
/// autocommit round-trip: the aborted implicit transaction left nothing
/// behind, and PostgreSQL chose this session as the victim precisely so
/// the competing transaction could finish — a retry usually succeeds
/// immediately.
pub fn is_deadlock(err: &SqlxError) -> bool {
    matches!(err, SqlxError::Database(db) if db.code().as_deref() == Some("40P01"))
}

/// Re-run `op` while it fails with an error matching `should_retry`, up to
/// 3 retries with a short growing backoff. Errors that don't match the
/// predicate — and the final attempt's error — are returned untouched, so
/// callers' existing error mapping (e.g. `23505` → already-exists) still
/// sees exactly what it expects.
pub async fn retry_when<T, E, F, Fut, P>(
    operation_name: &str,
    should_retry: P,
    op: F,
) -> Result<T, E>
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<T, E>>,
    P: Fn(&E) -> bool,
{
    const BACKOFF_MS: [u64; 3] = [10, 50, 150];

    let mut attempt = 0;
    loop {
        match op().await {
            Ok(value) => return Ok(value),
            Err(e) if attempt < BACKOFF_MS.len() && should_retry(&e) => {
                warn!(
                    "Retryable failure on {} (attempt {}/{}), backing off {}ms",
                    operation_name,
                    attempt + 1,
                    BACKOFF_MS.len() + 1,
                    BACKOFF_MS[attempt]
                );
                tokio::time::sleep(std::time::Duration::from_millis(BACKOFF_MS[attempt])).await;
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

/// [`retry_when`] specialised to PostgreSQL deadlocks (`40P01`) — the only
/// transient SQLSTATE our single-statement write paths can hit.
pub async fn retry_on_deadlock<T, F, Fut>(operation_name: &str, op: F) -> Result<T, SqlxError>
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<T, SqlxError>>,
{
    retry_when(operation_name, is_deadlock, op).await
}

#[cfg(test)]
mod tests {
    use super::retry_when;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[derive(Debug, PartialEq)]
    enum FakeError {
        Transient,
        Fatal,
    }

    #[tokio::test]
    async fn retries_transient_errors_until_success() {
        let calls = AtomicU32::new(0);
        let result = retry_when(
            "test",
            |e| *e == FakeError::Transient,
            || {
                let n = calls.fetch_add(1, Ordering::SeqCst);
                async move {
                    if n < 2 {
                        Err(FakeError::Transient)
                    } else {
                        Ok(n)
                    }
                }
            },
        )
        .await;
        assert_eq!(result, Ok(2));
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn gives_up_after_max_attempts_returning_last_error() {
        let calls = AtomicU32::new(0);
        let result: Result<(), _> = retry_when(
            "test",
            |e| *e == FakeError::Transient,
            || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Err(FakeError::Transient) }
            },
        )
        .await;
        assert_eq!(result, Err(FakeError::Transient));
        // 1 initial attempt + 3 retries
        assert_eq!(calls.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn non_matching_errors_are_not_retried() {
        let calls = AtomicU32::new(0);
        let result: Result<(), _> = retry_when(
            "test",
            |e| *e == FakeError::Transient,
            || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Err(FakeError::Fatal) }
            },
        )
        .await;
        assert_eq!(result, Err(FakeError::Fatal));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
