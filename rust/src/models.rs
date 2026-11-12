use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct LotId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SpaceId(pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SpaceState {
    Free,
    Occupied,
    Unknown,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ClosureReason {
    Maintenance,
    Construction,
    Event,
    Weather,
    Reserved,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpaceClosure {
    pub closure_id: String,
    pub lot_id: LotId,
    pub space_id: SpaceId,
    pub reason: ClosureReason,
    pub start_time: DateTime<Utc>,
    pub end_time: DateTime<Utc>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpaceStatus {
    pub space_id: SpaceId,
    pub state: SpaceState,
    pub confidence: f32,
    pub last_observed: Option<DateTime<Utc>>,
    pub closure: Option<SpaceClosure>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LotOccupancyReport {
    pub lot_id: LotId,
    pub total_spaces: usize,
    pub free_spaces: usize,
    pub occupied_spaces: usize,
    pub closed_spaces: usize,
    pub unknown_spaces: usize,
    pub timestamp: DateTime<Utc>,
    pub spaces: Vec<SpaceStatus>,
}
