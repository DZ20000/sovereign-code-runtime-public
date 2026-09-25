use std::sync::Arc;

use serde_json::Value;

use crate::{
    runtime_host::RuntimeHost,
    runtime_host_supervisor::{
        RuntimeHostOwnerStatus, RuntimeHostRollingStatus, RuntimeHostSupervisor,
    },
};

#[derive(Clone)]
pub(crate) struct RuntimeHostEndpoint {
    supervisor: RuntimeHostSupervisor,
}

impl RuntimeHostEndpoint {
    pub(crate) fn new(supervisor: RuntimeHostSupervisor) -> Self {
        Self { supervisor }
    }

    pub(crate) fn active(&self) -> RuntimeHost {
        self.supervisor.active()
    }

    pub(crate) fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.supervisor.call(method, params)
    }

    pub(crate) fn owner_status(&self) -> RuntimeHostOwnerStatus {
        self.supervisor.status()
    }

    pub(crate) fn approval_current(&self) -> Result<Option<Value>, String> {
        self.supervisor.approval_current()
    }

    pub(crate) fn approval_resolve(&self, request_id: &str, decision: &str) -> Result<(), String> {
        self.supervisor.approval_resolve(request_id, decision)
    }

    pub(crate) fn shutdown(&self) -> Result<(), String> {
        self.supervisor.shutdown()
    }
}

pub(crate) trait RuntimeRollingEndpoint: Send + Sync + 'static {
    type Status;

    fn rolling_status(&self) -> Self::Status;
}

impl RuntimeRollingEndpoint for RuntimeHostEndpoint {
    type Status = RuntimeHostRollingStatus;

    fn rolling_status(&self) -> Self::Status {
        self.supervisor.rolling_status()
    }
}

pub(crate) struct RuntimeEndpointRouter<T> {
    inner: Arc<T>,
}

impl<T> RuntimeEndpointRouter<T> {
    pub(crate) fn new(endpoint: T) -> Self {
        Self {
            inner: Arc::new(endpoint),
        }
    }

    pub(crate) fn inner(&self) -> &Arc<T> {
        &self.inner
    }
}

impl<T> Clone for RuntimeEndpointRouter<T> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}

impl RuntimeEndpointRouter<RuntimeHostEndpoint> {
    pub(crate) fn active(&self) -> RuntimeHost {
        self.inner.active()
    }

    pub(crate) fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.inner.call(method, params)
    }

    pub(crate) fn owner_status(&self) -> RuntimeHostOwnerStatus {
        self.inner.owner_status()
    }

    pub(crate) fn approval_current(&self) -> Result<Option<Value>, String> {
        self.inner.approval_current()
    }

    pub(crate) fn approval_resolve(&self, request_id: &str, decision: &str) -> Result<(), String> {
        self.inner.approval_resolve(request_id, decision)
    }

    pub(crate) fn shutdown(&self) -> Result<(), String> {
        self.inner.shutdown()
    }
}

pub(crate) struct RuntimeRollingService<T> {
    router: RuntimeEndpointRouter<T>,
}

impl<T> RuntimeRollingService<T> {
    pub(crate) fn new(router: RuntimeEndpointRouter<T>) -> Self {
        Self { router }
    }
}

impl<T> RuntimeRollingService<T>
where
    T: RuntimeRollingEndpoint,
{
    pub(crate) fn status(&self) -> T::Status {
        self.router.inner().rolling_status()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::{RuntimeEndpointRouter, RuntimeRollingEndpoint, RuntimeRollingService};

    struct FakeEndpoint {
        status: usize,
    }

    impl RuntimeRollingEndpoint for FakeEndpoint {
        type Status = usize;

        fn rolling_status(&self) -> Self::Status {
            self.status
        }
    }

    #[test]
    fn clones_share_one_authoritative_endpoint() {
        let router = RuntimeEndpointRouter::new(FakeEndpoint { status: 7 });
        let cloned = router.clone();

        assert!(Arc::ptr_eq(router.inner(), cloned.inner()));
        assert_eq!(RuntimeRollingService::new(cloned).status(), 7);
    }
}
