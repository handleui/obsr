use std::path::PathBuf;

use crate::error::{AppError, ErrorCode};

const DEFAULT_API_URL: &str = "https://observer.detent.sh";
const DETENT_DIR_NAME: &str = ".detent";
const DETENT_DEV_DIR_NAME: &str = ".detent-dev";

pub fn api_url() -> String {
    std::env::var("DETENT_API_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_API_URL.to_string())
}

pub fn detent_home() -> Result<PathBuf, AppError> {
    if let Some(path) = detent_home_override() {
        return Ok(path);
    }

    let dir_name = if cfg!(debug_assertions) {
        DETENT_DEV_DIR_NAME
    } else {
        DETENT_DIR_NAME
    };

    resolve_detent_home(dirs::home_dir(), dir_name)
}

fn detent_home_override() -> Option<PathBuf> {
    let value = std::env::var("DETENT_HOME").ok()?;
    if value.trim().is_empty() || value.contains("..") {
        return None;
    }

    let candidate = PathBuf::from(value);
    if candidate.is_absolute() {
        Some(candidate)
    } else {
        None
    }
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
        let path = detent_home().expect("relative override should fall back to home dir");
        assert!(path.ends_with(DETENT_DEV_DIR_NAME) || path.ends_with(DETENT_DIR_NAME));
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
