import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';

interface AppStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  webAclArn: string;
  bedrockGeo: string;
  dbSecret: secretsmanager.ISecret;
  dbSecurityGroupId: string;
  redisHost: string;
  redisPort: number;
  redisSecurityGroupId: string;
  masterKey: secretsmanager.ISecret;
  saltKey: secretsmanager.ISecret;
}

/**
 * Layer 3 - App (stateless, frequently deployed): ECS Fargate + private ALB
 * fronted by CloudFront VPC Origins, protected by WAF.
 */
export class AppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const { vpc } = props;

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // ---------- Task role: Bedrock via IAM (no static keys) ----------
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/*',
        'arn:aws:bedrock:*:*:inference-profile/*',
      ],
    }));

    // ---------- Task definition: 1 vCPU + 4GB (LiteLLM prod rec per worker) ----------
    const taskDef = new ecs.FargateTaskDefinition(this, 'Task', {
      cpu: 1024,
      memoryLimitMiB: 4096,
      taskRole,
    });

    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // CDK builds + pushes the image; the asset content hash is an immutable tag (no :latest).
    const image = ecs.ContainerImage.fromAsset(path.join(__dirname, '..'), {
      platform: ecrAssets.Platform.LINUX_AMD64,
    });

    taskDef.addContainer('litellm', {
      image,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'litellm', logGroup }),
      portMappings: [{ containerPort: 4000 }],
      // Non-sensitive config + production switches
      environment: {
        LITELLM_MODE: 'PRODUCTION',   // disables load_dotenv
        LITELLM_LOG: 'ERROR',
        USE_PRISMA_MIGRATE: 'True',
        AWS_REGION: this.region,
        BEDROCK_GEO: props.bedrockGeo,
        REDIS_HOST: props.redisHost,
        REDIS_PORT: String(props.redisPort),
      },
      // Injected at runtime from Secrets Manager (never in the task def plaintext).
      // DB fields are composed into DATABASE_URL by docker-entrypoint.sh.
      secrets: {
        DB_USER: ecs.Secret.fromSecretsManager(props.dbSecret, 'username'),
        DB_PASS: ecs.Secret.fromSecretsManager(props.dbSecret, 'password'),
        DB_HOST: ecs.Secret.fromSecretsManager(props.dbSecret, 'host'),
        DB_PORT: ecs.Secret.fromSecretsManager(props.dbSecret, 'port'),
        DB_NAME: ecs.Secret.fromSecretsManager(props.dbSecret, 'dbname'),
        LITELLM_MASTER_KEY: ecs.Secret.fromSecretsManager(props.masterKey),
        LITELLM_SALT_KEY: ecs.Secret.fromSecretsManager(props.saltKey),
      },
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:4000/health/readiness || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    // ---------- Internal ALB ----------
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', { vpc, allowAllOutbound: true });
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: false,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    const listener = alb.addListener('Http', { port: 80, protocol: elbv2.ApplicationProtocol.HTTP });

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 2,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: cdk.Duration.seconds(120),
    });

    listener.addTargets('Ecs', {
      port: 4000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      deregistrationDelay: cdk.Duration.seconds(30),
      healthCheck: { path: '/health/readiness', healthyHttpCodes: '200' },
    });

    // ---------- Allow ECS -> DB / Redis (rules defined here to avoid a cross-stack cycle) ----------
    const ecsSgId = service.connections.securityGroups[0].securityGroupId;
    new ec2.CfnSecurityGroupIngress(this, 'DbIngress', {
      groupId: props.dbSecurityGroupId,
      ipProtocol: 'tcp', fromPort: 5432, toPort: 5432, sourceSecurityGroupId: ecsSgId,
    });
    new ec2.CfnSecurityGroupIngress(this, 'RedisIngress', {
      groupId: props.redisSecurityGroupId,
      ipProtocol: 'tcp', fromPort: props.redisPort, toPort: props.redisPort, sourceSecurityGroupId: ecsSgId,
    });

    // ---------- Autoscaling (LiteLLM prod thresholds: CPU 60% / Mem 80%, scale horizontally) ----------
    const scaling = service.autoScaleTaskCount({ minCapacity: 2, maxCapacity: 10 });
    scaling.scaleOnCpuUtilization('Cpu', {
      targetUtilizationPercent: 60,
      scaleInCooldown: cdk.Duration.seconds(300),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });
    scaling.scaleOnMemoryUtilization('Mem', {
      targetUtilizationPercent: 80,
      scaleInCooldown: cdk.Duration.seconds(300),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    // ---------- Allow CloudFront -> private ALB via the CloudFront managed prefix list ----------
    // (AWS-documented Option 1 for VPC origins; can be applied before the VPC origin exists.)
    const cfPrefixList = new cr.AwsCustomResource(this, 'CfPrefixList', {
      installLatestAwsSdk: false,
      onUpdate: {
        service: 'EC2',
        action: 'describeManagedPrefixLists',
        parameters: { Filters: [{ Name: 'prefix-list-name', Values: ['com.amazonaws.global.cloudfront.origin-facing'] }] },
        physicalResourceId: cr.PhysicalResourceId.of('cf-origin-prefix-list'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
    });
    albSg.addIngressRule(
      ec2.Peer.prefixList(cfPrefixList.getResponseField('PrefixLists.0.PrefixListId')),
      ec2.Port.tcp(80),
      'CloudFront VPC origin',
    );

    // ---------- CloudFront with VPC Origin -> private ALB ----------
    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: 'litellm gateway',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      webAclId: props.webAclArn,
      defaultBehavior: {
        origin: origins.VpcOrigin.withApplicationLoadBalancer(alb, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          httpPort: 80,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      },
    });

    new cdk.CfnOutput(this, 'GatewayUrl', { value: `https://${distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'MasterKeySecretArn', { value: props.masterKey.secretArn });
  }
}
