// The REST API: API Gateway HTTP API -> one Lambda running the FastAPI app through Mangum
// (api/parking_api/lambda_handler.py). CloudFront forwards the site's /api/* requests here with the prefix on, so
// the only route is `ANY /api/{proxy+}` and the browser never calls this API from another origin (no CORS).
//
// The app checks Cognito tokens itself instead of an API Gateway authorizer: its `session_expired` and `forbidden`
// error bodies are what the web app acts on, and the same code path runs locally.

import * as path from 'path';

import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';

import { AppContext, StackConfig } from '../lib/app-context';
import { coreEnvironment, photoBucketAccess, tableReadWrite } from '../lib/app-environment';
import { BaseStack } from '../lib/base-stack';
import { configEnvironment, configNumber, configString } from '../lib/config-values';

const INFRA_ROOT = path.resolve(__dirname, '..');

export class ApiStack extends BaseStack {
    public readonly handler: lambda.Function;
    public readonly httpApi: apigwv2.HttpApi;

    constructor(appContext: AppContext, stackConfig: StackConfig) {
        super(appContext, stackConfig);

        const retention = configNumber(stackConfig, 'LogRetentionDays', 30) as logs.RetentionDays;

        this.handler = new lambda.Function(this, 'Handler', {
            functionName: this.withProjectPrefix('Api'),
            description: 'Parking Availability REST API (FastAPI behind Mangum)',
            runtime: lambda.Runtime.PYTHON_3_12,
            architecture: lambda.Architecture.X86_64,
            handler: 'parking_api.lambda_handler.handler',
            // Built by script/build_api.sh: parking_api, parking_core and their locked dependencies.
            code: lambda.Code.fromAsset(path.resolve(INFRA_ROOT, configString(stackConfig, 'CodePath', '.build/api'))),
            // Completing a reference upload reads the whole photo (up to 15 MB) to hash and measure it.
            memorySize: configNumber(stackConfig, 'MemoryMb', 1024),
            // API Gateway gives up after 30 s.
            timeout: cdk.Duration.seconds(configNumber(stackConfig, 'TimeoutSeconds', 29)),
            environment: { ...coreEnvironment(this), ...configEnvironment(stackConfig) },
            logGroup: new logs.LogGroup(this, 'HandlerLogs', {
                logGroupName: `/aws/lambda/${this.withProjectPrefix('Api')}`,
                retention,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
        });
        this.handler.addToRolePolicy(tableReadWrite(this));
        // readWrite: publishing a layout stores its snapshot, and presigned PUT URLs carry this role's rights.
        for (const statement of photoBucketAccess(this, 'readWrite')) this.handler.addToRolePolicy(statement);
        this.handler.addToRolePolicy(
            new iam.PolicyStatement({ sid: 'EnqueueJobs', actions: ['sqs:SendMessage'], resources: [this.getParameter('JobQueueArn')] }),
        );

        this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
            apiName: this.withProjectPrefix('Api'),
            description: 'Parking Availability REST API, reached through CloudFront at /api',
            createDefaultStage: false,
        });
        this.httpApi.addRoutes({
            path: '/api/{proxy+}',
            methods: [apigwv2.HttpMethod.ANY],
            integration: new HttpLambdaIntegration('ApiIntegration', this.handler, {
                payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
            }),
        });

        const accessLogs = new logs.LogGroup(this, 'AccessLogs', { retention, removalPolicy: cdk.RemovalPolicy.DESTROY });
        new apigwv2.HttpStage(this, 'DefaultStage', {
            httpApi: this.httpApi,
            stageName: '$default',
            autoDeploy: true,
            // Bounds what a flood of requests can cost, and what the public lot routes can read per second.
            throttle: {
                rateLimit: configNumber(stackConfig, 'ThrottleRateLimit', 20),
                burstLimit: configNumber(stackConfig, 'ThrottleBurstLimit', 40),
            },
            accessLogSettings: {
                destination: new apigwv2.LogGroupLogDestination(accessLogs),
                format: cdk.aws_apigateway.AccessLogFormat.custom(
                    JSON.stringify({
                        requestId: '$context.requestId',
                        ip: '$context.identity.sourceIp',
                        time: '$context.requestTime',
                        method: '$context.httpMethod',
                        path: '$context.path',
                        status: '$context.status',
                        latencyMs: '$context.responseLatency',
                        integrationError: '$context.integrationErrorMessage',
                    }),
                ),
            },
        });

        this.putParameter('ApiId', this.httpApi.apiId);
        this.putParameter('ApiDomain', `${this.httpApi.apiId}.execute-api.${this.region}.${this.urlSuffix}`);
        this.putParameter('ApiFunctionName', this.handler.functionName);
    }
}
