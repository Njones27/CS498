// Synthesizes the whole app from the real prod config (no AWS access, no Docker) and checks the properties that
// would be expensive or unsafe to get wrong.

import * as path from 'path';

import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';

import { AppContext } from '../lib/app-context';
import { createStacks, ParkingStacks, STAGE_STACKS } from '../lib/create-stacks';
import * as fs from 'fs';

import { CI_ASSUMABLE_CDK_ROLES } from '../stack/cicd-stack';
import { MAX_RECEIVE_COUNT } from '../stack/data-stack';
import { SPA_REWRITE } from '../stack/web-stack';

const CONFIG = path.resolve(__dirname, '..', 'config', 'app-config-prod.json');

function synth(context: Record<string, unknown> = {}): ParkingStacks {
    const appContext = new AppContext({
        appConfigFileKey: 'APP_CONFIG',
        contextArgs: ['Stack.Web.DistPath', 'Stack.Api.CodePath', 'Stack.Worker.TimeoutSeconds', 'Stack.Web.CspReportOnly'],
        appProps: {
            context: {
                APP_CONFIG: CONFIG,
                'Stack.Web.DistPath': 'test/fixtures/site',
                'Stack.Api.CodePath': 'test/fixtures/api',
                ...context,
            },
        },
    });
    return createStacks(appContext);
}

describe('the prod stage', () => {
    let stacks: ParkingStacks;
    const template = (name: keyof ParkingStacks) => Template.fromStack(stacks[name]!);

    beforeAll(() => {
        stacks = synth();
    });

    it('names every stack ParkingProd-<Stack> and deploys the stage stacks in order', () => {
        expect(stacks.cicd!.stackName).toBe('ParkingProd-Cicd');
        const stage = [stacks.data!, stacks.auth!, stacks.api!, stacks.worker!, stacks.web!, stacks.ops!];
        expect(stage.map((stack) => stack.stackName)).toEqual(STAGE_STACKS.map((name) => `ParkingProd-${name}`));
        for (let i = 1; i < stage.length; i++) {
            expect(stage[i].dependencies).toContain(stage[i - 1]);
        }
        expect(stacks.cicd!.dependencies).toEqual([]);
    });

    it('keeps the table, the photo bucket and the user pool when a stack is deleted', () => {
        template('data').hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
        template('data').hasResourceProperties('AWS::DynamoDB::Table', {
            DeletionProtectionEnabled: true,
            BillingMode: 'PAY_PER_REQUEST',
            KeySchema: [
                { AttributeName: 'PK', KeyType: 'HASH' },
                { AttributeName: 'SK', KeyType: 'RANGE' },
            ],
            GlobalSecondaryIndexes: [Match.objectLike({ IndexName: 'GSI1' })],
            TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
        });
        template('data').hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
        template('auth').hasResource('AWS::Cognito::UserPool', { DeletionPolicy: 'Retain' });
    });

    it('keeps both buckets private', () => {
        const blocked = { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true };
        template('data').allResourcesProperties('AWS::S3::Bucket', { PublicAccessBlockConfiguration: blocked });
        template('web').allResourcesProperties('AWS::S3::Bucket', { PublicAccessBlockConfiguration: blocked });
    });

    it('lets browsers upload to and read from the photo bucket', () => {
        template('data').hasResourceProperties('AWS::S3::Bucket', {
            CorsConfiguration: {
                CorsRules: [Match.objectLike({ AllowedMethods: ['PUT', 'GET', 'HEAD'], ExposedHeaders: ['ETag'] })],
            },
        });
    });

    it('sets a job aside only after the worker had its attempts and never redelivers one that is still running', () => {
        template('data').hasResourceProperties('AWS::SQS::Queue', {
            VisibilityTimeout: 300,
            RedrivePolicy: Match.objectLike({ maxReceiveCount: MAX_RECEIVE_COUNT }),
        });
        expect(() => synth({ 'Stack.Worker.TimeoutSeconds': 301 })).toThrow(/JobVisibilityTimeoutSeconds/);
        // The worker marks a job failed on its own last attempt; the queue must not set the message aside before
        // that, and leaves room for deliveries that never ran the job.
        const worker = fs.readFileSync(path.resolve(__dirname, '../../worker/parking_worker/handler.py'), 'utf8');
        const maxAttempts = Number(/^MAX_ATTEMPTS = (\d+)$/m.exec(worker)?.[1]);
        expect(maxAttempts).toBeGreaterThan(0);
        expect(MAX_RECEIVE_COUNT).toBeGreaterThan(maxAttempts);
        // Headroom, not more work: a worker killed on every delivery runs the job this many times.
        expect(MAX_RECEIVE_COUNT).toBeLessThanOrEqual(maxAttempts + 2);
    });

    it('has no self sign-up and a password-only web client without a secret', () => {
        template('auth').hasResourceProperties('AWS::Cognito::UserPool', {
            AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
            UsernameAttributes: ['email'],
        });
        template('auth').hasResourceProperties('AWS::Cognito::UserPoolClient', {
            GenerateSecret: false,
            ExplicitAuthFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
            PreventUserExistenceErrors: 'ENABLED',
        });
        template('auth').hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'admin' });
    });

    it('runs the API as a zip Lambda in cognito mode behind a throttled /api route', () => {
        template('api').hasResourceProperties('AWS::Lambda::Function', {
            Handler: 'parking_api.lambda_handler.handler',
            Runtime: 'python3.12',
            Architectures: ['x86_64'],
            Environment: { Variables: Match.objectLike({ APP_ENV: 'aws', AUTH_MODE: 'cognito' }) },
        });
        template('api').hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'ANY /api/{proxy+}' });
        template('api').hasResourceProperties('AWS::ApiGatewayV2::Stage', {
            StageName: '$default',
            DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
        });
    });

    it('runs the worker as a container image with the real detector, fed by the queue', () => {
        template('worker').hasResourceProperties('AWS::Lambda::Function', {
            PackageType: 'Image',
            Architectures: ['x86_64'],
            MemorySize: 3008,
            Timeout: 240,
            Environment: { Variables: Match.objectLike({ APP_ENV: 'aws', DETECTOR: 'acpds_yolo' }) },
        });
        template('worker').hasResourceProperties('AWS::Lambda::EventSourceMapping', {
            BatchSize: 1,
            ScalingConfig: { MaximumConcurrency: 2 },
            FunctionResponseTypes: ['ReportBatchItemFailures'],
        });
    });

    it('gives the API and the worker separate roles with only the access each needs', () => {
        const actions = (name: 'api' | 'worker'): string[] =>
            Object.values(template(name).findResources('AWS::IAM::Policy'))
                .flatMap((policy) => policy.Properties.PolicyDocument.Statement as { Action: string | string[] }[])
                .flatMap((statement) => statement.Action);

        expect(actions('api')).toEqual(expect.arrayContaining(['s3:PutObject', 'sqs:SendMessage']));
        expect(actions('api')).not.toContain('sqs:ReceiveMessage');
        expect(actions('worker')).toEqual(expect.arrayContaining(['s3:GetObject', 'sqs:ReceiveMessage', 'sqs:DeleteMessage']));
        // Handing a failed job back early (SqsJobQueue.release) changes its visibility.
        expect(actions('worker')).toContain('sqs:ChangeMessageVisibility');
        expect(actions('worker')).not.toContain('s3:PutObject');
        expect(actions('worker')).not.toContain('sqs:SendMessage');
        for (const name of ['api', 'worker'] as const) {
            expect(actions(name).filter((action) => action.endsWith('*'))).toEqual([]);
            expect(actions(name)).not.toContain('dynamodb:Scan');
        }
    });

    it('serves the site from S3 and sends only /api/* to the API, uncached', () => {
        template('web').hasResourceProperties('AWS::CloudFront::Distribution', {
            DistributionConfig: Match.objectLike({
                DefaultRootObject: 'index.html',
                DefaultCacheBehavior: Match.objectLike({
                    ViewerProtocolPolicy: 'redirect-to-https',
                    FunctionAssociations: [Match.objectLike({ EventType: 'viewer-request' })],
                }),
                CacheBehaviors: [
                    Match.objectLike({
                        PathPattern: '/api/*',
                        ViewerProtocolPolicy: 'https-only',
                        // CloudFront's managed CachingDisabled and AllViewerExceptHostHeader policies.
                        CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
                        OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac',
                    }),
                ],
            }),
        });
        // Error pages would replace the API's own 403 and 404 answers; the SPA fallback is the viewer function.
        const [distribution] = Object.values(template('web').findResources('AWS::CloudFront::Distribution'));
        expect(distribution.Properties.DistributionConfig.CustomErrorResponses).toBeUndefined();
        template('web').resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    });

    it('serves the app for every path that is not a file', () => {
        const handler = new Function(`${SPA_REWRITE}; return handler;`)() as (event: { request: { uri: string } }) => { uri: string };
        const rewrite = (uri: string) => handler({ request: { uri } }).uri;
        for (const page of ['/', '/lots/pklot-ufpr04', '/admin', '/admin/', '/admin/lots/drone_lot/mapping', '/signin']) {
            expect(rewrite(page)).toBe('/index.html');
        }
        for (const file of ['/index.html', '/sw.js', '/assets/index-ctaQRu_S.js', '/manifest.webmanifest', '/icons/icon-192.png']) {
            expect(rewrite(file)).toBe(file);
        }
    });

    it('can report content security policy violations instead of blocking them', () => {
        const reportOnly = Template.fromStack(synth({ 'Stack.Web.CspReportOnly': true }).web!);
        const [policy] = Object.values(reportOnly.findResources('AWS::CloudFront::ResponseHeadersPolicy'));
        const config = policy.Properties.ResponseHeadersPolicyConfig;
        expect(config.SecurityHeadersConfig.ContentSecurityPolicy).toBeUndefined();
        expect(config.CustomHeadersConfig.Items[0].Header).toBe('Content-Security-Policy-Report-Only');
        expect(config.SecurityHeadersConfig.StrictTransportSecurity).toBeDefined();
    });

    it('sends a content security policy that allows the photo bucket, Cognito and the font', () => {
        const [policy] = Object.values(template('web').findResources('AWS::CloudFront::ResponseHeadersPolicy'));
        const csp = JSON.stringify(policy.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy);
        expect(csp).toContain("default-src 'self'");
        expect(csp).toContain('https://cognito-idp.us-east-1.');
        // The service worker re-fetches the font, and a worker's fetch is checked against connect-src.
        expect(csp).toMatch(/connect-src [^;]*https:\/\/fonts\.googleapis\.com https:\/\/fonts\.gstatic\.com/);
        expect(csp).toMatch(/font-src [^;]*https:\/\/fonts\.gstatic\.com/);
        expect(csp).toContain("frame-ancestors 'none'");
    });

    it('alarms on dead-lettered jobs and budgets the month, emailing the address kept in SSM', () => {
        template('ops').resourceCountIs('AWS::CloudWatch::Alarm', 5);
        template('ops').hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName: 'ParkingProd-JobsDeadLettered' });
        // A job that fails on its last attempt never reaches the dead-letter queue: it is counted from the log.
        template('worker').hasResourceProperties('AWS::Logs::MetricFilter', {
            FilterPattern: '"exhausted retries"',
            MetricTransformations: [Match.objectLike({ MetricNamespace: 'ParkingProd', MetricName: 'JobsExhausted' })],
        });
        template('ops').hasResourceProperties('AWS::CloudWatch::Alarm', {
            AlarmName: 'ParkingProd-JobsExhausted',
            Namespace: 'ParkingProd',
            MetricName: 'JobsExhausted',
        });
        template('ops').resourceCountIs('AWS::Budgets::Budget', 2);
        template('ops').hasResourceProperties('AWS::Budgets::Budget', {
            Budget: Match.objectLike({ BudgetLimit: { Amount: 10, Unit: 'USD' }, TimeUnit: 'MONTHLY' }),
        });
        // The address is a deploy-time SSM lookup: it must not appear in any template of this public repository.
        const everything = JSON.stringify(Object.values(stacks).map((stack) => Template.fromStack(stack!).toJSON()));
        expect(everything).not.toMatch(/[\w.+-]+@[\w-]+\.(edu|com)/);
        expect(JSON.stringify(template('ops').toJSON().Parameters)).toContain('ParkingProd-AlertEmail');
    });

    it('trusts only the prod GitHub environment of this repository, and only to run cdk deploy', () => {
        template('cicd').hasResourceProperties('AWS::IAM::OIDCProvider', {
            Url: 'https://token.actions.githubusercontent.com',
            ClientIdList: ['sts.amazonaws.com'],
        });
        const [role] = Object.values(template('cicd').findResources('AWS::IAM::Role'));
        expect(role.Properties.RoleName).toBe('ParkingProd-GitHubDeploy');
        const [trust] = role.Properties.AssumeRolePolicyDocument.Statement;
        expect(trust.Action).toBe('sts:AssumeRoleWithWebIdentity');
        expect(trust.Condition).toEqual({
            StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub': 'repo:Njones27@153565100/CS498@1407666926:environment:prod',
            },
        });
        const statements = role.Properties.Policies[0].PolicyDocument.Statement as { Action: string; Resource: unknown }[];
        expect(statements.map((statement) => statement.Action).sort()).toEqual(['ssm:GetParameter', 'ssm:GetParameter', 'sts:AssumeRole']);
        const assumable = JSON.stringify(statements.find((statement) => statement.Action === 'sts:AssumeRole')!.Resource);
        for (const kind of CI_ASSUMABLE_CDK_ROLES) expect(assumable).toContain(`cdk-hnb659fds-${kind}-role-`);
        expect(assumable).not.toContain('cfn-exec-role');
    });
});

describe('the config file', () => {
    it('must be named', () => {
        expect(() => new AppContext({ appConfigFileKey: 'APP_CONFIG_UNSET' })).toThrow(/APP_CONFIG_UNSET is not set/);
    });

    it('rejects stacks it does not know', () => {
        const appContext = new AppContext({ appConfigFileKey: 'APP_CONFIG', appProps: { context: { APP_CONFIG: CONFIG } } });
        appContext.appConfig.Stack.Typo = { Name: 'ParkingProd-Typo', ShortStackName: 'Typo' };
        expect(() => createStacks(appContext)).toThrow(/Unknown stack key\(s\) Typo/);
    });
});
