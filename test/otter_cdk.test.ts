import { SynthUtils } from '@aws-cdk/assert';
import { App } from '@aws-cdk/core';
import { OtterCdkStack } from '../lib/otter_cdk-stack';

test('Empty Stack', () => {
  const app = new App();
  process.env.OTTER_BOT_TOKEN_SECRET_ARN = "arn:aws:secretsmanager:us-west-2:123456789000:secret:OtterDiscordBotToken-1a2b3c";
  const stack = new OtterCdkStack(app, 'MyTestStack');
  expect(SynthUtils.toCloudFormation(stack)).toMatchSnapshot();
});
