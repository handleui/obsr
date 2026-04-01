use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use crate::config;
use crate::error::{AppError, ErrorCode};

const SETTINGS_FILE: &str = "settings.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsStore {
    values: BTreeMap<String, String>,
}

impl SettingsStore {
    pub fn load() -> Result<Self, AppError> {
        let path = settings_path()?;
        if !path.exists() {
            return Ok(Self {
                values: BTreeMap::new(),
            });
        }

        let content = fs::read_to_string(&path)
            .map_err(|error| AppError::internal(format!("failed to read settings: {error}")))?;
        if content.trim().is_empty() {
            return Ok(Self {
                values: BTreeMap::new(),
            });
        }

        let parsed = serde_json::from_str::<serde_json::Value>(&content).map_err(|error| {
            AppError::new(
                ErrorCode::InvalidData,
                format!("settings file is invalid: {error}"),
                1,
            )
        })?;

        let object = parsed.as_object().ok_or_else(|| {
            AppError::new(
                ErrorCode::InvalidData,
                "settings file is invalid: root value must be an object",
                1,
            )
        })?;

        let mut values = BTreeMap::new();
        for (key, value) in object {
            let value = value.as_str().ok_or_else(|| {
                AppError::new(
                    ErrorCode::InvalidData,
                    format!("settings file is invalid: value for '{key}' must be a string"),
                    1,
                )
            })?;
            validate_key(key)?;
            values.insert(key.to_string(), value.to_string());
        }

        Ok(Self { values })
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(String::as_str)
    }

    pub fn set(&mut self, key: String, value: String) -> Result<(), AppError> {
        validate_key(&key)?;
        self.values.insert(key, value);
        Ok(())
    }

    pub fn entries(&self) -> impl Iterator<Item = (&str, &str)> {
        self.values
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
    }

    pub fn save(&self) -> Result<(), AppError> {
        let dir = config::detent_home()?;
        fs::create_dir_all(&dir).map_err(|error| {
            AppError::internal(format!("failed to create settings directory: {error}"))
        })?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|error| {
                AppError::internal(format!("failed to secure settings directory: {error}"))
            })?;
        }

        let path = settings_path()?;
        let temp_path = path.with_extension("json.tmp");
        let content = serde_json::to_string_pretty(&self.values).map_err(|error| {
            AppError::internal(format!("failed to serialize settings: {error}"))
        })?;
        fs::write(&temp_path, format!("{content}\n"))
            .map_err(|error| AppError::internal(format!("failed to save settings: {error}")))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            fs::set_permissions(&temp_path, fs::Permissions::from_mode(0o600)).map_err(
                |error| AppError::internal(format!("failed to secure settings file: {error}")),
            )?;
        }

        if let Err(error) = fs::rename(&temp_path, &path) {
            if !replace_existing_file(&temp_path, &path, &error)? {
                return Err(AppError::internal(format!(
                    "failed to finalize settings save: {error}"
                )));
            }
        }

        Ok(())
    }
}

fn settings_path() -> Result<PathBuf, AppError> {
    Ok(config::detent_home()?.join(SETTINGS_FILE))
}

fn validate_key(key: &str) -> Result<(), AppError> {
    if key.trim().is_empty() {
        return Err(AppError::new(
            ErrorCode::InvalidArguments,
            "setting key must be non-empty",
            2,
        ));
    }
    Ok(())
}

fn replace_existing_file(
    _temp_path: &PathBuf,
    _path: &PathBuf,
    _error: &std::io::Error,
) -> Result<bool, AppError> {
    #[cfg(windows)]
    {
        let is_conflict_error = _error.kind() == std::io::ErrorKind::AlreadyExists
            || _error.raw_os_error() == Some(183);
        if is_conflict_error && _path.exists() {
            fs::remove_file(_path).map_err(|remove_error| {
                AppError::internal(format!(
                    "failed to replace settings after rename error ({_error}): {remove_error}"
                ))
            })?;
            fs::rename(_temp_path, _path).map_err(|rename_error| {
                AppError::internal(format!(
                    "failed to replace settings after rename error ({_error}): {rename_error}"
                ))
            })?;
            return Ok(true);
        }
    }

    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support;

    #[test]
    fn round_trip_settings() {
        let temp_dir = tempfile_dir();
        let _guard = EnvVarGuard::set("DETENT_HOME", Some(temp_dir.to_str().expect("utf8")));

        let mut store = SettingsStore::load().expect("should load");
        store
            .set("theme".into(), "dark".into())
            .expect("set should work");
        store.save().expect("save should work");

        let loaded = SettingsStore::load().expect("load should work");
        assert_eq!(loaded.get("theme"), Some("dark"));
    }

    #[test]
    fn invalid_structure_is_rejected() {
        let temp_dir = tempfile_dir();
        let _guard = EnvVarGuard::set("DETENT_HOME", Some(temp_dir.to_str().expect("utf8")));
        let path = config::detent_home()
            .expect("home should resolve")
            .join(SETTINGS_FILE);
        fs::create_dir_all(config::detent_home().expect("home should resolve"))
            .expect("dir should exist");
        fs::write(path, "[]\n").expect("settings should be written");

        let error = SettingsStore::load().expect_err("should fail");
        assert_eq!(error.code().as_str(), "invalid_data");
    }

    fn tempfile_dir() -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "dt-settings-{}-{}",
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
