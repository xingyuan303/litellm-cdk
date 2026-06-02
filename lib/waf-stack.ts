import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

/**
 * CLOUDFRONT-scope WAF must be created in us-east-1, independent of the workload region.
 * Kept in its own stack so the workload (Network/Data/App) can live in any supported region;
 * the ARN is shared via crossRegionReferences.
 */
export class WafStack extends cdk.Stack {
  public readonly webAclArn: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const waf = new wafv2.CfnWebACL(this, 'Waf', {
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'litellm-waf', sampledRequestsEnabled: true },
      rules: [
        {
          name: 'RateLimit', priority: 1, action: { block: {} },
          statement: { rateBasedStatement: { limit: 2000, aggregateKeyType: 'IP' } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'litellm-ratelimit', sampledRequestsEnabled: true },
        },
        {
          name: 'Common', priority: 2, overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesCommonRuleSet' } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'litellm-common', sampledRequestsEnabled: true },
        },
      ],
    });

    this.webAclArn = waf.attrArn;
  }
}
