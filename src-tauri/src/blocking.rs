//! Keep synchronous process and filesystem work off the window and async workers.

pub async fn run<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|err| format!("Background task failed: {err}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::sync::mpsc;
    use std::task::{Context, Poll, Waker};
    use std::time::Duration;

    #[test]
    fn slow_work_yields_and_runs_on_another_thread() {
        let caller = std::thread::current().id();
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let mut task = Box::pin(run(move || {
            started_tx.send(std::thread::current().id()).unwrap();
            // A bounded wait also makes regressions fail instead of hanging tests.
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(42)
        }));
        let mut context = Context::from_waker(Waker::noop());
        assert!(matches!(task.as_mut().poll(&mut context), Poll::Pending));
        assert_ne!(
            started_rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            caller
        );
        release_tx.send(()).unwrap();
        assert_eq!(tauri::async_runtime::block_on(task), Ok(42));
    }

    #[test]
    fn preserves_operation_errors() {
        assert_eq!(
            tauri::async_runtime::block_on(run(|| Err::<(), _>("git failed".into()))),
            Err("git failed".into())
        );
    }
}
