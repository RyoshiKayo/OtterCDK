#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { OtterCdkStack } from '../lib/otter_cdk-stack';

const app = new cdk.App();
new OtterCdkStack(app, 'OtterCdkStack');
