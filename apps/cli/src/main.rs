use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    match dt::run_with_args(std::env::args_os()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            dt::output::print_error(&error);
            ExitCode::from(error.exit_code())
        }
    }
}
