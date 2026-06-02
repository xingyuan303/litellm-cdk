# LiteLLM on AWS — CDK (layered)

LiteLLM AI gateway on ECS Fargate, fronted by **CloudFront VPC Origins → private ALB**, with
**ElastiCache Redis**, RDS PostgreSQL, and WAF. Built with AWS CDK (TypeScript), aligned with the
AWS *Multi-Provider Generative AI Gateway* reference architecture and the LiteLLM production
best-practices guide.

## Architecture

```
Internet ─▶ CloudFront (+ WAF, TLS) ─▶ [VPC Origin] ─▶ private ALB ─▶ ECS Fargate (1 vCPU / 4 GB)
                                                                         ├─▶ RDS PostgreSQL (Multi-AZ)
                                                                         └─▶ ElastiCache Redis (Multi-AZ)
```

The ALB is **internal** (private subnets, no public IP). CloudFront reaches it over a private,
AWS-managed connection, so there is no public path to the origin.

## Layered stacks (separate CloudFormation state)

| Stack | Contents | Change frequency |
|-------|----------|------------------|
| `Litellm-Waf` | WAF Web ACL for CloudFront (always us-east-1) | rare |
| `Litellm-Network` | VPC, subnets, NAT, VPC endpoints (ECR/S3/Secrets/Logs/Bedrock) | rare |
| `Litellm-Data` | RDS PostgreSQL, ElastiCache Redis, master/salt key secrets | rare (stateful) |
| `Litellm-App` | ECS Fargate, internal ALB, CloudFront VPC Origin, autoscaling | frequent |

App deploys never put the database in the change set.

## Deploy

```bash
npm install
npx cdk bootstrap                 # bootstrap BOTH us-east-1 (WAF) and your workload region
npx cdk deploy --all              # defaults: workload us-east-1, Bedrock geo "us"
```

Deploy to another region (workload + Bedrock geography); WAF stays in us-east-1 automatically:

```bash
npx cdk deploy --all -c region=eu-west-1 -c bedrockGeo=eu
npx cdk deploy --all -c region=ap-southeast-1 -c bedrockGeo=global
```

Outputs include `GatewayUrl` (CloudFront) and the master-key secret ARN. Fetch the key:

```bash
aws secretsmanager get-secret-value --secret-id <MasterKeySecretArn> --query SecretString --output text
```

Client setup:

```bash
export ANTHROPIC_BASE_URL=<GatewayUrl>
export ANTHROPIC_API_KEY=<master-key>
```

## Caveats / things to verify

- **Region is configurable** via `-c region=<region> -c bedrockGeo=<us|eu|jp|au|global>` (`bin/litellm.ts`).
  The workload (Network/Data/App) runs in your chosen region; only the CloudFront WAF (`Litellm-Waf`)
  is forced to us-east-1 (AWS requirement) and shared via `crossRegionReferences`. `bedrockGeo` is
  substituted into every Bedrock model ID at container start. `global` routes worldwide and works
  uniformly across all models; geo prefixes are model-specific (current Claude models use
  `us`/`eu`/`jp`/`au`, not `apac`) — pick one whose profile covers your source region. With `global`,
  if your org restricts Regions via SCP, you must allow `aws:RequestedRegion: "unspecified"`.
  Confirm the region + AZs support CloudFront VPC origins (us-east-1 excludes AZ `use1-az3`).
- **Redis** is isolated by security group (no AUTH/TLS) for guaranteed client connectivity. To enable
  an AUTH token + in-transit TLS, set `transitEncryptionEnabled`/`authToken` in `data-stack.ts` and add
  the matching TLS + password settings to `config.yaml`.
- **RDS** uses provisioned `db.t3.medium` Multi-AZ with `RETAIN`. For bursty/low traffic, switch to
  Aurora Serverless v2 with `serverlessV2MinCapacity: 0` (mind the cold-start resume latency).
- **Base image** is `main-stable` (floating). Pin a release tag or `@sha256` digest for reproducibility.
- The image entrypoint composes `DATABASE_URL` from secret fields at container start; DB password
  characters that would break a URL are excluded at secret generation.
