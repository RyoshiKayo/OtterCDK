import * as cdk from "@aws-cdk/core";
import * as ec2 from "@aws-cdk/aws-ec2";
import * as ecs from "@aws-cdk/aws-ecs";
import * as ecs_patterns from "@aws-cdk/aws-ecs-patterns";
import * as ssm from "@aws-cdk/aws-secretsmanager";
import * as codepipeline from "@aws-cdk/aws-codepipeline";
import * as codebuild from "@aws-cdk/aws-codebuild";
import * as s3 from "@aws-cdk/aws-s3";
import * as codepipeline_actions from "@aws-cdk/aws-codepipeline-actions";
import * as ecr from "@aws-cdk/aws-ecr";
import * as ddb from "@aws-cdk/aws-dynamodb";
import { TagParameterContainerImage } from "@aws-cdk/aws-ecs";

export interface OtterBotStackProps extends cdk.StackProps {
  readonly image: ecs.ContainerImage;
}

export class OtterBotStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: OtterBotStackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "OtterVPC", { maxAzs: 2 });
    const cluster = new ecs.Cluster(this, "OtterFargate", { vpc });

    const discordBotTokenSecret = ssm.Secret.fromSecretAttributes(
      this,
      "OtterBotTokenSecret",
      {
        secretCompleteArn:
          "arn:aws:secretsmanager:us-west-2:107430322994:secret:OtterDiscordBotToken-2uuZDv",
      }
    );

    const fargateService = new ecs_patterns.NetworkLoadBalancedFargateService(
      this,
      "OtterApp",
      {
        cluster,
        taskImageOptions: {
          image: props.image,
          environment: {
            DISCORD_BOT_PREFIX: "o!",
            DISCORD_BOT_OWNER: "132266422679240704",
            DISCORD_BOT_TOKEN: discordBotTokenSecret.secretValue.toString(),
            DISCORD_BOT_GUILD_SETTINGS_TABLE_NAME: "OtterGuildSettings",
          },
        },
      }
    );

    const scaling = fargateService.service.autoScaleTaskCount({
      maxCapacity: 1,
    });

    scaling.scaleOnMemoryUtilization("MemScaling", {
      targetUtilizationPercent: 90,
    });

    scaling.scaleOnCpuUtilization("CpuScaling", {
      targetUtilizationPercent: 90,
    });

    let guildSettingsTable = new ddb.Table(this, "OtterGuildSettingsTable", {
      partitionKey: {
        name: "guild",
        type: ddb.AttributeType.STRING,
      },
      tableName: "OtterGuildSettings",
    });

    guildSettingsTable.addGlobalSecondaryIndex({
      indexName: "guild_enabled-index",
      partitionKey: {
        name: "enabled",
        type: ddb.AttributeType.NUMBER,
      },
    });

    guildSettingsTable.grantReadWriteData(
      fargateService.service.taskDefinition.taskRole
    );
  }
}

/**
 * Most of this was taken from:
 *  https://github.com/aws/aws-cdk/blob/master/packages/%40aws-cdk/aws-codepipeline-actions/test/integ.pipeline-ecs-separate-source.lit.ts
 */
export class OtterCdkPipelineStack extends cdk.Stack {
  public readonly tagParameterContainerImage: TagParameterContainerImage;

  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    /* ********** ECS part **************** */

    // this is the ECR repository where the built Docker image will be pushed
    const appEcrRepo = new ecr.Repository(this, "OtterBotRepo");
    // the build that creates the Docker image, and pushes it to the ECR repo
    const appCodeDockerBuild = new codebuild.Project(
      this,
      "RyoshiKayo-Otter-BuildAndPushImage",
      {
        environment: {
          // we need to run Docker
          privileged: true,
        },
        buildSpec: codebuild.BuildSpec.fromObject({
          version: "0.2",
          phases: {
            build: {
              commands: [
                // login to ECR first
                "$(aws ecr get-login --region $AWS_DEFAULT_REGION --no-include-email)",
                // if your application needs any build steps, they would be invoked here

                // build the image, and tag it with the commit hash
                // (CODEBUILD_RESOLVED_SOURCE_VERSION is a special environment variable available in CodeBuild)
                "docker build -t $REPOSITORY_URI:$CODEBUILD_RESOLVED_SOURCE_VERSION .",
              ],
            },
            post_build: {
              commands: [
                // push the built image into the ECR repository
                "docker push $REPOSITORY_URI:$CODEBUILD_RESOLVED_SOURCE_VERSION",
                // save the declared tag as an environment variable,
                // that is then exported below in the 'exported-variables' section as a CodePipeline Variable
                "export imageTag=$CODEBUILD_RESOLVED_SOURCE_VERSION",
              ],
            },
          },
          env: {
            // save the imageTag environment variable as a CodePipeline Variable
            "exported-variables": ["imageTag"],
          },
        }),
        environmentVariables: {
          REPOSITORY_URI: {
            value: appEcrRepo.repositoryUri,
          },
        },
      }
    );
    // needed for `docker push`
    appEcrRepo.grantPullPush(appCodeDockerBuild);
    // create the ContainerImage used for the ECS application Stack
    this.tagParameterContainerImage = new ecs.TagParameterContainerImage(
      appEcrRepo
    );

    const cdkCodeBuild = new codebuild.Project(this, "RyoshiKayo-OtterCDK", {
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          install: {
            commands: ["npm install"],
          },
          build: {
            commands: [
              // synthesize the CDK code for the ECS application Stack
              "npm run cdk synth --verbose",
            ],
          },
        },
        artifacts: {
          // store the entire Cloud Assembly as the output artifact
          "base-directory": "cdk.out",
          files: "**/*",
        },
      }),
    });

    /* ********** Pipeline part **************** */

    const appCodeSourceOutput = new codepipeline.Artifact();
    const cdkCodeSourceOutput = new codepipeline.Artifact();
    const cdkCodeBuildOutput = new codepipeline.Artifact();
    const appCodeBuildAction = new codepipeline_actions.CodeBuildAction({
      actionName: "OtterBotCodeDockerImageBuildAndPush",
      project: appCodeDockerBuild,
      input: appCodeSourceOutput,
    });
    new codepipeline.Pipeline(this, "CodePipelineDeployingEcsApplication", {
      artifactBucket: new s3.Bucket(this, "ArtifactBucket", {
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      stages: [
        {
          stageName: "Source",
          actions: [
            // this is the Action that takes the source of your application code
            new codepipeline_actions.GitHubSourceAction({
              actionName: "RyoshiKayo-Otter",
              owner: "RyoshiKayo",
              repo: "Otter",
              output: appCodeSourceOutput,
              branch: "main",
              oauthToken: cdk.SecretValue.secretsManager(
                "RyoshiKayo-github-token"
              ),
            }),
            // this is the Action that takes the source of your CDK code
            // (which would probably include this Pipeline code as well)
            new codepipeline_actions.GitHubSourceAction({
              actionName: "RyoshiKayo-OtterCDK",
              owner: "RyoshiKayo",
              repo: "OtterCDK",
              output: cdkCodeSourceOutput,
              branch: "main",
              oauthToken: cdk.SecretValue.secretsManager(
                "RyoshiKayo-github-token"
              ),
            }),
          ],
        },
        {
          stageName: "Build",
          actions: [
            appCodeBuildAction,
            new codepipeline_actions.CodeBuildAction({
              actionName: "OtterCdkCodeBuildAndSynth",
              project: cdkCodeBuild,
              input: cdkCodeSourceOutput,
              outputs: [cdkCodeBuildOutput],
            }),
          ],
        },
        {
          stageName: "Deploy",
          actions: [
            new codepipeline_actions.CloudFormationCreateUpdateStackAction({
              actionName: "Deploy-Otter",
              stackName: "OtterBotStack",
              // this name has to be the same name as used below in the CDK code for the application Stack
              templatePath: cdkCodeBuildOutput.atPath(
                "OtterBotStack.template.json"
              ),
              adminPermissions: true,
              parameterOverrides: {
                // read the tag pushed to the ECR repository from the CodePipeline Variable saved by the application build step,
                // and pass it as the CloudFormation Parameter for the tag
                [this.tagParameterContainerImage
                  .tagParameterName]: appCodeBuildAction.variable("imageTag"),
              },
            }),
          ],
        },
      ],
    });
  }
}
