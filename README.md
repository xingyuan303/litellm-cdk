# AWS 上的 LiteLLM — CDK（分层）

基于 ECS Fargate 的 LiteLLM AI 网关，前端采用 **CloudFront VPC Origins → 私有 ALB**，并配合
**ElastiCache Redis**、RDS PostgreSQL 和 WAF。使用 AWS CDK（TypeScript）构建，对齐 AWS
*Multi-Provider Generative AI Gateway* 参考架构以及 LiteLLM 生产最佳实践指南。

## 架构

```
Internet ─▶ CloudFront (+ WAF, TLS) ─▶ [VPC Origin] ─▶ private ALB ─▶ ECS Fargate (1 vCPU / 4 GB)
                                                                         ├─▶ RDS PostgreSQL (Multi-AZ)
                                                                         └─▶ ElastiCache Redis (Multi-AZ)
```

ALB 是**内网的**（私有子网，无公网 IP）。CloudFront 通过 AWS 托管的私有连接访问它，因此源站没有任何公网入口。

## 分层 stack（CloudFormation state 相互隔离）

| Stack | 内容 | 变更频率 |
|-------|------|----------|
| `Litellm-Waf` | 供 CloudFront 使用的 WAF Web ACL（始终位于 us-east-1） | 很少 |
| `Litellm-Network` | VPC、子网、NAT、VPC endpoints（ECR/S3/Secrets/Logs/Bedrock） | 很少 |
| `Litellm-Data` | RDS PostgreSQL、ElastiCache Redis、master/salt 密钥 | 很少（有状态） |
| `Litellm-App` | ECS Fargate、内网 ALB、CloudFront VPC Origin、自动扩展 | 频繁 |

部署 App 时数据库永远不会进入变更集。

## 部署

```bash
npm install
npx cdk bootstrap                 # 需要同时 bootstrap us-east-1（WAF）和你的工作负载区域
npx cdk deploy --all              # 默认：工作负载 us-east-1，Bedrock geo 为 "us"
```

部署到其他区域（工作负载 + Bedrock 地理）；WAF 会自动留在 us-east-1：

```bash
npx cdk deploy --all -c region=eu-west-1 -c bedrockGeo=eu
npx cdk deploy --all -c region=ap-southeast-1 -c bedrockGeo=global
```

输出包含 `GatewayUrl`（CloudFront）和 master key 的 secret ARN。获取 key：

```bash
aws secretsmanager get-secret-value --secret-id <MasterKeySecretArn> --query SecretString --output text
```

客户端配置：

```bash
export ANTHROPIC_BASE_URL=<GatewayUrl>
export ANTHROPIC_API_KEY=<master-key>
```

## 注意事项 / 需要确认的点

- **区域可配置**：通过 `-c region=<region> -c bedrockGeo=<us|eu|jp|au|global>`（见 `bin/litellm.ts`）。
  工作负载（Network/Data/App）运行在你选定的区域；只有 CloudFront 的 WAF（`Litellm-Waf`）
  被强制放在 us-east-1（AWS 硬性要求），并通过 `crossRegionReferences` 跨区共享。`bedrockGeo`
  会在容器启动时替换进每个 Bedrock 模型 ID。`global` 路由到全球且对所有模型统一通用；geo 前缀
  则因模型而异（当前 Claude 模型用 `us`/`eu`/`jp`/`au`，已无 `apac`）——请选一个其 profile 覆盖你
  源区域的前缀。使用 `global` 时，若你的组织用 SCP 限制区域，必须放行
  `aws:RequestedRegion: "unspecified"`。同时确认该区域 + AZ 支持 CloudFront VPC origins
  （us-east-1 排除了 AZ `use1-az3`）。
- **Redis** 仅靠安全组隔离（无 AUTH/TLS），以保证客户端开箱即连。若要启用 AUTH token + 传输层 TLS，
  在 `data-stack.ts` 中设置 `transitEncryptionEnabled`/`authToken`，并在 `config.yaml` 中补上对应的
  TLS + 密码配置。
- **RDS** 使用预置的 `db.t3.medium` Multi-AZ，删除策略为 `RETAIN`。对于突发/低流量场景，可改用
  Aurora Serverless v2 并设 `serverlessV2MinCapacity: 0`（注意冷启动恢复延迟）。
- **基础镜像**为 `main-stable`（浮动标签）。生产环境请 pin 到具体 release 标签或 `@sha256` digest 以保证可复现。
- 镜像 entrypoint 在容器启动时用 secret 字段拼出 `DATABASE_URL`；生成 secret 时已排除会破坏 URL 的
  DB 密码字符。
