# AWS — What's Running

Account `891377169327` (Yarn, org `o-pfiion9d7l`, master `jasper@yarn.so`) · captured 2026-07-31 · region `us-east-1` unless noted.

Scope: **actively running** resources only. Stopped EC2 instances, event-driven Lambdas, and empty clusters are excluded.

## EC2 instances (running)

| Name | Instance ID | Type | Notes |
|------|-------------|------|-------|
| fav-pm2-beefy-boi | i-01ff2ee413c9bad08 | c5.12xlarge | large general-purpose box (likely PM2 Node service) |
| preprocess-video-1 | i-04e92d91851250fd9 | c5.4xlarge | video preprocessing |
| prod-ss-export-orchestrator-vm1 | i-013824dab26cc337b | c5.xlarge | ss-export render orchestrator |
| ss-export-dev-db | i-0a531df5463489216 | t2.large | ss-export dev database |
| (unnamed) | i-0c14e275b7419b2d3 | t3.medium | no Name tag |

All other EC2 instances (12 in us-east-1, 1 `mac2-m2pro.metal` in us-east-2) are **stopped**.

## ECS tasks (running)

| Cluster | Running tasks | Active services |
|---------|---------------|-----------------|
| prod-hypersphere-video-processor-ForcedAlignerService | 1 | 1 |

`vconv-cluster` and `default` have 0 running tasks.

## Always-on managed services

These are continuously serving / billable even with no EC2 running:

- **Kinesis streams (ACTIVE, provisioned):** `aman-hypersphere-video-processor-MuxViewStream`, `prod-hypersphere-video-processor-MuxViewStream`
- **Client VPN endpoints (available):** `office-01`, `office-02`, `office-03`, `office-04`, `jan-access-vpn` — 5 total
- **CloudFront distributions (enabled):** 6 — fronting `render.yarndist.com`, `*.yarnorchestrator.com`, `render.yarnorchestrator.com`, `aligner.yarnservices.com`, `assets.yarn.so`
- **Load balancers (active):** `prod-h-Force-r1TdCP2R7qyV` (internet-facing ALB), `prod-ss-export-audio-worker-lb0` (internal ALB)
- **Elastic Beanstalk env:** `manifold-captions-env` — status `Ready` but health `Grey` (idle, no traffic)
- **Dedicated host (available):** `h-0286f3499429ecabc` (us-east-1a)

## Not running (for reference)

- 12 stopped EC2 in us-east-1 (GPU renderers `g4dn`/`g5`, export DBs, orchestrator VMs) + 1 stopped Mac in us-east-2
- 42 Lambdas (event-driven — invoked on demand, not continuously running)
- vconv-cluster / default ECS clusters (0 tasks)
