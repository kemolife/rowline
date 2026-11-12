// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mut argv = std::env::args();
    let argv0 = argv.next().unwrap_or_default();
    let args: Vec<String> = argv.collect();
    // `rowline query …` in a shell: the command line, no window
    if rowline_lib::cli::is_cli(&argv0, &args) {
        std::process::exit(rowline_lib::cli::main(args));
    }
    rowline_lib::run()
}
