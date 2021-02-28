#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "@aws-cdk/core";
import { OtterBotStack, OtterCdkPipelineStack } from "../lib/otter_cdk-stack";

const app = new cdk.App();

const pipelineStack = new OtterCdkPipelineStack(app, "OtterBotPipelineStack");
new OtterBotStack(app, "OtterBotStack", {
  image: pipelineStack.tagParameterContainerImage,
});

app.synth();
