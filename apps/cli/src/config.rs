use std::path::PathBuf;

use crate::error::{AppError, ErrorCode};

const DEFAULT_API_URL: &str = "https://observer.detent.sh";
const DEFAULT_DEVICE_CLIENT_ID: &str = "detent-cli";
const DETENT_DIR_NAME: &str = ".detent";
const DETENT_DEV_DIR_NAME: &str = ".detent-dev";

pub fn api_url() -> String {
    std::env::var("DETENT_API_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_API_URL.to_string())
}

pub fn device_client_id() -> String {
    std::env::var("DETENT_DEVICE_CLIENT_ID")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_DEVICE_CLIENT_ID.to_string())
}

pub fn detent_home() -> Result<PathBuf, AppError> {
    if let Some(value) = std::env::var_os("DETENT_HOME") {
        return validate_detent_home_override(PathBuf::from(value));
    }

    let dir_name = if cfg!(debug_assertions) {
        DETENT_DEV_DIR_NAME
    } else {
        DETENT_DIR_NAME
    };

    resolve_detent_home(dirs::home_dir(), dir_name)
}

fn resolve_detent_home(home: Option<PathBuf>, dir_name: &str) -> Result<PathBuf, AppError> {
    let home = home.ok_or_else(|| {
        AppError::new(
            ErrorCode::InvalidConfiguration,
            "unable to determine home directory; set DETENT_HOME to an absolute path",
            1,
        )
    })?;
    Ok(home.join(dir_name))
}

fn validate_detent_home_override(candidate: PathBuf) -> Result<PathBuf, AppError> {
    let invalid = candidate.as_os_str().is_empty()
        || candidate
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
        || !candidate.is_absolute();
    if invalid {
        return Err(AppError::new(
            ErrorCode::InvalidConfiguration,
            "DETENT_HOME must be an absolute path without '..'",
            1,
        ));
    }

    Ok(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support;

    #[test]
    fn defaults_api_url() {
        let _guard = EnvVarGuard::set("DETENT_API_URL", None);
        assert_eq!(api_url(), DEFAULT_API_URL);
    }

    #[test]
    fn defaults_device_client_id() {
        let _guard = EnvVarGuard::set("DETENT_DEVICE_CLIENT_ID", None);
        assert_eq!(device_client_id(), DEFAULT_DEVICE_CLIENT_ID);
    }

    #[test]
    fn respects_device_client_id_override() {
        let _guard = EnvVarGuard::set("DETENT_DEVICE_CLIENT_ID", Some("custom-cli"));
        assert_eq!(device_client_id(), "custom-cli");
    }

    #[test]
    fn respects_absolute_detent_home_override() {
        let _guard = EnvVarGuard::set("DETENT_HOME", Some("/tmp/detent-home"));
        assert_eq!(
            detent_home().expect("absolute override should be respected"),
            PathBuf::from("/tmp/detent-home")
        );
    }

    #[test]
    fn rejects_relative_detent_home_override() {
        let _guard = EnvVarGuard::set("DETENT_HOME", Some("tmp/detent-home"));
        let error = detent_home().expect_err("relative override should fail");
        assert_eq!(error.code().as_str(), "invalid_configuration");
    }

    #[test]
    fn rejects_parent_directory_detent_home_override() {
        let error = validate_detent_home_override(PathBuf::from("/tmp/../detent-home"))
            .expect_err("parent-dir override should fail");
        assert_eq!(error.code().as_str(), "invalid_configuration");
    }

    #[test]
    fn errors_when_home_directory_is_unavailable() {
        let error = resolve_detent_home(None, DETENT_DIR_NAME)
            .expect_err("missing home directory should fail");
        assert_eq!(error.code().as_str(), "invalid_configuration");
    }

    struct EnvVarGuard {
        _lock: std::sync::MutexGuard<'static, ()>,
        key: &'static str,
        original: Option<String>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: Option<&str>) -> Self {
            let lock = test_support::env_lock();
            let original = std::env::var(key).ok();
            match value {
                Some(value) => unsafe { std::env::set_var(key, value) },
                None => unsafe { std::env::remove_var(key) },
            }
            Self {
                _lock: lock,
                key,
                original,
            }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match &self.original {
                Some(value) => unsafe { std::env::set_var(self.key, value) },
                None => unsafe { std::env::remove_var(self.key) },
            }
        }
    }
}
