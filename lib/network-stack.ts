import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Layer 1 - Network. Rarely changes; isolated stack so app/data churn never touches it.
 * VPC origins require an Internet Gateway present in the VPC (public subnets provide it),
 * even though the ALB itself is private. See README caveats.
 */
export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 3,
      // Single NAT for cost. Bedrock/ECR/S3/Secrets/Logs go via the VPC endpoints below,
      // so NAT only carries traffic to external LLM providers (OpenAI/Anthropic).
      // Bedrock-only users can set natGateways: 0 and switch the private subnets to PRIVATE_ISOLATED.
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    // Keep AWS-bound traffic off the NAT gateway
    this.vpc.addInterfaceEndpoint('Ecr', { service: ec2.InterfaceVpcEndpointAwsService.ECR });
    this.vpc.addInterfaceEndpoint('EcrDocker', { service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER });
    this.vpc.addInterfaceEndpoint('Secrets', { service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER });
    this.vpc.addInterfaceEndpoint('Logs', { service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS });
    this.vpc.addInterfaceEndpoint('Bedrock', { service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME });
    this.vpc.addGatewayEndpoint('S3', { service: ec2.GatewayVpcEndpointAwsService.S3 });
  }
}
