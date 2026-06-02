import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

interface DataStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
}

/**
 * Layer 2 - Data (stateful). Isolated so app deploys never put RDS/Redis in the change set.
 */
export class DataStack extends cdk.Stack {
  public readonly dbSecret: secretsmanager.ISecret;
  public readonly dbSecurityGroupId: string;
  public readonly redisHost: string;
  public readonly redisPort = 6379;
  public readonly redisSecurityGroupId: string;
  public readonly masterKey: secretsmanager.ISecret;
  public readonly saltKey: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { vpc } = props;

    // ---------- RDS PostgreSQL ----------
    // Production-aligned with the AWS reference architecture. For spiky/low traffic you can
    // swap this for an Aurora Serverless v2 cluster with serverlessV2MinCapacity: 0 (scale-to-zero);
    // note the cold-start resume latency, which is why an always-on proxy defaults to provisioned RDS.
    const db = new rds.DatabaseInstance(this, 'Db', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17 }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      multiAz: true,
      allocatedStorage: 100,
      maxAllocatedStorage: 500,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      databaseName: 'litellm',
      credentials: rds.Credentials.fromGeneratedSecret('litellm_admin', {
        // Exclude chars that would break the composed postgres:// URL (no urlencoding needed)
        excludeCharacters: '/@" \\\'%:?#[]&+',
      }),
      backupRetention: cdk.Duration.days(7),
      cloudwatchLogsExports: ['postgresql'],
      enablePerformanceInsights: true,
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.dbSecret = db.secret!;
    this.dbSecurityGroupId = db.connections.securityGroups[0].securityGroupId;

    // ---------- ElastiCache Redis (Multi-AZ replication group) ----------
    // Shared cache + routing state across all Fargate tasks (required once you run >1 instance).
    // Isolated by security group inside private subnets. To add an AUTH token + in-transit TLS,
    // set transitEncryptionEnabled + authToken here AND configure redis TLS in config.yaml.
    const redisSg = new ec2.SecurityGroup(this, 'RedisSg', { vpc, allowAllOutbound: true });
    const redisSubnets = new elasticache.CfnSubnetGroup(this, 'RedisSubnets', {
      description: 'litellm redis subnets',
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
    });
    const redis = new elasticache.CfnReplicationGroup(this, 'Redis', {
      replicationGroupDescription: 'litellm cache and routing state',
      engine: 'redis',
      engineVersion: '7.1',
      cacheNodeType: 'cache.t4g.micro',
      numCacheClusters: 2,
      automaticFailoverEnabled: true,
      multiAzEnabled: true,
      atRestEncryptionEnabled: true,
      cacheSubnetGroupName: redisSubnets.ref,
      securityGroupIds: [redisSg.securityGroupId],
      port: this.redisPort,
    });
    redis.addDependency(redisSubnets);
    this.redisHost = redis.attrPrimaryEndPointAddress;
    this.redisSecurityGroupId = redisSg.securityGroupId;

    // ---------- LiteLLM keys ----------
    // master_key: convention is an 'sk-' prefix; injected raw here. Rotate via Secrets Manager.
    this.masterKey = new secretsmanager.Secret(this, 'MasterKey', {
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });
    // salt_key: encrypts stored LLM credentials. DO NOT change after adding models -> RETAIN.
    this.saltKey = new secretsmanager.Secret(this, 'SaltKey', {
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });
    (this.saltKey.node.defaultChild as secretsmanager.CfnSecret).applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    new cdk.CfnOutput(this, 'DbEndpoint', { value: db.dbInstanceEndpointAddress });
    new cdk.CfnOutput(this, 'RedisEndpoint', { value: this.redisHost });
  }
}
