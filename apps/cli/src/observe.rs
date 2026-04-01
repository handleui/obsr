use std::collections::BTreeMap;
use std::time::Duration;

use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use tokio::time::sleep;

use crate::cli::ObserveCommand;
use crate::config;
use crate::credentials::load_credentials;
use crate::error::{AppError, ErrorCode};

const HTTP_TIMEOUT_SECONDS: u64 = 20;
const DEFAULT_POLL_INTERVAL_MS: u64 = 5000;
const MIN_POLL_INTERVAL_MS: u64 = 500;
const USER_AGENT: &str = concat!("dt/", env!("CARGO_PKG_VERSION"));

enum ObserveScope {
    Commit { repository: String, commit: String },
    PullRequest { project_id: String, pr_number: u64 },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ErrorsResponse {
    commit: Option<String>,
    repository: String,
    runs: Vec<RunInfo>,
    errors: Vec<Diagnostic>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunInfo {
    id: String,
    run_id: Option<String>,
    workflow_name: Option<String>,
    conclusion: Option<String>,
    run_attempt: Option<i32>,
    error_count: Option<i32>,
    head_branch: Option<String>,
    completed_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Diagnostic {
    id: String,
    file_path: Option<String>,
    line: Option<i64>,
    column: Option<i64>,
    message: String,
    category: Option<String>,
    severity: Option<String>,
    source: Option<String>,
    rule_id: Option<String>,
    hints: Option<Vec<String>>,
    stack_trace: Option<String>,
    code_snippet: Option<serde_json::Value>,
    fixable: bool,
    related_files: Option<Vec<String>>,
    workflow_job: Option<String>,
    workflow_context: Option<serde_json::Value>,
    log_line_start: Option<i64>,
    log_line_end: Option<i64>,
    created_at: String,
}

#[derive(Debug, Deserialize)]
struct ApiErrorResponse {
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ObserveSnapshotOutput<'a> {
    event: &'a str,
    mode: &'a str,
    scope: ObserveScopeOutput<'a>,
    commit: Option<&'a str>,
    repository: &'a str,
    runs: &'a [RunInfo],
    diagnostics: &'a [Diagnostic],
    agent_context: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ObserveScopeOutput<'a> {
    kind: &'a str,
    repository: Option<&'a str>,
    commit: Option<&'a str>,
    project_id: Option<&'a str>,
    pr_number: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NdjsonEvent<'a, T> {
    event: &'a str,
    timestamp: Option<&'a str>,
    data: T,
}

pub async fn execute_observe(args: ObserveCommand) -> Result<(), AppError> {
    if args.json && args.ndjson {
        return Err(AppError::new(
            ErrorCode::InvalidArguments,
            "choose only one output mode: --json or --ndjson",
            2,
        ));
    }

    let scope = resolve_scope(&args)?;
    let interval_ms = args
        .poll_interval
        .unwrap_or(DEFAULT_POLL_INTERVAL_MS)
        .max(MIN_POLL_INTERVAL_MS);

    let credentials = load_credentials()?.ok_or_else(|| {
        AppError::new(
            ErrorCode::Auth,
            "not logged in; run `dt auth login`",
            1,
        )
    })?;

    if credentials.is_expired() {
        return Err(AppError::new(
            ErrorCode::Auth,
            "session expired; run `dt auth login --force`",
            1,
        ));
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECONDS))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|error| AppError::internal(format!("failed to initialize http client: {error}")))?;

    if args.watch || args.follow {
        return watch_observe(
            &client,
            &scope,
            &credentials.access_token,
            interval_ms,
            &args,
        )
        .await;
    }

    let response = fetch_errors(&client, &scope, &credentials.access_token).await?;
    let diagnostics = apply_filters(response.errors, &args);
    let diagnostics = apply_limit(diagnostics, args.limit);
    let agent_context = build_agent_context(&response.repository, response.commit.as_deref(), &diagnostics);

    if args.ndjson {
        print_ndjson_snapshot(&diagnostics)?;
        return Ok(());
    }

    if args.json {
        let payload = ObserveSnapshotOutput {
            event: "snapshot",
            mode: "observe",
            scope: scope_to_output(&scope),
            commit: response.commit.as_deref(),
            repository: &response.repository,
            runs: &response.runs,
            diagnostics: &diagnostics,
            agent_context,
        };
        println!(
            "{}",
            serde_json::to_string(&payload).expect("observe snapshot should serialize")
        );
        return Ok(());
    }

    print_human_snapshot(&response.repository, response.commit.as_deref(), &diagnostics);
    Ok(())
}

async fn watch_observe(
    client: &Client,
    scope: &ObserveScope,
    access_token: &str,
    interval_ms: u64,
    args: &ObserveCommand,
) -> Result<(), AppError> {
    let mut seen = BTreeMap::<String, String>::new();
    let mut first = true;

    loop {
        let response = fetch_errors(client, scope, access_token).await?;
        let diagnostics = apply_limit(apply_filters(response.errors, args), args.limit);

        let mut changed = Vec::new();
        for diagnostic in diagnostics {
            let key = diagnostic_key(&diagnostic);
            let previous = seen.get(&diagnostic.id);
            if previous != Some(&key) {
                seen.insert(diagnostic.id.clone(), key);
                changed.push(diagnostic);
            }
        }

        if args.ndjson {
            if first {
                println!(
                    "{}",
                    serde_json::to_string(&NdjsonEvent {
                        event: "snapshot.start",
                        timestamp: None,
                        data: serde_json::json!({}),
                    })
                    .expect("ndjson snapshot.start should serialize")
                );
                for diagnostic in &changed {
                    println!(
                        "{}",
                        serde_json::to_string(&NdjsonEvent {
                            event: "diagnostic.upsert",
                            timestamp: Some(diagnostic.created_at.as_str()),
                            data: diagnostic,
                        })
                        .expect("ndjson diagnostic.upsert should serialize")
                    );
                }
                println!(
                    "{}",
                    serde_json::to_string(&NdjsonEvent {
                        event: "snapshot.end",
                        timestamp: None,
                        data: serde_json::json!({
                            "count": changed.len(),
                        }),
                    })
                    .expect("ndjson snapshot.end should serialize")
                );
            } else {
                for diagnostic in &changed {
                    println!(
                        "{}",
                        serde_json::to_string(&NdjsonEvent {
                            event: "diagnostic.upsert",
                            timestamp: Some(diagnostic.created_at.as_str()),
                            data: diagnostic,
                        })
                        .expect("ndjson diagnostic.upsert should serialize")
                    );
                }
            }
        } else if first {
            print_human_snapshot(&response.repository, response.commit.as_deref(), &changed);
        } else if !changed.is_empty() {
            for diagnostic in &changed {
                print_human_diagnostic(diagnostic);
            }
        }

        if args.exit_on_first_entry && !seen.is_empty() {
            return Ok(());
        }

        if args.exit_on_idle && !first && changed.is_empty() {
            return Ok(());
        }

        first = false;
        sleep(Duration::from_millis(interval_ms)).await;
    }
}

fn resolve_scope(args: &ObserveCommand) -> Result<ObserveScope, AppError> {
    if let (Some(repository), Some(commit)) = (args.repo_full.clone(), args.commit.clone()) {
        return Ok(ObserveScope::Commit { repository, commit });
    }

    if let (Some(project_id), Some(pr_number)) = (args.project.clone(), args.pr) {
        return Ok(ObserveScope::PullRequest {
            project_id,
            pr_number,
        });
    }

    Err(AppError::new(
        ErrorCode::InvalidArguments,
        "observe requires either (--repo-full + --commit) or (--project + --pr)",
        2,
    ))
}

fn scope_to_output(scope: &ObserveScope) -> ObserveScopeOutput<'_> {
    match scope {
        ObserveScope::Commit { repository, commit } => ObserveScopeOutput {
            kind: "commit",
            repository: Some(repository),
            commit: Some(commit),
            project_id: None,
            pr_number: None,
        },
        ObserveScope::PullRequest {
            project_id,
            pr_number,
        } => ObserveScopeOutput {
            kind: "pr",
            repository: None,
            commit: None,
            project_id: Some(project_id),
            pr_number: Some(*pr_number),
        },
    }
}

fn diagnostic_key(diagnostic: &Diagnostic) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}:{}",
        diagnostic.message,
        diagnostic.file_path.clone().unwrap_or_default(),
        diagnostic.line.unwrap_or_default(),
        diagnostic.column.unwrap_or_default(),
        diagnostic.rule_id.clone().unwrap_or_default(),
        diagnostic.severity.clone().unwrap_or_default(),
        diagnostic.source.clone().unwrap_or_default()
    )
}

async fn fetch_errors(
    client: &Client,
    scope: &ObserveScope,
    access_token: &str,
) -> Result<ErrorsResponse, AppError> {
    let base = config::api_url();
    let path = match scope {
        ObserveScope::Commit { repository, commit } => format!(
            "/v1/errors?commit={}&repository={}",
            urlencoding::encode(commit),
            urlencoding::encode(repository)
        ),
        ObserveScope::PullRequest {
            project_id,
            pr_number,
        } => format!(
            "/v1/errors/pr?projectId={}&prNumber={}",
            urlencoding::encode(project_id),
            pr_number
        ),
    };

    let response = client
        .get(format!("{base}{path}"))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| {
            AppError::new(
                ErrorCode::Network,
                format!("failed to reach Observer API: {error}"),
                1,
            )
        })?;

    if response.status() == StatusCode::UNAUTHORIZED {
        return Err(AppError::new(
            ErrorCode::Auth,
            "authentication failed; run `dt auth login --force`",
            1,
        ));
    }

    if !response.status().is_success() {
        let status = response.status();
        let api_error = response
            .json::<ApiErrorResponse>()
            .await
            .ok()
            .and_then(|payload| payload.error)
            .unwrap_or_else(|| format!("request failed with status {status}"));

        return Err(AppError::new(ErrorCode::Network, api_error, 1));
    }

    response
        .json::<ErrorsResponse>()
        .await
        .map_err(|error| AppError::internal(format!("failed to parse errors payload: {error}")))
}

fn apply_limit(mut diagnostics: Vec<Diagnostic>, limit: Option<u32>) -> Vec<Diagnostic> {
    let take = limit.unwrap_or(u32::MAX) as usize;
    if diagnostics.len() > take {
        diagnostics.truncate(take);
    }
    diagnostics
}

fn apply_filters(errors: Vec<Diagnostic>, args: &ObserveCommand) -> Vec<Diagnostic> {
    errors
        .into_iter()
        .filter(|error| match args.severity {
            crate::cli::ObserveSeverity::All => true,
            crate::cli::ObserveSeverity::Error => error.severity.as_deref() == Some("error"),
            crate::cli::ObserveSeverity::Warning => error.severity.as_deref() == Some("warning"),
        })
        .collect()
}

fn print_human_snapshot(repository: &str, commit: Option<&str>, diagnostics: &[Diagnostic]) {
    println!("Repository: {repository}");
    if let Some(commit) = commit {
        println!("Commit: {commit}");
    }
    println!("Diagnostics: {}", diagnostics.len());
    println!();

    if diagnostics.is_empty() {
        println!("No diagnostics found.");
        return;
    }

    for diagnostic in diagnostics {
        print_human_diagnostic(diagnostic);
    }
}

fn print_human_diagnostic(diagnostic: &Diagnostic) {
    let source = diagnostic.source.as_deref().unwrap_or("unknown");
    let severity = diagnostic.severity.as_deref().unwrap_or("error");
    let location = match (&diagnostic.file_path, diagnostic.line, diagnostic.column) {
        (Some(path), Some(line), Some(column)) => format!("{path}:{line}:{column}"),
        (Some(path), Some(line), None) => format!("{path}:{line}"),
        (Some(path), None, None) => path.to_string(),
        _ => "unknown".to_string(),
    };
    let rule = diagnostic
        .rule_id
        .as_deref()
        .map(|rule| format!(" {rule}"))
        .unwrap_or_default();
    println!("[{source}:{severity}] {location}{rule}");
    println!("{}", diagnostic.message);
    println!("fixable: {}", if diagnostic.fixable { "yes" } else { "no" });
    println!();
}

fn print_ndjson_snapshot(diagnostics: &[Diagnostic]) -> Result<(), AppError> {
    println!(
        "{}",
        serde_json::to_string(&NdjsonEvent {
            event: "snapshot.start",
            timestamp: None,
            data: serde_json::json!({}),
        })
        .map_err(|error| AppError::internal(format!("failed to serialize snapshot.start: {error}")))?
    );

    for diagnostic in diagnostics {
        println!(
            "{}",
            serde_json::to_string(&NdjsonEvent {
                event: "diagnostic.upsert",
                timestamp: Some(diagnostic.created_at.as_str()),
                data: diagnostic,
            })
            .map_err(|error| AppError::internal(format!("failed to serialize diagnostic.upsert: {error}")))?
        );
    }

    println!(
        "{}",
        serde_json::to_string(&NdjsonEvent {
            event: "snapshot.end",
            timestamp: None,
            data: serde_json::json!({ "count": diagnostics.len() }),
        })
        .map_err(|error| AppError::internal(format!("failed to serialize snapshot.end: {error}")))?
    );

    Ok(())
}

fn build_agent_context(repository: &str, commit: Option<&str>, diagnostics: &[Diagnostic]) -> String {
    let mut lines = vec![
        format!("Repository: {repository}"),
        format!("Commit: {}", commit.unwrap_or("unknown")),
        format!("Diagnostics: {}", diagnostics.len()),
        String::new(),
        "Errors:".to_string(),
    ];

    if diagnostics.is_empty() {
        lines.push("- No diagnostics found.".to_string());
        return lines.join("\n");
    }

    for diagnostic in diagnostics {
        let location = match (&diagnostic.file_path, diagnostic.line, diagnostic.column) {
            (Some(path), Some(line), Some(column)) => format!("{path}:{line}:{column}"),
            (Some(path), Some(line), None) => format!("{path}:{line}"),
            (Some(path), None, None) => path.to_string(),
            _ => "unknown".to_string(),
        };
        let source = diagnostic.source.as_deref().unwrap_or("unknown");
        let severity = diagnostic.severity.as_deref().unwrap_or("error");
        lines.push(format!(
            "- [{source}/{severity}] {location} -> {}",
            diagnostic.message
        ));
    }

    lines.join("\n")
}
