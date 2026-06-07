#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/network-stack';
import { DataStack } from '../lib/data-stack';
import { AppStack } from '../lib/app-stack';
import { WafStack } from '../lib/waf-stack';

const app = new cdk.App();
const account = process.env.CDK_DEFAULT_ACCOUNT;

// Workload region is configurable:  cdk deploy --all -c region=eu-west-1 -c bedrockGeo=eu
// bedrockGeo (us|eu|jp|au|global) selects the Bedrock cross-region inference profile prefix.
// global routes worldwide and works for all models; geo prefixes keep routing within that geography
// (relevant for data residency). Defaults to global; override with -c bedrockGeo=us (etc.).
const region = app.node.tryGetContext('region') || process.env.CDK_DEFAULT_REGION || 'us-east-1';
const bedrockGeo = app.node.tryGetContext('bedrockGeo') || 'global';
const env = { account, region };

// WAF for CloudFront must always be us-east-1 (AWS hard requirement); shared cross-region.
const waf = new WafStack(app, 'Litellm-Waf', {
  env: { account, region: 'us-east-1' },
  crossRegionReferences: true,
});

const network = new NetworkStack(app, 'Litellm-Network', { env });

const data = new DataStack(app, 'Litellm-Data', { env, vpc: network.vpc });

new AppStack(app, 'Litellm-App', {
  env,
  crossRegionReferences: true,
  webAclArn: waf.webAclArn,
  bedrockGeo,
  vpc: network.vpc,
  dbSecret: data.dbSecret,
  databaseUrlSecret: data.databaseUrlSecret,
  dbSecurityGroupId: data.dbSecurityGroupId,
  redisHost: data.redisHost,
  redisPort: data.redisPort,
  redisSecurityGroupId: data.redisSecurityGroupId,
  masterKey: data.masterKey,
  saltKey: data.saltKey,
});
