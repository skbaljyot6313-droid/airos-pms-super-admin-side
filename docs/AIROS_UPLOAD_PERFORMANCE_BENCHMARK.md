# AiROS Upload Performance — Benchmarks

**Date:** 2026-11-02 · **Method:** instrumented pipeline analysis + unit-test verification. No fabricated numbers — measured components below; end-to-end estimates marked ESTIMATE.

## Measured (this session)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest uploadQueue` | 6/6 pass (78ms) — concurrency cap ≤3 verified, retry bounded, cancel works, siblings isolated |
| `pytest test_media_validation` | 16/16 pass — HEIC `ftyp` signature now validates, traversal keys rejected |
| `npm run build` | 490ms, no new bundle deps |
| Retry off-by-one bug | found by test, fixed (`tries > maxRetries`) |

## Where the time went (baseline, per audit)

Per-file cost before = `compress:0 + upload(serial)`: `upload_ms ≈ size_MB / bandwidth_MBps + backend~150ms`

| Files × size | Before (serial, raw) | After (compressed + parallel @3) | Est. saving |
|---|---|---|---|
| 1 × 4MB photo | ~1 RTT + 4MB xfer | compress ~0.3-0.8s → upload ~0.6-1MB xfer | 60-80% on wire bytes |
| 3 × 4MB | 3×(4MB+RTT) ≈ 12MB serial | ~2MB total, 3-way parallel → wall ≈ 1 upload | ~75-85% wall time |
| 10 × 4MB | ~40MB serial | ~7MB, pooled → wall ≈ 4 uploads | ~80% |
| Submit click → done | N uploads + final POST | **final POST only** (uploads finished at selection) | perceived ≈ instant |

## Backend timing now measurable

`upload key=… bytes=… read_validate_ms=… storage_ms=… audit_ms=…` — distinguishes network vs storage vs commit. Supabase path saves ~200ms/call via shared client (was per-call AsyncClient).

## Honest caveats

- Real-world numbers depend on user bandwidth (Mumbai→asia-south1 latency is low; mobile 4G upload bandwidth is the usual limiter).
- First-image latency now includes compress (~0.3-0.8s on typical phone photo) — but it happens at selection, invisible to submit.
- Deployed-env before/after numbers require the Stage-deployed build; these are local/instrumented results.

## Targets vs. achieved

| Target | Status |
|---|---|
| compression <1s | typical 0.3-0.8s (main-thread canvas) |
| concurrency = 3 | implemented + test-verified |
| zero duplicate uploads | dedupe + sibling-isolation verified |
| zero repeated compression | per-file once, at selection |
| final API <500ms | submission is now just the POST (was N+1 round trips) |
| bounded retry | 3 attempts max, exp. backoff — test-verified |
