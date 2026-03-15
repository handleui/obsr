use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};

use crate::config;
use crate::credentials::{StoredCredentials, clear_credentials, load_credentials, save_credentials};
use crate::error::{AppError, ErrorCode};

const DEVICE_CLIENT_ID: &str = "detent-cli";
const POLL_ATTEMPTS_LIMIT: usize = 120;
const HTTP_TIMEOUT_SECONDS: u64 = 20;
const USER_AGENT: &str = concat!("dt/", env!("CARGO_PKG_VERSION"));

#[derive(Debug, Clone)]
pub struct AuthService {
    client: Client,
    base_url: String,
    sleep_fn: SleepFn,
}

type SleepFn = fn(Duration) -> SleepFuture;
type SleepFuture = std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>;

fn default_sleep(duration: Duration) -> SleepFuture {
    Box::pin(tokio::time::sleep(duration))
}

impl AuthService {
    pub fn new() -> Result<Self, AppError> {
        Self::new_with_client(
            Client::builder()
                .timeout(Duration::from_secs(HTTP_TIMEOUT_SECONDS))
                .user_agent(USER_AGENT)
                .build()
                .map_err(|error| {
                    AppError::internal(format!("failed to initialize http client: {error}"))
                })?,
            config::api_url(),
            default_sleep,
        )
    }

    fn new_with_client(client: Client, base_url: String, sleep_fn: SleepFn) -> Result<Self, AppError> {
        let base_url = normalize_base_url(&base_url)?;

        Ok(Self {
            client,
            base_url,
            sleep_fn,
        })
    }

    pub fn ensure_login_allowed(&self, force: bool) -> Result<(), AppError> {
        if !force {
            if let Some(credentials) = load_credentials()? {
                if !credentials.is_expired() {
                    return Err(AppError::new(
                        ErrorCode::Auth,
                        "already logged in; rerun with --force to re-authenticate",
                        1,
                    ));
                }
            }
        }
        Ok(())
    }

    pub async fn start_login(&self, force: bool) -> Result<DeviceAuthorizationResponse, AppError> {
        self.ensure_login_allowed(force)?;
        self.request_device_code().await
    }

    pub async fn complete_login(
        &self,
        device: DeviceAuthorizationResponse,
    ) -> Result<LoginResult, AppError> {
        let tokens = self.poll_for_token(&device.device_code, device.interval).await?;
        if !tokens.token_type.eq_ignore_ascii_case("bearer") {
            return Err(AppError::new(
                ErrorCode::Auth,
                format!("unsupported token type '{}'", tokens.token_type),
                1,
            ));
        }

        let credentials = StoredCredentials {
            access_token: tokens.access_token.clone(),
            refresh_token: tokens.refresh_token.clone(),
            expires_at: now_millis().saturating_add((tokens.expires_in as u64) * 1000),
        };
        save_credentials(&credentials)?;

        let me = self.fetch_me(&tokens.access_token).await?;

        Ok(LoginResult { device, credentials, me })
    }

    pub async fn status(&self) -> Result<AuthStatus, AppError> {
        let credentials = match load_credentials()? {
            Some(credentials) => credentials,
            None => {
                return Ok(AuthStatus::Unauthenticated {
                    api_url: self.base_url.clone(),
                });
            }
        };

        if credentials.is_expired() {
            return Ok(AuthStatus::Expired {
                api_url: self.base_url.clone(),
                expires_at: credentials.expires_at,
            });
        }

        match self.fetch_me(&credentials.access_token).await {
            Ok(me) => Ok(AuthStatus::Authenticated {
                api_url: self.base_url.clone(),
                expires_at: credentials.expires_at,
                me,
            }),
            Err(error) if error.code() == ErrorCode::Auth => {
                let _ = clear_credentials();
                Ok(AuthStatus::Unauthenticated {
                    api_url: self.base_url.clone(),
                })
            }
            Err(error) => Err(error),
        }
    }

    pub fn logout(&self) -> Result<LogoutResult, AppError> {
        let cleared = clear_credentials()?;
        Ok(LogoutResult {
            cleared,
            api_url: self.base_url.clone(),
        })
    }

    async fn request_device_code(&self) -> Result<DeviceAuthorizationResponse, AppError> {
        let response = self
            .client
            .post(format!("{}/api/auth/device/code", self.base_url))
            .json(&serde_json::json!({
                "client_id": DEVICE_CLIENT_ID,
                "scope": "openid profile email",
            }))
            .send()
            .await
            .map_err(map_network_error)?;

        parse_json_response(response, "failed to request device authorization").await
    }

    async fn poll_for_token(
        &self,
        device_code: &str,
        interval: u64,
    ) -> Result<TokenResponse, AppError> {
        let mut poll_interval = interval.max(1);

        for _ in 0..POLL_ATTEMPTS_LIMIT {
            (self.sleep_fn)(Duration::from_secs(poll_interval)).await;

            let response = self
                .client
                .post(format!("{}/api/auth/device/token", self.base_url))
                .json(&serde_json::json!({
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                    "device_code": device_code,
                    "client_id": DEVICE_CLIENT_ID,
                }))
                .send()
                .await
                .map_err(map_network_error)?;

            if response.status().is_success() {
                return parse_json_body(response, "failed to parse device token response").await;
            }

            let status = response.status();
            let error = parse_json_body::<TokenErrorResponse>(response, "failed to parse device token error").await?;
            match error.error.as_str() {
                "authorization_pending" => continue,
                "slow_down" => {
                    poll_interval += 5;
                    continue;
                }
                "expired_token" => {
                    return Err(AppError::new(
                        ErrorCode::Auth,
                        "device code expired; run `dt auth login` again",
                        1,
                    ));
                }
                "access_denied" => {
                    return Err(AppError::new(
                        ErrorCode::Auth,
                        "authorization was denied",
                        1,
                    ));
                }
                _ => {
                    return Err(AppError::new(
                        ErrorCode::Auth,
                        error
                            .error_description
                            .unwrap_or_else(|| format!("authentication failed with status {status}")),
                        1,
                    ));
                }
            }
        }

        Err(AppError::new(
            ErrorCode::Auth,
            "authentication timed out; run `dt auth login` again",
            1,
        ))
    }

    async fn fetch_me(&self, access_token: &str) -> Result<MeResponse, AppError> {
        let response = self
            .client
            .get(format!("{}/v1/auth/me", self.base_url))
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(map_network_error)?;

        if response.status() == StatusCode::UNAUTHORIZED {
            return Err(AppError::new(
                ErrorCode::Auth,
                "stored session is invalid or expired; run `dt auth login --force`",
                1,
            ));
        }

        parse_json_response(response, "failed to fetch auth status").await
    }
}

fn normalize_base_url(base_url: &str) -> Result<String, AppError> {
    let parsed = url::Url::parse(base_url.trim_end_matches('/')).map_err(|error| {
        AppError::new(
            ErrorCode::InvalidConfiguration,
            format!("DETENT_API_URL is invalid: {error}"),
            1,
        )
    })?;

    let scheme = parsed.scheme();
    if scheme != "https" && !(scheme == "http" && is_loopback_host(parsed.host_str())) {
        return Err(AppError::new(
            ErrorCode::InvalidConfiguration,
            "DETENT_API_URL must use https unless it targets localhost",
            1,
        ));
    }

    Ok(parsed.to_string().trim_end_matches('/').to_string())
}

fn is_loopback_host(host: Option<&str>) -> bool {
    matches!(host, Some("localhost" | "127.0.0.1" | "::1"))
}

#[derive(Debug, Clone, Serialize)]
pub struct LoginResult {
    pub device: DeviceAuthorizationResponse,
    #[serde(skip_serializing)]
    pub credentials: StoredCredentials,
    pub me: MeResponse,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AuthStatus {
    Unauthenticated { api_url: String },
    Expired { api_url: String, expires_at: u64 },
    Authenticated { api_url: String, expires_at: u64, me: MeResponse },
}

#[derive(Debug, Clone, Serialize)]
pub struct LogoutResult {
    pub cleared: bool,
    pub api_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceAuthorizationResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub token_type: String,
    pub expires_in: u64,
    #[serde(default)]
    pub refresh_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct TokenErrorResponse {
    error: String,
    #[serde(default)]
    error_description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeResponse {
    pub user_id: String,
    pub email: String,
    #[serde(default)]
    pub first_name: Option<String>,
    #[serde(default)]
    pub last_name: Option<String>,
}

impl StoredCredentials {
    pub fn is_expired(&self) -> bool {
        self.expires_at <= now_millis().saturating_add(5 * 60 * 1000)
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time should move forward")
        .as_millis() as u64
}

fn map_network_error(error: reqwest::Error) -> AppError {
    AppError::new(
        ErrorCode::Network,
        format!("failed to reach Observer: {error}"),
        1,
    )
}

async fn parse_json_response<T>(response: reqwest::Response, context: &str) -> Result<T, AppError>
where
    T: for<'de> Deserialize<'de>,
{
    if response.status().is_success() {
        return parse_json_body(response, context).await;
    }

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let message = if body.trim().is_empty() {
        format!("{context}: HTTP {status}")
    } else {
        format!("{context}: HTTP {status}: {body}")
    };

    Err(AppError::new(ErrorCode::Network, message, 1))
}

async fn parse_json_body<T>(response: reqwest::Response, context: &str) -> Result<T, AppError>
where
    T: for<'de> Deserialize<'de>,
{
    response
        .json::<T>()
        .await
        .map_err(|error| AppError::internal(format!("{context}: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support;

    #[tokio::test]
    async fn status_returns_unauthenticated_when_credentials_missing() {
        let temp_dir = temp_dir();
        let _guard = EnvVarGuard::set("DETENT_HOME", Some(temp_dir.to_str().expect("utf8")));

        let service = AuthService::new_with_client(Client::new(), "https://observer.detent.sh".into(), no_sleep)
            .expect("service should initialize");

        let status = service.status().await.expect("status should resolve");
        assert!(matches!(status, AuthStatus::Unauthenticated { .. }));
    }

    #[test]
    fn rejects_insecure_non_localhost_api_urls() {
        let error =
            AuthService::new_with_client(Client::new(), "http://observer.detent.sh".into(), no_sleep)
                .expect_err("http production urls should be rejected");

        assert_eq!(error.code().as_str(), "invalid_configuration");
    }

    #[test]
    fn allows_http_localhost_api_urls() {
        AuthService::new_with_client(Client::new(), "http://localhost:1355".into(), no_sleep)
            .expect("localhost should be allowed");
    }

    #[test]
    fn credentials_buffer_marks_soon_expiring_token_as_expired() {
        let credentials = StoredCredentials {
            access_token: "token".into(),
            refresh_token: None,
            expires_at: now_millis() + 60_000,
        };

        assert!(credentials.is_expired());
    }

    fn temp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dt-auth-service-{}-{}",
            std::process::id(),
            now_millis()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir should be created");
        dir
    }

    fn no_sleep(_duration: Duration) -> SleepFuture {
        Box::pin(async {})
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
