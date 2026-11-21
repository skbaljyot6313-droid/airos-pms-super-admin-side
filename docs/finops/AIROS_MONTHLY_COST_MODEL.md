# AiROS PMS — detailed cloud operating cost model

**Scope:** Super Admin web platform **and** shared Employee Backend/mobile workload.

**Estimate date:** 3 November 2026. **Target:** Google Cloud Mumbai, `asia-south1`. **Currency:** INR.

**Status:** Provisional, formula-based planning model. Not a Google quote, observed production bill, capacity certification or approval to change infrastructure.

## Contents

1. Executive decision tables
2. Scope, confidence and corrections to earlier estimates
3. Fixed versus variable costs
4. Workload model and service ownership
5. Pricing inputs and formulas
6. Architecture and capacity assumptions
7. Detailed lean deployment costs
8. Higher-availability deployment costs
9. GPS savings and retention sensitivities
10. Growth forecasts and marginal costs
11. Budget ranges, risks and exclusions
12. Optimisation priorities and validation checklist
13. Sources and reproducibility

## 1. Executive decision tables

All tables are **combined Super Admin + Employee costs**, with shared infrastructure counted once. Monthly values are rounded to the nearest rupee. Per-user amounts use registered operational mobile users, not concurrent requests. Taxes are excluded.

### 1.1 Model A: lean managed deployment, GPS enabled

| Registered mobile users | Fixed / minimum-capacity cost | Variable / usage-budget cost | Total monthly cost | Cost per mobile user/month |
|---|---:|---:|---:|---:|
| 100 | ₹21,140 | ₹1,249 | **₹22,388** | **₹223.88** |
| 1,000 | ₹26,692 | ₹5,853 | **₹32,546** | **₹32.55** |
| 10,000 | ₹54,250 | ₹47,337 | **₹1,01,587** | **₹10.16** |

### 1.2 Model A: lean managed deployment, GPS disabled

| Registered mobile users | Fixed / minimum-capacity cost | Variable / usage-budget cost | Total monthly cost | Cost per mobile user/month |
|---|---:|---:|---:|---:|
| 100 | ₹21,140 | ₹970 | **₹22,110** | **₹221.10** |
| 1,000 | ₹26,692 | ₹3,065 | **₹29,757** | **₹29.76** |
| 10,000 | ₹39,358 | ₹19,449 | **₹58,807** | **₹5.88** |

### 1.3 Model B: higher availability, GPS enabled

| Registered mobile users | Fixed / minimum-capacity cost | Variable / usage-budget cost | Total monthly cost | Cost per mobile user/month |
|---|---:|---:|---:|---:|
| 100 | ₹47,752 | ₹1,557 | **₹49,309** | **₹493.09** |
| 1,000 | ₹48,793 | ₹7,102 | **₹55,895** | **₹55.90** |
| 10,000 | ₹1,50,991 | ₹56,155 | **₹2,07,146** | **₹20.71** |

### 1.4 Model B: higher availability, GPS disabled

| Registered mobile users | Fixed / minimum-capacity cost | Variable / usage-budget cost | Total monthly cost | Cost per mobile user/month |
|---|---:|---:|---:|---:|
| 100 | ₹47,752 | ₹1,222 | **₹48,974** | **₹489.74** |
| 1,000 | ₹48,793 | ₹3,747 | **₹52,540** | **₹52.54** |
| 10,000 | ₹1,29,274 | ₹22,605 | **₹1,51,878** | **₹15.19** |

Totals are calculated from unrounded components; rounded columns can differ by ₹1. These are mathematical outputs of assumptions, not evidence that invoices are predictable to a rupee.

### 1.5 Recommended expected-case budget including a 25% contingency

This contingency covers moderate pricing/utilisation uncertainty, not every possible workload spike.

| Users | Lean with GPS | Lean without GPS | Higher availability with GPS | Higher availability without GPS |
|---|---:|---:|---:|---:|
| 100 | ₹28,000/month | ₹28,000/month | ₹62,000/month | ₹62,000/month |
| 1,000 | ₹41,000/month | ₹38,000/month | ₹70,000/month | ₹66,000/month |
| 10,000 | ₹1,27,000/month | ₹74,000/month | ₹2,59,000/month | ₹1,90,000/month |

Budget = expected total × 1.25, rounded **up** to the next ₹1,000. Budget alerts do not enforce a hard spending cap.

## 2. Scope, confidence and corrections

### 2.1 What this model includes

- Super Admin static website and API processing.
- Employee Backend API processing supporting mobile users.
- Shared PostgreSQL/Cloud SQL compute, disk and backup usage.
- Shared managed Redis, including assumed GPS retention when enabled.
- Background scheduling capacity and a separately costed realtime service.
- Task/maintenance evidence images, operations and downloads.
- Logging, monitoring allowance, Secret Manager, container registry and builds.
- FCM delivery at its published no-charge rate; sending/queue processing remains backend work.

The Employee application's source and live telemetry were not independently audited in this repository. Its workload is modelled, not claimed measured. Mobile binary hosting/distribution, employee web hosting if separate, and paid app-store accounts are not quantified here.

### 2.2 What is verified versus assumed

| Evidence level | Meaning | Examples |
|---|---|---|
| Source inspected | Architecture exists in this checkout | FastAPI, SQLAlchemy pool, nine-session workspace bootstrap, public media adapter, optional Centrifugo, embedded scheduler |
| Official price consulted | Published rate/product billing rule checked | Cloud Run Tier 1 reference rates, Secret Manager, FCM, Hosting, Logging, Artifact Registry |
| Secondary regional price | Mumbai number found outside official calculator | Cloud SQL machine prices and Redis capacity prices |
| Provisional regional input | Regional/account SKU not confirmed | SQL disk/backups, GCS storage/operations and destination-weighted egress |
| Workload assumption | Must be replaced by actual usage | DAU, GPS interval, Redis bytes/point, request billing time, images, retention |
| Budget allowance | Not an itemised exact SKU bill | Monitoring/custom metrics and HA API headroom |

No billing API, cloud account, production database or existing development database was accessed. No production changes were made. Isolated Docker verification was blocked at the last audit checkpoint; this document contains no fabricated load-test results.

### 2.3 Revision from earlier conversational estimates

Earlier exploratory totals were approximately ₹19,298 / ₹30,571 / ₹89,468 with GPS and broad lower ranges without GPS. **This detailed model supersedes those point estimates.** Differences are explained by:

1. Explicitly funding **two** continuously billed background/realtime equivalents in Model A instead of an inconsistent combined compute allowance.
2. Deriving API cost from request volume and effective billed instance time, rather than selecting a lump-sum allowance.
3. Separating used backup storage from provisioned disk and counting object operations.
4. Keeping image storage/downloads when GPS is removed.
5. Conservatively showing gross usage before free-tier credits and retaining database sizes when GPS is removed.

No infrastructure became more expensive as a result of editing this document. These are improved accounting assumptions, not measured bill increases or guaranteed final requirements.

### 2.4 Financial conventions

- USD→INR conversion: **₹85/USD**, a planning constant, **not live FX** or Google's contractual INR SKU price.
- Capacity month: **730 hours**, or 2,628,000 seconds.
- Operations: **26 working days/month**; annual cost = monthly × 12.
- Taxes/GST excluded. If 18% GST applies, cash invoice = pre-tax × 1.18; input-tax-credit treatment requires accounting advice.
- No introductory credits, negotiated discounts or commitments assumed.
- Compute/storage/operations generally use gross list-price calculations without free allocations. Potential credits are shown separately, not claimed repeatedly per service.
- KiB/MiB/GiB use binary units. Firebase Hosting's published GB units are approximated by the workload GiB estimate; confirm units when preparing a binding quote.
- Figures represent a mature **12-month retained image stock**, not a clean first-month account.

## 3. Fixed versus variable costs

### Fixed / minimum-capacity category

Provisioned SQL compute, provisioned SQL disk, provisioned Redis, continuously running background/realtime capacity, and an HA warm-instance reserve. These are charged even if traffic is low while those resources remain provisioned. Capacity increases at defined model tiers; fixed does not mean fixed forever.

### Variable / usage-budget category

API processing, used backups, retained media, storage operations, egress, logs, monitoring allowance, secret access/versions, artifact stock, builds and Hosting. Some have minimum/slow-changing usage, but are not provisioned compute floors. Monitoring is an allowance, not proof that all provider metrics cost money.

**Correction to the earlier simplified split:** used backup storage belongs in usage costs, not a permanently fixed infrastructure fee. Secret versions and artifacts are also usage/stock charges, even if they remain stable month-to-month.

Storage is a stock; uploads/downloads/requests are flows. A fixed user count can still produce a rising bill while retained images and history accumulate.

## 4. Workload model

### 4.1 Expected inputs

| Parameter | Expected assumption | Why it matters |
|---|---|---|
| Registered users N | 100 / 1,000 / 10,000; forecasts at 25,000 / 50,000 | Billing denominator, not concurrency |
| MAU | 0.90 × N | Engagement denominator |
| DAU | 0.70 × N | Main daily traffic driver |
| Active days/month | 26 | Monthly operations multiplier |
| Tracking hours/active day | 8 | Only on-duty GPS traffic assumed |
| GPS interval | 60 seconds | 480 fixes/DAU/day |
| Ordinary requests | 60/DAU/day | Authentication, tasks, attendance, media metadata and management overhead |
| Mobile portion of ordinary requests | 45/DAU/day | Assumed cost-attribution split only |
| Management-equivalent portion | 15/DAU/day | Shared admin traffic, not 15 requests per actual manager |
| Actual web-admin users | max(5, ceil(N/100)) | Hosting workload assumption |
| Web sessions | 2/admin/day | Static frontend transfer |
| Static payload per session | 1 MiB | Cached asset budget; not measured total page weight |
| Login | 1/DAU/day within ordinary requests | Password verification burst |
| Attendance operations | 6/DAU/day within ordinary requests | Clock/break/status operations |
| Task completions | 2/DAU/day within ordinary requests | Reviews, evidence, operational state writes |
| Images | 4/DAU/day at 0.35 MiB/image | Four photos can accompany two task completions |
| Image downloads | 2 per uploaded image | Staff review/revisit assumption |
| Image retention | 12 months | Steady-state media stock |
| Push notifications | 4/DAU/day | FCM processing, no FCM delivery fee |
| GPS Redis retention | 1 operational day's points within 24 hours | Not current retention evidence or permission to delete history |
| Point memory | 300 logical bytes × 3 overhead = 900 bytes | Includes rough index/allocator headroom, not measured object size |
| Ordinary API response | 2 KiB/request | Excludes binary image body counted separately |
| Log bytes | 1 KiB/request + 5 GiB/month platform/background baseline | Avoid logging payloads/coordinates/secrets |
| Effective API billed time | 0.10 instance-seconds/request, 1 vCPU/1 GiB equivalent | Most important unmeasured compute coefficient |
| Peak factor | 4 × active-window average RPS | A planning burst factor, not load-test evidence |

### 4.2 Request arithmetic

```text
Active_user_days = N × 0.70 × 26 = 18.2 × N
GPS_fixes_per_active_day = 8 × 3,600 / 60 = 480
Ordinary_requests = 18.2 × N × 60 = 1,092 × N
GPS_requests = 18.2 × N × 480 = 8,736 × N
Total_requests_with_GPS = 9,828 × N
Total_requests_without_GPS = 1,092 × N
```

Removing GPS reduces requests by **88.89% under these assumptions**, not total cost by 88.89%. No background GPS, 24-hour tracking, batch compression or offline catch-up burst has been assumed.

| Metric | 100 | 1,000 | 10,000 |
|---|---:|---:|---:|
| DAU | 70 | 700 | 7,000 |
| MAU | 90 | 900 | 9,000 |
| Requests/month with GPS | 982,800 | 9,828,000 | 98,280,000 |
| Requests/month without GPS | 109,200 | 1,092,000 | 10,920,000 |
| GPS fixes/day | 33,600 | 336,000 | 3,360,000 |
| Average active-window RPS, GPS | 1.31 | 13.13 | 131.25 |
| Peak model RPS, GPS | 5.25 | 52.5 | 525 |
| Peak model RPS, no GPS | 0.58 | 5.83 | 58.33 |
| Uploads/month | 7,280 | 72,800 | 728,000 |
| Push deliveries/month | 7,280 | 72,800 | 728,000 |
| New image bytes/month, GiB | 2.49 | 24.88 | 248.83 |
| Retained images after 12 full months, GiB | 29.86 | 298.59 | 2,985.94 |
| GPS point memory for one day's volume, GiB | 0.028 | 0.282 | 2.816 |

Average active-window RPS = monthly requests / (26 × 8 × 3,600). Peak simultaneous active employees could be high even if requests in flight are low. Neither should be equated to HTTP concurrency. Average requests in flight follow arrival rate × measured latency; e.g. 525 RPS at 0.2 seconds implies about 105 in-flight requests under that simplified condition, not 10,000 simultaneous requests.

### 4.3 Database and Redis operations

The shared employee implementation has not been measured. For capacity investigation only, a placeholder of 150 SQL reads and 52.5 writes per DAU/day yields 2,730 × N reads and 955.5 × N writes/month. These are not per-query Google fees; Cloud SQL billing is provisioned compute/storage. Query complexity, index maintenance, lock waits and amplification determine required capacity.

GPS is assumed to use Redis points/index structures, not one SQL row per fix. Four Redis commands/fix plus two/ordinary request would imply 37,128 × N commands/month with GPS, versus 2,184 × N without GPS. These command counts are placeholders, not verified EB implementation. Redis command count affects throughput and CPU, while this service's bill uses provisioned capacity.

### 4.4 Admin polling sensitivity

The 60-request allowance is not an exhaustive endpoint trace. A single continuously open dashboard polling every 10 seconds for eight hours produces 2,880 polls/day. If 100 administrators do that for 26 days, the result is 7,488,000 additional polls/month. Each may trigger several DB queries or an Employee Backend proxy call. Do not add this example on top of the baseline without checking whether already included management traffic covers it. Browser visibility, polling deduplication and realtime delivery must be measured.

## 5. Pricing inputs and formulas

### 5.1 Price registry

Reference IDs map to sources in section 13. **P** = primary/reference price; **S** = secondary Mumbai price; **A** = provisional input/allowance.

| Input | USD value used | Confidence/source |
|---|---:|---|
| SQL single-zone per vCPU with 3.75 GiB RAM | 0.0811/hour | S: S5; linear planning equivalent, not standalone CPU-only price |
| SQL HA compute multiplier | 2 × single-zone | A/P: S2 illustrates doubled HA rates; confirm Mumbai SKU |
| Redis Standard 1 GiB total | 0.110/hour | S: S6/S7; replica specification confirmation pending |
| Redis Standard 5 GiB total | 0.350/hour | S: S6 |
| Redis Standard 10 GiB total | 0.700/hour | S: S6 |
| Redis Standard 11 GiB total | 0.638/hour | S: S6 |
| Redis Standard 35 GiB total | 2.030/hour | S: S6 |
| SQL SSD | 0.204/GiB-month | A; Cloud SQL regional SKU not independently confirmed |
| SQL HA disk multiplier | 2 × single-zone | A; confirm storage architecture/SKU |
| Used backups | 0.096/GiB-month | A; confirm backup product/location/PITR |
| GCS Standard regional storage | 0.023/GiB-month | A; official text fetch default was not Mumbai-selected |
| GCS Class A uploads | 0.005/1,000 operations | P-reference/A-regional: S4/S12; regional SKU pending |
| GCS Class B reads | 0.0004/1,000 operations | P-reference/A-regional: S4/S12 |
| Internet egress blended | 0.12/GiB | A; destination/service-dependent, not universal rate |
| Cloud Run request-based active CPU | 0.000024/vCPU-second | P-reference: S1 |
| Cloud Run request-based active memory | 0.0000025/GiB-second | P-reference: S1 |
| Cloud Run requests | 0.40/million | P-reference: S1 |
| Cloud Run instance-based CPU | 0.000018/vCPU-second | P-reference: S1 |
| Cloud Run instance-based memory | 0.000002/GiB-second | P-reference: S1 |
| Cloud Run request-based idle CPU/memory | 0.0000025 per respective second | P-reference/A-configuration: S1; HA reserve only |
| Logging storage ingestion | 0.50/GiB | P: S8; default included retention 30 days |
| Extra log retention over 30 days | 0.01/GiB-month | P: S8; zero additional days modelled |
| Secret versions | 0.06/version-location-month | P: S9 |
| Secret accesses | 0.03/10,000 | P: S9 |
| Artifact Registry storage | 0.10/GiB-month | P: S10; image scanning separate |
| Build minute | 0.006/minute | P-reference/A-machine: S12; actual builder/region must match |
| Static Hosting storage | 0.026/GB-month | P: S11 |
| Static Hosting transfer | 0.15/GB | P: S11; not Firebase App Hosting |
| FCM delivery | 0 | P: S13; quotas/compute still apply |
| Monitoring | INR 200 / 500 / 1,500 / 2,500 / 5,000 per month by tier | A: reserve for custom metrics/alerts; not a provider tariff |

Official pages support billing mechanisms and reference rates, but regional dropdown text did not establish all Mumbai values. SQL/Redis secondary indexes were fetched directly on the estimate date. Lower prices for Valkey, Basic Redis or shared-core PostgreSQL are not substituted without compatibility and reliability analysis. Redis tier boundaries can lower the per-GiB price; the 11-GiB model price is therefore lower than a simple 1-GiB rate × 11.

### 5.2 Compute formula

```text
R = monthly requests
API_USD = R × [0.10 × (0.000024 + 1 × 0.0000025) + 0.40 / 1,000,000]
        = R × 0.00000305
API_INR = R × 0.00025925
Model_B_API = Model_A_API × 1.25
```

The 0.10 is **effective billed instance time per request**, not assumed CPU execution time or direct wall-clock latency. For overlapping requests, billed instance time is shared; configured concurrency is not necessarily achieved concurrency. Cold starts, allocation rounding, idle gaps, streaming responses and CPU saturation change this coefficient. Do not divide by a configured concurrency value and claim a measured saving. The additional 25% in Model B is an explicit headroom allowance, not a Google HA fee.

Each always-running 1-vCPU/1-GiB equivalent:

```text
2,628,000 × (0.000018 + 0.000002) × 85 = ₹4,467.60/month
Model A: 2 equivalents = ₹8,935.20
Model B: 4 equivalents = ₹17,870.40
```

Model A funds one scheduler/background equivalent and one realtime equivalent. Model B funds active/standby background equivalents and two realtime equivalents. They are separate from request-based API compute; no API work is claimed served twice. Co-locating roles may save money but requires ownership/failure testing. Warm API reserve in Model B is ₹2,233.80/month: two 1-vCPU/1-GiB request-based minimum instances at full-month idle reference rates. Adding the full idle reserve to active processing is conservative; an actual bill subtracts periods that are not idle.

### 5.3 Data and operational formulas

```text
Uploads U = N × 0.70 × 26 × 4
New_image_GiB G = U × 0.35 / 1,024
Retained_image_GiB = 12 × G
Media_INR = 12 × G × 0.023 × 85
Object_operations_INR = U / 1,000 × (0.005 + 2 × 0.0004) × 85
Egress_GiB = 2 × G + R × 2 / 1,048,576
Egress_INR = Egress_GiB × 0.12 × 85
Logs_GiB = 5 + R / 1,048,576
Logs_INR = Logs_GiB × 0.50 × 85
SQL_INR = vCPU_equivalents × 0.0811 × 730 × 85 × HA_factor
SQL_disk_INR = provisioned_GiB × 0.204 × 85 × HA_factor
Redis_INR = selected_total_hourly_rate × 730 × 85
Backup_INR = provisioned_SQL_GiB × backup_stock_factor × 0.096 × 85
Secrets_INR = (12 × 0.06 + monthly_accesses / 10,000 × 0.03) × 85
Registry_INR = retained_artifact_GiB × 0.10 × 85
Build_INR = builder_minutes × 0.006 × 85
Hosting_INR = [2 × 0.026 + admin_users × 2 × 26 / 1,024 × 0.15] × 85
Total = fixed_capacity_items + usage_items
```

API egress excludes photo bodies; photo downloads are counted separately to avoid double counting. Same-region internal traffic is assumed to avoid additional cross-region transfer, but private connectivity/network product charges still require confirmation. Storage metadata/versioning/soft-delete and retries may increase costs.

### 5.4 Free tiers: possible reductions, not multiplied credits

Cloud Run free allocations are shared at billing-account level and differ by billing mode; check exact aggregate eligibility. The gross model does not subtract them. Official reference request-based allocations include 180,000 vCPU-seconds, 360,000 GiB-seconds and 2 million requests/month. For the reference rates, those credits are worth at most about ₹512/month when fully available and applicable; do not apply a full allowance independently to each API.

Cloud Logging includes 50 GiB/project/month under the referenced policy, worth up to ₹2,125 at the gross rate; actual savings cannot exceed the model's logging line. Required-bucket logging treatment also differs. Hosting includes 10 GB stored and 10 GB/month transfer in the fetched current guide; Secret Manager includes six versions/10,000 accesses; Artifact Registry includes 0.5 GiB-month. These can reduce small ancillary charges. Build free allocations depend on the exact builder/account. Gross estimates intentionally avoid assuming eligibility.

## 6. Architectures and capacity schedules

### 6.1 Model A — lean, managed, single region

- Separate Super Admin and Employee APIs, request-based billing, minimum zero for pricing purposes.
- Two continuous service equivalents for scheduler/background and realtime.
- Single-zone Cloud SQL; managed Standard Redis; regional object storage.
- Private database/Redis connectivity, Secret Manager and platform TLS endpoints.
- Backups plus restore procedures, but no cross-region disaster recovery replica.

**Not deployment-ready:** this checkout has an embedded scheduler and no demonstrated external worker owner. Pricing a worker is not implementing one. Before API scaling, establish singleton ownership plus idempotency and post-commit delivery semantics. Long-lived realtime connections need sizing/reconnect testing; one equivalent is not proof of 10,000 connected-client capacity.

### 6.2 Model B — higher availability within one region

- Regional HA Cloud SQL with greater capacity at larger tiers.
- Standard Redis with more headroom; same managed product is already used in Model A.
- Warm API reserve, additional API capacity allowance, redundant realtime equivalents and a standby scheduler candidate.
- Exactly one active scheduling owner; standby must not independently generate work.
- Larger assumed retained backup stock.

This is not multi-region DR or a promise of zero downtime. Redundant Centrifugo nodes may require a shared broker/configuration beyond simply running two instances; compatibility and Redis headroom remain unverified. HA improves resilience but still needs recovery, failover and chaos tests.

### 6.3 Provisioned capacity schedules (assumptions, not measured recommendations)

| Input | 100 | 1,000 | 10,000 | 25,000 | 50,000 |
|---|---:|---:|---:|---:|---:|
| Model A SQL vCPU equivalents | 1 | 2 | 4 | 8 | 16 |
| Model A SQL RAM, GiB | 3.75 | 7.5 | 15 | 30 | 60 |
| Model B SQL primary vCPU equivalents | 2 | 2 | 8 | 16 | 32 |
| Model B SQL primary RAM, GiB | 7.5 | 7.5 | 30 | 60 | 120 |
| SQL disk per primary, GiB | 20 | 50 | 200 | 500 | 1,000 |
| Model A Redis, GPS, GiB | 1 | 1 | 5 | 11 | 35 |
| Model A Redis, no GPS, GiB | 1 | 1 | 1 | 5 | 5 |
| Model B Redis, GPS, GiB | 1 | 1 | 10 | 35 | 35 |
| Model B Redis, no GPS, GiB | 1 | 1 | 5 | 5 | 10 |
| Secret accesses/month | 10,000 | 20,000 | 100,000 | 250,000 | 500,000 |
| Retained artifacts, GiB | 5 | 10 | 20 | 30 | 50 |
| Build minutes/month | 100 | 200 | 400 | 600 | 1,000 |
| Monitoring allowance, INR/month | 200 | 500 | 1,500 | 2,500 | 5,000 |

SQL disk and SQL CPU are unchanged between GPS/no-GPS within the same architecture: do not promise SQL downsizing without observing actual GPS persistence. Model A used backup stock = 1.5 × primary disk; Model B = 3 ×. These are backup-churn placeholders, not a claim that retention days mechanically multiply disk usage. Snapshots are incremental; PITR/WAL usage must be measured separately. Secret versions = 12 active versions across combined services, one charged location/version. Build/registry activity is an engineering-team assumption, not intrinsically proportional to mobile users.

The smallest SQL configurations must be checked against current machine availability/edition minimums. Higher-tier prices use the linear 0.0811/hour equivalent rather than pretending rounded secondary machine quotes are precise. All memory, DB connection and Redis throughput requirements remain to be tested.

## 7. Detailed Model A line items

### 7.1 GPS enabled — monthly INR

| Component | 100 | 1,000 | 10,000 |
|---|---:|---:|---:|
| SQL compute | 5,032.26 | 10,064.51 | 20,129.02 |
| Redis Standard | 6,825.50 | 6,825.50 | 21,717.50 |
| SQL disk | 346.80 | 867.00 | 3,468.00 |
| Continuous background/realtime | 8,935.20 | 8,935.20 | 8,935.20 |
| API compute/memory/requests | 254.79 | 2,547.91 | 25,479.09 |
| Used backup stock | 244.80 | 612.00 | 2,448.00 |
| Retained images | 58.38 | 583.75 | 5,837.51 |
| Image object operations | 3.59 | 35.89 | 358.90 |
| Internet egress | 69.88 | 698.81 | 6,988.13 |
| Logging | 252.33 | 610.84 | 4,195.90 |
| Monitoring allowance | 200.00 | 500.00 | 1,500.00 |
| Secret Manager | 63.75 | 66.30 | 86.70 |
| Artifact Registry | 42.50 | 85.00 | 170.00 |
| Build service | 51.00 | 102.00 | 204.00 |
| Static Hosting | 7.66 | 10.89 | 69.17 |
| **Total** | **22,388.43** | **32,545.61** | **1,01,587.12** |
| **Annual** | **2,68,661.19** | **3,90,547.29** | **12,19,045.40** |
| Per DAU/month | 319.83 | 46.49 | 14.51 |

### 7.2 GPS disabled — monthly INR

| Component | 100 | 1,000 | 10,000 |
|---|---:|---:|---:|
| SQL compute | 5,032.26 | 10,064.51 | 20,129.02 |
| Redis Standard | 6,825.50 | 6,825.50 | 6,825.50 |
| SQL disk | 346.80 | 867.00 | 3,468.00 |
| Continuous background/realtime | 8,935.20 | 8,935.20 | 8,935.20 |
| API compute/memory/requests | 28.31 | 283.10 | 2,831.01 |
| Used backup stock | 244.80 | 612.00 | 2,448.00 |
| Retained images | 58.38 | 583.75 | 5,837.51 |
| Image object operations | 3.59 | 35.89 | 358.90 |
| Internet egress | 52.89 | 528.85 | 5,288.54 |
| Logging | 216.93 | 256.76 | 655.10 |
| Monitoring allowance | 200.00 | 500.00 | 1,500.00 |
| Secret Manager | 63.75 | 66.30 | 86.70 |
| Artifact Registry | 42.50 | 85.00 | 170.00 |
| Build service | 51.00 | 102.00 | 204.00 |
| Static Hosting | 7.66 | 10.89 | 69.17 |
| **Total** | **22,109.55** | **29,756.76** | **58,806.65** |
| **Annual** | **2,65,314.58** | **3,57,081.13** | **7,05,679.80** |
| Per DAU/month | 315.85 | 42.51 | 8.40 |

Images remain because completing/reviewing work still uses them. Disabling GPS does not imply removing attendance, shifts, allocation or task evidence. No reduction to historical retention is authorised by a pricing scenario.

## 8. Model B line items and reliability premium

Unchanged usage rows (media, image operations, egress, logs, monitoring, secrets, registry, builds and Hosting) use exactly Model A's formulas. The following table exposes every changed component rather than hiding HA inside an Other category.

| Changed monthly item | 100 | 1,000 | 10,000 |
|---|---:|---:|---:|
| Regional HA SQL compute | ₹20,129.02 | ₹20,129.02 | ₹80,516.08 |
| HA SQL disk | ₹693.60 | ₹1,734.00 | ₹6,936.00 |
| Background/realtime redundancy | ₹17,870.40 | ₹17,870.40 | ₹17,870.40 |
| Warm API reserve | ₹2,233.80 | ₹2,233.80 | ₹2,233.80 |
| Redis with GPS | ₹6,825.50 | ₹6,825.50 | ₹43,435.00 |
| Redis without GPS | ₹6,825.50 | ₹6,825.50 | ₹21,717.50 |
| API usage with GPS, including 25% headroom | ₹318.49 | ₹3,184.89 | ₹31,848.86 |
| API usage without GPS, including 25% headroom | ₹35.39 | ₹353.88 | ₹3,538.76 |
| Used backups | ₹489.60 | ₹1,224.00 | ₹4,896.00 |
| **Total with GPS, including unchanged rows** | **₹49,309.50** | **₹55,895.09** | **₹2,07,146.45** |
| **Total without GPS, including unchanged rows** | **₹48,973.99** | **₹52,540.05** | **₹1,51,878.46** |

Higher cost is partly redundancy and partly larger assumed sizing. It is not evidence that HA inherently needs twice the application's workload capacity. Separate the two when comparing real quotes. Backup/DR recovery targets and cost of downtime should determine whether the premium is justified.

## 9. GPS economics and sensitive assumptions

### 9.1 Expected Model A saving if GPS is removed

| Users | With GPS | Without GPS | Modelled saving/month | Approximate reduction |
|---|---:|---:|---:|---:|
| 100 | ₹22,388 | ₹22,110 | ₹279 | 1.2% |
| 1,000 | ₹32,546 | ₹29,757 | ₹2,789 | 8.6% |
| 10,000 | ₹1,01,587 | ₹58,807 | ₹42,780 | 42.1% |

Savings at small scale are modest because managed capacity and continuous services still run. At 10,000 users, approximately ₹14,892/month of the saving is a **conditional** Redis capacity reduction from 5 GiB to 1 GiB. If non-GPS workloads require 5 GiB, subtract that saving: no-GPS cost would instead be approximately ₹73,699/month. Actual optimisation cannot be claimed until the smaller capacity passes reliability/throughput tests.

### 9.2 GPS interval and retention

```text
GPS_memory_GiB = DAU × tracking_hours × 3,600 / interval_seconds
                 × retained_operational_days × 900 / 1,073,741,824
```

At 10,000 users, 70% DAU, eight tracking hours and 60-second fixes:

| Retained operational-day volumes | Approximate point memory before other keys |
|---|---:|
| 1 | 2.82 GiB |
| 3 | 8.45 GiB |
| 7 | 19.71 GiB |
| 30 | 84.49 GiB |

Calendar retention and actual working days differ; this is point-volume scaling, not a calendar guarantee. One day's data at 30-second updates doubles memory; at 10-second updates it is six times larger. Ingestion retries/deduplication, GEO indexes, sorted sets, replication and fragmentation may change measured memory further. Provisioned Standard capacity pricing already includes the assumed service replication; do not charge a second full replica automatically without checking SKU definitions.

A 35-GiB Redis placeholder at USD 2.03/hour costs **₹1,25,961.50/month**. Therefore seven retained operational-day volumes at 10,000 users could make Redis alone cost more than the expected entire lean 24-hour scenario. This is a sensitivity illustration, not a claim that current GPS history actually uses that much memory.

### 9.3 Photo size and retention

- At 10,000 users, images add about 248.83 GiB/month under the expected assumptions.
- Twelve months of retained stock is about 2,985.94 GiB; 24 months doubles stock if no approved lifecycle changes.
- A 2-MiB image instead of 0.35 MiB multiplies media storage and image-byte egress by about 5.71; it does not multiply all API requests or all database costs.
- First month starts with no historical stock: average first-month image stock is about half that month's new bytes under uniform uploads. This model deliberately uses the more mature twelve-month stock instead.
- Soft-deleted objects, versions, failed multipart uploads and redundant evidence can increase storage. Do not delete valid audit evidence just to meet a cost target.

### 9.4 Compute sensitivity

At 10,000 users with GPS, the Model A API line is ₹25,479/month at 0.10 effective billed seconds/request. At 0.05 it becomes approximately ₹14,410; at 0.20 approximately ₹47,617. Request charges remain, so halving active time does not halve the whole API line. These alternatives hold request volume and other sizes fixed and do not assert feasible throughput.

Password verification bursts must be treated separately from average request time. The bounded Argon2 verification queue protects admission but does not make hashing free. CPU/memory requirements and queue wait need measured concurrent-login results.

## 10. Growth, annual cost and unit economics

### 10.1 Forecasts for all requested growth stages

| Users | Lean GPS/month | Lean no-GPS/month | Higher availability GPS/month | Higher availability no-GPS/month |
|---|---:|---:|---:|---:|
| 100 | ₹22,388 | ₹22,110 | ₹49,309 | ₹48,974 |
| 1,000 | ₹32,546 | ₹29,757 | ₹55,895 | ₹52,540 |
| 10,000 | ₹1,01,587 | ₹58,807 | ₹2,07,146 | ₹1,51,878 |
| 25,000 | ₹2,13,753 | ₹1,26,162 | ₹4,62,785 | ₹2,74,664 |
| 50,000 | ₹4,64,892 | ₹2,21,206 | ₹7,79,038 | ₹5,28,759 |

The 25,000/50,000 rows are particularly uncertain. They apply a declared capacity schedule, not a validated scaling curve. For example, the jump to 35-GiB Redis at 50,000 GPS users creates a cost step and increases per-user cost. Capacity-tier boundaries, database optimisation and a different GPS history architecture could materially change it.

| Users | Lean GPS/year | Lean no-GPS/year | Higher availability GPS/year | Higher availability no-GPS/year |
|---|---:|---:|---:|---:|
| 100 | ₹2,68,661 | ₹2,65,315 | ₹5,91,714 | ₹5,87,688 |
| 1,000 | ₹3,90,547 | ₹3,57,081 | ₹6,70,741 | ₹6,30,481 |
| 10,000 | ₹12,19,045 | ₹7,05,680 | ₹24,85,757 | ₹18,22,542 |
| 25,000 | ₹25,65,041 | ₹15,13,943 | ₹55,53,415 | ₹32,95,973 |
| 50,000 | ₹55,78,707 | ₹26,54,471 | ₹93,48,461 | ₹63,45,113 |

### 10.2 Registered versus active user costs

```text
Cost_per_registered_user = monthly_total / N
Cost_per_MAU = monthly_total / (0.90 × N)
Cost_per_DAU = monthly_total / (0.70 × N)
```

These are denominator choices, not additional fees. At 10,000 users, lean GPS cost is ₹10.16/registered user, about ₹11.29/MAU and ₹14.51/DAU per month. Lean no-GPS cost is ₹5.88/registered user, about ₹6.53/MAU and ₹8.40/DAU per month. A paid user price must also cover engineering/support, taxes and commercial costs absent from this infrastructure-only model.

### 10.3 Marginal cost is not average cost

Between capacity steps, the tier's per-100-user incremental model includes API processing, images, object operations, egress, request logs and a small Hosting increment. Provisioned SQL/Redis/background costs remain unchanged **only while spare capacity remains**.

At the expected settings, workload-linked Model A marginal cost is approximately **₹427 per additional 100 GPS users/month**, versus **₹148 per additional 100 no-GPS users/month**. This excludes capacity step-ups, extra staff/builds/metrics and backup/database growth. It is about ₹4.27 or ₹1.48 per added user at constant capacity, not a sustainable universal marginal price.

A capacity step adds an entire provisioned service change to that increment. Derive it from the schedule rather than drawing a straight line between average user prices. For example, 1→5-GiB Standard Redis adds approximately ₹14,892/month under the provisional rates. An observed need for more SQL, replicas or realtime CPU can dominate the cost of adding the next 100 users.

### 10.4 Likely bottlenecks to verify

| Growth stage | Principal investigation |
|---|---|
| 100 | Fixed managed-service floor; cold starts; reliable scheduler ownership; auth burst on small CPU |
| 1,000 | Manager polling; image sizes; DB session usage; Redis queue/history sharing |
| 10,000 | GPS retention and command throughput; API burst CPU; nine-session workspace fan-out; background work/locks; realtime connections |
| 25,000 | Database indexes/query amplification; connection budget across replicas; batch generation; Redis fragmentation; egress |
| 50,000 | Capacity step economics; historical storage design; restore/failover duration; quotas; workload partitioning if measurements justify it |

## 11. Low, expected and high cases; exclusions

### 11.1 Sensitivity inputs, not measured confidence intervals

| Driver | Low | Expected | High |
|---|---|---|---|
| DAU share | 50% | 70% | 90% |
| Ordinary requests/DAU/day | 40 | 60 | 100 |
| GPS tracking | 8 hours at 120 s | 8 hours at 60 s | 10 hours at 30 s |
| GPS retained operational volumes | 1 day | 1 day | 7 days |
| Photos/DAU/day | 2 | 4 | 8 |
| Average photo size | 0.20 MiB | 0.35 MiB | 2 MiB |
| Photo retention | 3 months | 12 months | 24 months |
| Effective API billed seconds/request | 0.05 | 0.10 | 0.20 |
| Peak factor | 2 | 4 | 8 |

The tables in sections 1/7/8 price the **expected** case. Apply the section 5 formulas to other cases and **reselect capacity**; do not multiply the expected total by one factor. At 10,000 users, the high GPS case alone implies roughly 75,600,000 points across seven retained operational volumes, or about 63.4 GiB before other keys, so the expected 5/10-GiB Redis configurations cannot serve as a valid high-case quote. A numeric all-in high-case price is intentionally not presented without an appropriate confirmed capacity/SKU. The 25% budget contingency is not sufficient protection against all high-case inputs simultaneously.

### 11.2 Costs not silently included

| Item | Treatment |
|---|---|
| Extra staging/development stack | Additional; isolate credentials and data |
| Existing Railway/Supabase/Vercel subscriptions during migration | Additional duplicate bills; no cancellation assumed |
| Cloud NAT, always-on VPC connectors, external load balancer, Cloud Armor | Excluded; quote explicitly if required by chosen connectivity/security design |
| Cross-region replica/DR transfers | Excluded; Model B is regional HA only |
| Cloud DNS/custom domain registration | Excluded; small but nonzero if required |
| Artifact vulnerability scanning | Excluded from registry-storage line; per-image/product pricing needs confirmation |
| Security/SIEM/ZAP/SAST commercial services | Excluded unless covered by existing free tooling |
| SMS/OTP/email/paid maps/AI | Excluded; independent usage models needed |
| Provider premium support | Excluded |
| App-store accounts/binary distribution | Excluded |
| Engineering, on-call/support, compliance | Excluded |
| Historical data migration and restore drills | Additional one-off/periodic compute/network usage |
| GPS/history deletion or retention migration | Not performed, not implicitly approved |
| Object versions/soft-delete/PITR overflow | Not explicitly sized; contingency and actual usage confirmation required |

Managed Redis is retained in the no-GPS architecture because rate limiting, queues and realtime may still need it. Removing it to save money requires a separate reliability/compatibility decision. Reducing security logs, evidence retention or backup protection is not an acceptable unreviewed optimisation.

### 11.3 Currency and tax sensitivities

All INR figures scale by actual_conversion/85 if USD prices remain constant. At ₹90/USD, multiply by 1.0588; at ₹95/USD, by 1.1176. Google INR catalogue prices can differ from simple daily currency conversion. GST treatment should be added to a cash-flow budget, not silently merged into pre-tax operating unit costs.

## 12. Optimisation decisions and measurement plan

### 12.1 Cost controls ranked by technical justification

1. Decide whether GPS is a required product feature. Disabling it removes ingestion/history/lookup load, not just marker rendering. Keep attendance and allocation independent of GPS as intended.
2. If GPS is needed, choose a justified on-duty interval and history policy. Consider a separately approved durable historical store if Redis history is driving provisioned-memory cost. No retention/data migration is authorised here.
3. Measure polling and deduplicate cross-session refreshes. Use visibility-aware polling/realtime where verified; avoid replacing low-cost polling with an oversized realtime service without measurements.
4. Validate image compression/evidence requirements. Preserve readable proof and audit history; never delete valuable evidence solely for cost.
5. Set maximum API replicas from the **combined database connection budget**. Default pool ceiling is ten/process; total potential demand is API replicas × worker processes × pool ceiling, plus workers, migrations and operational reserve. Max instances is not itself a guaranteed database-connection cap.
6. Benchmark nine-session workspace orchestration against bounded fan-out and sequential alternatives. Never concurrently share a single SQLAlchemy AsyncSession to reduce apparent session count.
7. Establish one scheduler owner, retain ledger idempotency, and budget continuous CPU if relying on a long-running scheduler. Minimum instances alone with request-only CPU allocation do not guarantee timely background execution.
8. Apply object/container lifecycle policies only with retention/rollback approval. Keep secrets out of layers. The new backend Docker ignore file is a safeguard awaiting Docker-native verification, not evidence of an already fixed deployed image.
9. Review provisioned Redis tier, Basic/Standard trade-off, Valkey compatibility and SQL machine sizing after measurements. Do not switch products based solely on a cheaper advertised GiB.
10. Use budget alerts and bounded request/upload limits; review unusually public media/download access as a security issue first. Alerts notify; they do not cap invoices.

### 12.2 Super Admin versus Employee attribution

There is no defensible observed monetary split yet. Shared SQL, Redis, background services and media cannot be charged twice. The assumed request split would assign 15/540 of API requests to management-equivalent work with GPS, and 15/60 without GPS; it does **not** assign the same fractions of SQL/Redis or infrastructure overhead. Workspaces have much higher DB fan-out than some GPS operations.

Use per-service Cloud Run billing labels; route-template request timing; DB application_name/query statistics; Redis command/key memory samples without coordinates/secrets; media ownership/byte counts; and workload-specific CPU. Allocate shared idle capacity using an agreed accounting policy and mark it allocated rather than measured. Until then, use the combined totals for business budgeting rather than fabricated separate app bills.

### 12.3 Acceptance checklist before treating this as an operating forecast

- [ ] Confirm current deployment map, invoices and legacy-service obligations through authorised read-only evidence.
- [ ] Confirm official Mumbai SKU/edition/machine/Redis replica and networking specifications.
- [ ] Replace ₹85/USD with actual INR billing or approved finance FX.
- [ ] Run isolated synthetic migration, transaction, SQLAlchemy pool and Redis tests; do not connect to existing DBs to bypass Docker blockers.
- [ ] Measure login bursts, workspace cold/warm auth, task generation, image handling and Employee GPS ingestion.
- [ ] Record effective billed instance-seconds/request and idle/realtime instance-hours, not only HTTP latency.
- [ ] Establish actual GPS point representation, deduplication and retention; measure memory with safe synthetic data.
- [ ] Confirm counts/sizes/retention of image evidence and real download behaviour.
- [ ] Measure minimum viable DB/Redis capacity, HA failover and restore duration.
- [ ] Set budgets/alerts and verify production/dev secret isolation.
- [ ] Recalculate all scenarios using verified inputs and review before infrastructure changes.

## 13. Sources, spreadsheet and reproducibility

Sources consulted on 3 November 2026; provider prices and terms may change. Regional dropdown failures are disclosed above rather than replacing Mumbai with Iowa silently.

| ID | Source | Use |
|---|---|---|
| S1 | https://cloud.google.com/run/pricing | Billing modes, compute/request prices/free allocations |
| S2 | https://cloud.google.com/sql/pricing | SQL compute/HA/storage billing structure; regional confirmation needed |
| S3 | https://cloud.google.com/memorystore/docs/redis/pricing | Basic/Standard semantics, provisioned billing |
| S4 | https://cloud.google.com/storage/pricing | Storage/operations/network structure; regional confirmation needed |
| S5 | https://instances.usage.ai/gcp/sql/region/asia-south1 | Secondary Mumbai SQL machine prices |
| S6 | https://instances.usage.ai/gcp/memorystore/region/asia-south1 | Secondary Mumbai Redis sizes/prices |
| S7 | https://instances.usage.ai/gcp/memorystore/redis-1gib | Secondary Standard-tier identification |
| S8 | https://cloud.google.com/products/observability/pricing | Logging and monitoring billing |
| S9 | https://cloud.google.com/secret-manager/pricing | Active versions and accesses |
| S10 | https://cloud.google.com/artifact-registry/pricing | Registry stock/transfer/scanning distinction |
| S11 | https://firebase.google.com/docs/hosting/usage-quotas-pricing | Static Hosting, not App Hosting |
| S12 | https://firebase.google.com/docs/app-hosting/costs | Reference build/operations/Cloud Run rates only; not claim of App Hosting deployment |
| S13 | https://firebase.google.com/products/cloud-messaging | No-charge FCM delivery |

Machine-readable summary: [AIROS_COST_SCENARIOS.csv](AIROS_COST_SCENARIOS.csv). It contains all four architecture/GPS combinations at all five user tiers with fixed/usage/monthly/annual/per-user values. Currency is INR, before tax, without free-tier deductions. Section 5 formulas and section 6 schedules are the source calculation specification.

Arithmetic was evaluated locally using Python 3.12, without network/database access for calculations. A second calculation pass checked the 20 scenario summary rows against the declared fixed, usage, monthly and annual formulas; all matched within rounding tolerance. The 12 primary contingency budgets were also recalculated, and marginal-cost, high-retention-memory and API-time sensitivity arithmetic was checked separately. This verifies model arithmetic, not the real workload or regional tariffs. Application tests/builds were not rerun because only this document and its supporting CSV changed. Monetary precision in the CSV exists for reconciliation, not a guarantee of tariff/workload accuracy. The audit's remaining security, infrastructure, performance and isolated-service verification tasks are not marked complete by delivering this financial document. No cloud services were provisioned, resized or removed as part of this work.
