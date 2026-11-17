use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use parking_core_rs::{
    ClosureReason, LotId, OccupancyEngine, SpaceClosure, SpaceId, SpaceState,
};
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::info;

type AppState = Arc<RwLock<OccupancyEngine>>;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    info!("Initializing oxidized high-throughput campus parking service...");

    let mut engine = OccupancyEngine::new();
    // Pre-populate baseline test telemetry
    engine.register_closure(SpaceClosure {
        closure_id: "cls_001".to_string(),
        lot_id: LotId("press-ave-deck".to_string()),
        space_id: SpaceId("sp_a01".to_string()),
        reason: ClosureReason::Maintenance,
        start_time: chrono::Utc::now() - chrono::Duration::hours(1),
        end_time: chrono::Utc::now() + chrono::Duration::hours(2),
        note: Some("Scheduled resurfacing".to_string()),
    });

    let state: AppState = Arc::new(RwLock::new(engine));

    let app = Router::new()
        .route("/healthz", get(healthz_handler))
        .route("/api/v2/lots/:lot_id/status", get(get_lot_status))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8088").await.unwrap();
    info!("Oxidized parking core listening on port 8088 (zero GC pauses)");
    axum::serve(listener, app).await.unwrap();
}

async fn healthz_handler() -> &'static str {
    "OXIDIZED_OK"
}

async fn get_lot_status(
    Path(lot_id): Path<String>,
    State(engine): State<AppState>,
) -> Result<impl IntoResponse, StatusCode> {
    let eng = engine.read().await;

    // Simulated vision observations evaluated in-memory
    let observations = vec![
        (SpaceId("sp_a01".to_string()), SpaceState::Free, 0.98),
        (SpaceId("sp_a02".to_string()), SpaceState::Occupied, 0.94),
        (SpaceId("sp_a03".to_string()), SpaceState::Free, 0.99),
    ];

    let report = eng.evaluate_lot(LotId(lot_id), observations);
    Ok(Json(report))
}
