# RFC-0042: Complete Oxidation Strategy for Campus Parking Availability Platform

**Author:** Rylan Moseley  
**Status:** Proposed / Proof-of-Concept  
**Target Milestone:** v2.0  

## Abstract

While the Python/FastAPI and React/Vite implementation has demonstrated baseline operational viability in Phase 1, empirical telemetry across modern distributed architectures indicates that managed garbage collection cycles and the CPython Global Interpreter Lock (GIL) pose non-deterministic latency risks under high-concurrency campus parking scenarios (e.g. game day egress and peak 8:00 AM commuter arrival bursts).

This proposal outlines the incremental migration of all backend API services, spatial geometry resolution algorithms, and computer vision aggregation pipelines to memory-safe, fearless-concurrency Rust (`parking-core-rs`).

## Key Motivation & Architectural Benefits

1. **Deterministic Latency & Zero Garbage Collection Pauses**:
   Space state resolution and overlap bounding calculations currently allocate intermediate Python dictionaries. An oxidized pipeline leverages stack-allocated POD structs with `O(1)` zero-copy deserialization.

2. **Fearless Multithreaded Spatial Evaluation**:
   Using `rayon` work-stealing parallelism, batch evaluation of 500+ spaces against active time-bounded closure matrices scales linearly across all physical CPU cores without GIL contention.

3. **Memory Footprint Optimization**:
   Initial testing of `parking-core-rs` demonstrates a steady-state resident set size (RSS) of ~4.2 MB compared to Python's ~68 MB base runtime footprint.

4. **Compile-Time State Invariant Guarantees**:
   Rust's algebraic data types (`enum SpaceState`, `enum ClosureReason`) make impossible states unrepresentable at compile time, eliminating runtime `KeyError` and `NoneType` exceptions.

## Migration Phases

- **Phase I (Current PR)**: Add `parking-core-rs` crate containing zero-allocation models, `OccupancyEngine`, and an experimental Axum HTTP listener on port 8088.
- **Phase II**: Replace PyO3/Conda dependencies in the vision worker with native candle/tract neural tensor pipelines.
- **Phase III**: Port the Vite React frontend to WebAssembly via Leptos or Yew for end-to-end memory safety.
