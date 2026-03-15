use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::config;
use crate::error::{AppError, ErrorCode};

const CREDENTIALS_FILE: &str = "credentials.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredCredentials {
    pub access_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    pub expires_at: u64,
}

pub fn load_credentials() -> Result<Option<StoredCredentials>, AppError> {
    let path = credentials_path()?;
    if !path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&path)
        .map_err(|error| AppError::internal(format!("failed to read credentials: {error}")))?;
    if content.trim().is_empty() {
        return Ok(None);
    }

    let credentials = serde_json::from_str::<StoredCredentials>(&content).map_err(|error| {
        AppError::new(
            ErrorCode::InvalidData,
            format!("credentials file is invalid: {error}"),
            1,
        )
    })?;

    validate_credentials(&credentials)?;

    Ok(Some(credentials))
}

pub fn save_credentials(credentials: &StoredCredentials) -> Result<(), AppError> {
    let dir = config::detent_home()?;
    fs::create_dir_all(&dir)
        .map_err(|error| AppError::internal(format!("failed to create credentials directory: {error}")))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|error| {
            AppError::internal(format!("failed to secure credentials directory: {error}"))
        })?;
    }

    let path = credentials_path()?;
    let temp_path = path.with_extension("json.tmp");
    let content = serde_json::to_string_pretty(credentials)
        .map_err(|error| AppError::internal(format!("failed to serialize credentials: {error}")))?;
    fs::write(&temp_path, format!("{content}\n"))
        .map_err(|error| AppError::internal(format!("failed to save credentials: {error}")))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        fs::set_permissions(&temp_path, fs::Permissions::from_mode(0o600)).map_err(|error| {
            AppError::internal(format!("failed to secure credentials file: {error}"))
        })?;
    }

    if let Err(error) = fs::rename(&temp_path, &path) {
        if !replace_existing_file(&temp_path, &path, &error)? {
            return Err(AppError::internal(format!(
                "failed to finalize credentials save: {error}"
            )));
        }
    }

    Ok(())
}

pub fn clear_credentials() -> Result<bool, AppError> {
    let path = credentials_path()?;
    if !path.exists() {
        return Ok(false);
    }

    fs::remove_file(&path)
        .map_err(|error| AppError::internal(format!("failed to remove credentials: {error}")))?;
    Ok(true)
}

fn credentials_path() -> Result<PathBuf, AppError> {
    Ok(config::detent_home()?.join(CREDENTIALS_FILE))
}

fn replace_existing_file(
    _temp_path: &PathBuf,
    _path: &PathBuf,
    _error: &std::io::Error,
) -> Result<bool, AppError> {
    #[cfg(windows)]
    {
        let is_conflict_error =
            _error.kind() == std::io::ErrorKind::AlreadyExists || _error.raw_os_error() == Some(183);
        if is_conflict_error && _path.exists() {
            fs::remove_file(_path).map_err(|remove_error| {
                AppError::internal(format!(
                    "failed to replace credentials after rename error ({_error}): {remove_error}"
                ))
            })?;
            fs::rename(_temp_path, _path).map_err(|rename_error| {
                AppError::internal(format!(
                    "failed to replace credentials after rename error ({_error}): {rename_error}"
                ))
            })?;
            return Ok(true);
        }
    }

    Ok(false)
}

fn validate_credentials(credentials: &StoredCredentials) -> Result<(), AppError> {
    if credentials.access_token.trim().is_empty() {
        return Err(AppError::new(
            ErrorCode::InvalidData,
            "credentials file is invalid: access_token must be non-empty",
            1,
        ));
    }

    if credentials
        .refresh_token
        .as_ref()
        .is_some_and(|value| value.trim().is_empty())
    {
        return Err(AppError::new(
            ErrorCode::InvalidData,
            "credentials file is invalid: refresh_token must be non-empty when present",
            1,
        ));
    }

    if credentials.expires_at == 0 {
        return Err(AppError::new(
            ErrorCode::InvalidData,
            "credentials file is invalid: expires_at must be greater than zero",
            1,
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support;

    #[test]
    fn round_trip_credentials() {
        let temp_dir = tempfile_dir();
        let _guard = EnvVarGuard::set("DETENT_HOME", Some(temp_dir.to_str().expect("utf8")));

        let credentials = StoredCredentials {
            access_token: "access-token".into(),
            refresh_token: Some("refresh-token".into()),
            expires_at: 123,
        };

        save_credentials(&credentials).expect("should save");
        let loaded = load_credentials().expect("should load");

        assert_eq!(loaded, Some(credentials));
    }

    #[test]
    fn save_credentials_overwrites_existing_file() {
        let temp_dir = tempfile_dir();
        let _guard = EnvVarGuard::set("DETENT_HOME", Some(temp_dir.to_str().expect("utf8")));

        let initial = StoredCredentials {
            access_token: "first-token".into(),
            refresh_token: Some("first-refresh".into()),
            expires_at: 123,
        };
        let updated = StoredCredentials {
            access_token: "second-token".into(),
            refresh_token: Some("second-refresh".into()),
            expires_at: 456,
        };

        save_credentials(&initial).expect("initial save should work");
        save_credentials(&updated).expect("second save should overwrite");

        let loaded = load_credentials().expect("should load after overwrite");
        assert_eq!(loaded, Some(updated));
    }

    #[test]
    fn clear_returns_false_when_missing() {
        let temp_dir = tempfile_dir();
        let _guard = EnvVarGuard::set("DETENT_HOME", Some(temp_dir.to_str().expect("utf8")));

        assert!(!clear_credentials().expect("should check"));
    }

    #[test]
    fn invalid_empty_access_token_is_rejected() {
        let temp_dir = tempfile_dir();
        let _guard = EnvVarGuard::set("DETENT_HOME", Some(temp_dir.to_str().expect("utf8")));
        let path = config::detent_home()
            .expect("test detent home should resolve")
            .join(CREDENTIALS_FILE);
        fs::write(
            path,
            "{\n  \"access_token\": \"\",\n  \"expires_at\": 123\n}\n",
        )
        .expect("credentials file should be written");

        let error = load_credentials().expect_err("empty token should fail");
        assert_eq!(error.code().as_str(), "invalid_data");
    }

    fn tempfile_dir() -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "dt-auth-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should work")
                .as_nanos()
        ));
        fs::create_dir_all(&base).expect("temp dir should be created");
        base
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
