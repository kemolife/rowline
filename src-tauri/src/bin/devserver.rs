//! Development bridge: the same backend commands over HTTP, so the UI can be tested in a browser.
//! Listens on 127.0.0.1 only. Uses its own config folder and a file-based password store,
//! never the app's data.

use axum::{Json, Router, extract::State, http::StatusCode, routing::post};
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;
use rowline_lib::commands::{AppState, dispatch};
use rowline_lib::store::{SecretStore, Store};
use tower_http::cors::{Any, CorsLayer};

#[derive(Deserialize)]
struct CallBody {
    command: String,
    args: Option<Value>,
}

async fn call(State(state): State<Arc<AppState>>, Json(body): Json<CallBody>) -> (StatusCode, Json<Value>) {
    match dispatch(&state, &body.command, body.args.unwrap_or(Value::Null)).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::to_value(&e).unwrap_or_default())),
    }
}

#[tokio::main]
async fn main() {
    let dir = std::env::var("ROWLINE_CONFIG_DIR").map(std::path::PathBuf::from).unwrap_or_else(|_| {
        let data = dirs::data_dir().expect("data dir");
        rowline_lib::move_old_folder(&data.join("tabula-dev"), &data.join("rowline-dev"));
        data.join("rowline-dev")
    });
    let store = Store::new(dir.clone(), SecretStore::file(dir.join("dev-secrets.json"))).expect("store");
    let state = Arc::new(AppState::new(store));
    let mcp = rowline_lib::claude::mcp::start(state.clone()).await.expect("mcp server");
    println!("Claude tools (MCP) on 127.0.0.1:{}", mcp.port);
    // its own socket, so it never takes the app's place: ROWLINE_SOCKET=<this path> rowline …
    let socket = std::env::var_os("ROWLINE_SOCKET").map(std::path::PathBuf::from).unwrap_or_else(|| dir.join("rowline.sock"));
    match rowline_lib::cli::server::start(state.clone(), socket.clone()).await {
        Ok(()) => println!("rowline command socket: {}", socket.display()),
        Err(e) => println!("rowline command unavailable: {e}"),
    }
    let app = Router::new()
        .route("/api/call", post(call))
        .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any))
        .with_state(state);
    let port: u16 = std::env::var("ROWLINE_DEVSERVER_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(1421);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.expect("bind");
    println!("Rowline dev bridge on http://127.0.0.1:{port} (config: {})", dir.display());
    axum::serve(listener, app).await.expect("serve");
}
