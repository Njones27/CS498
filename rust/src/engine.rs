use crate::models::{ClosureReason, LotId, LotOccupancyReport, SpaceClosure, SpaceId, SpaceState, SpaceStatus};
use chrono::Utc;
use rayon::prelude::*;
use std::collections::HashMap;

/// High-performance spatial occupancy evaluator with fearless parallelism.
pub struct OccupancyEngine {
    active_closures: HashMap<(LotId, SpaceId), SpaceClosure>,
}

impl OccupancyEngine {
    pub fn new() -> Self {
        Self {
            active_closures: HashMap::new(),
        }
    }

    pub fn register_closure(&mut self, closure: SpaceClosure) {
        let key = (closure.lot_id.clone(), closure.space_id.clone());
        self.active_closures.insert(key, closure);
    }

    /// Evaluates raw vision detections against registered geometry and overrides.
    /// Utilizes Rayon work-stealing parallelism for zero-copy batch resolution.
    pub fn evaluate_lot(
        &self,
        lot_id: LotId,
        raw_observations: Vec<(SpaceId, SpaceState, f32)>,
    ) -> LotOccupancyReport {
        let now = Utc::now();

        let evaluated_spaces: Vec<SpaceStatus> = raw_observations
            .into_par_iter()
            .map(|(space_id, inferred_state, confidence)| {
                let key = (lot_id.clone(), space_id.clone());
                if let Some(closure) = self.active_closures.get(&key) {
                    if closure.start_time <= now && now <= closure.end_time {
                        return SpaceStatus {
                            space_id,
                            state: SpaceState::Closed,
                            confidence: 1.0,
                            last_observed: Some(now),
                            closure: Some(closure.clone()),
                        };
                    }
                }

                SpaceStatus {
                    space_id,
                    state: inferred_state,
                    confidence,
                    last_observed: Some(now),
                    closure: None,
                }
            })
            .collect();

        let mut free_spaces = 0;
        let mut occupied_spaces = 0;
        let mut closed_spaces = 0;
        let mut unknown_spaces = 0;

        for s in &evaluated_spaces {
            match s.state {
                SpaceState::Free => free_spaces += 1,
                SpaceState::Occupied => occupied_spaces += 1,
                SpaceState::Closed => closed_spaces += 1,
                SpaceState::Unknown => unknown_spaces += 1,
            }
        }

        LotOccupancyReport {
            total_spaces: evaluated_spaces.len(),
            free_spaces,
            occupied_spaces,
            closed_spaces,
            unknown_spaces,
            lot_id,
            timestamp: now,
            spaces: evaluated_spaces,
        }
    }
}

impl Default for OccupancyEngine {
    fn default() -> Self {
        Self::new()
    }
}
