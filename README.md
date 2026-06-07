# AWS 上的 LiteLLM — CDK（分层）

基于 ECS Fargate 的 LiteLLM AI 网关，前端采用 **CloudFront VPC Origins → 私有 ALB**，并配合
**ElastiCache Redis**、RDS PostgreSQL 和 WAF。使用 AWS CDK（TypeScript）构建，对齐 AWS
*Multi-Provider Generative AI Gateway* 参考架构以及 LiteLLM 生产最佳实践指南。

## 特性

- **零公网源站**：CloudFront VPC Origins 直连私有 ALB，ALB 无公网 IP
- **WAF 防护**：速率限制（每 IP 200000/5min，粗粒度防滥用）+ AWS 托管规则组（CommonRuleSet）
- **ElastiCache Redis**：多 AZ，跨 Fargate 实例共享缓存与路由状态
- **RDS PostgreSQL**：Multi-AZ、加密、自动备份、存储自动扩展
- **自动扩展**：ECS Fargate 2–10 实例，CPU 60% / 内存 80% 触发，单实例 1 vCPU / 4 GB
- **Bedrock 经 IAM 角色访问**：无静态密钥；支持 us/eu/jp/au/global 跨区推理（CRIS）
- **区域可配置**：一个参数切换工作负载区域与 Bedrock 地理
- **Secrets Manager**：master key、salt key、DB 密码全部托管，运行时注入
- **不可变镜像**：CDK asset 内容哈希作为镜像标签，可回滚可追溯
- **分层 stack**：Network / Data / App / WAF 独立，改 App 不动数据库
- **部署安全**：ECS 部署断路器，失败自动回滚
- **生产化配置**：LITELLM_MODE=PRODUCTION、批量写 spend、DB 不可用降级、连接池限制

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

## 组件清单

| 组件 | 用途 | 数量 |
|------|------|------|
| CloudFront Distribution | 全球加速 + TLS 终结 + WAF 接入 | 1 |
| WAF Web ACL | 速率限制 + 托管规则（us-east-1） | 1 |
| Application Load Balancer | 内网负载均衡（私有子网） | 1 |
| ECS Fargate（集群 + 服务） | 运行 LiteLLM（1 vCPU / 4 GB） | 2–10（自动扩展） |
| RDS PostgreSQL | virtual key / spend 追踪（Multi-AZ） | 1 |
| ElastiCache Redis | 缓存 + 路由状态（Multi-AZ） | 1（2 节点） |
| VPC | 3 AZ，公有/私有子网 + 单 NAT | 1 |
| VPC Endpoints | ECR/S3/Secrets/Logs/Bedrock | 5+ |
| Secrets Manager | master / salt / DB 密码 | 多个 |
| IAM 角色 | 任务执行角色 + 任务角色（Bedrock 访问） | 2 |
| CloudWatch Logs | 容器日志 + 指标 | 1 |

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

可用模型名称（在 `config.yaml` 中定义）：`claude-opus-4-8`、`claude-sonnet-4-6`、`claude-haiku-4-5`。
> 注意：base URL 末尾不要加 `/v1`，SDK 会自动拼接路径。

验证：

```bash
curl $ANTHROPIC_BASE_URL/health/readiness
curl $ANTHROPIC_BASE_URL/v1/models -H "Authorization: Bearer $ANTHROPIC_API_KEY"
```

## 故障排查

- **ECS 任务起不来**：查容器日志（CloudWatch，stream 前缀 `litellm`；用 `aws logs describe-log-groups` 找到 `Litellm-App` 下的日志组），并看 `aws ecs describe-tasks` 的 `stoppedReason`。
- **CloudFront 返回 502/504**：多半是 ALB target 不健康。确认 `/health/readiness` 通过、ECS 任务为 RUNNING、ALB 安全组放行了 CloudFront 托管前缀列表。
- **Bedrock AccessDenied / 模型不可用**：确认目标区域已启用该模型、`bedrockGeo` 前缀与源区域匹配（如 ap-southeast-1 用 `global`）、任务角色含 bedrock 权限；若用 `global` 且组织有 SCP 区域限制，放行 `aws:RequestedRegion: "unspecified"`。
- **数据库连不上**：检查 secret 是否注入、ECS→RDS 安全组（5432）、`DATABASE_URL` 由 entrypoint 拼接是否正确。
- **Redis 连不上**：检查 ECS→Redis 安全组（6379）和 `REDIS_HOST` / `REDIS_PORT` 环境变量。
- **VPC origin 不通**：确认 ALB 安全组放行了 CloudFront 前缀列表，且区域 AZ 支持 VPC origins（us-east-1 避开 `use1-az3`）。
- **WAF 误拦合法请求**：在 WAF 的 CloudWatch 指标 / sampled requests 中查被哪条规则拦截，按需调整。

常用命令：

```bash
aws logs tail <log-group> --follow                                          # 实时日志
aws ecs describe-services --cluster <cluster> --services <service>          # 服务状态
aws ecs update-service --cluster <cluster> --service <service> --force-new-deployment  # 强制重新部署
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
- **WAF 速率限制按需设置**：默认每 IP 200000/5min（`lib/waf-stack.ts` 的 `rateBasedStatement.limit`），
  这是粗粒度的防滥用/防 DDoS 阈值，请根据实际流量调整。注意它按**源 IP** 聚合——共享出口 IP 的
  办公网会共用同一配额，所以阈值要留足余量。真正的**每用户 / 每团队限流**建议交给 LiteLLM 虚拟 key
  的 RPM/TPM（基于 API key，不受共享 IP 影响）。
- **Redis** 仅靠安全组隔离（无 AUTH/TLS），以保证客户端开箱即连。若要启用 AUTH token + 传输层 TLS，
  在 `data-stack.ts` 中设置 `transitEncryptionEnabled`/`authToken`，并在 `config.yaml` 中补上对应的
  TLS + 密码配置。
- **RDS** 使用预置的 `db.t3.medium` Multi-AZ，删除策略为 `RETAIN`。对于突发/低流量场景，可改用
  Aurora Serverless v2 并设 `serverlessV2MinCapacity: 0`（注意冷启动恢复延迟）。
- **基础镜像**为 `main-stable`（浮动标签）。生产环境请 pin 到具体 release 标签或 `@sha256` digest 以保证可复现。
- 镜像 entrypoint 在容器启动时用 secret 字段拼出 `DATABASE_URL`；生成 secret 时已排除会破坏 URL 的
  DB 密码字符。
