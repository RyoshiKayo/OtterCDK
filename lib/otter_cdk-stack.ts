import { config } from "dotenv"; config();
import { Stack, Construct, StackProps, Duration } from '@aws-cdk/core';
import { Vpc } from "@aws-cdk/aws-ec2";
import { Cluster, ContainerImage } from "@aws-cdk/aws-ecs";
import { NetworkLoadBalancedFargateService } from "@aws-cdk/aws-ecs-patterns";
import { Secret } from "@aws-cdk/aws-secretsmanager";

export class OtterCdkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    if (!process.env.OTTER_BOT_TOKEN_SECRET_ARN) throw new Error("OTTER_BOT_TOKEN_SECRET_ARN must be defined!");

    const vpc = new Vpc(this, 'OtterVPC', { maxAzs: 2 });
    const cluster = new Cluster(this, 'OtterFargate', { vpc });

    const discordBotTokenSecret = Secret.fromSecretAttributes(this, "OtterBotTokenSecret", {
      secretCompleteArn: process.env.OTTER_BOT_TOKEN_SECRET_ARN
    });

    const fargateService = new NetworkLoadBalancedFargateService(this, "OtterApp", {
      cluster,
      taskImageOptions: {
        image: ContainerImage.fromRegistry("kayochuu/otter"),
        environment: {
          "DISCORD_BOT_TOKEN": discordBotTokenSecret.secretValue.toString()
        }
      }
    });

    const scaling = fargateService.service.autoScaleTaskCount({ maxCapacity: 2 });

    scaling.scaleOnMemoryUtilization('MemScaling', {
      targetUtilizationPercent: 90,
      scaleInCooldown: Duration.minutes(30),
      scaleOutCooldown: Duration.minutes(30)
    });

    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 90,
      scaleInCooldown: Duration.minutes(30),
      scaleOutCooldown: Duration.minutes(30)
    });
  }
}
