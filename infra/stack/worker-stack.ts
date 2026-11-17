// The photo pipeline: the job queue feeds a Lambda built from worker/Dockerfile (target `lambda`), a container
// image because torch, the ACPDS model and YOLO26 do not fit a zip. It runs the same code as the local poller
// (worker/parking_worker/lambda_handler.py): alignment, scoring, state rules, status writes, and "Find stalls".

import * as path from 'path';

import * as cdk from 'aws-cdk-lib';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';

import { AppContext, StackConfig } from '../lib/app-context';
import { coreEnvironment, photoBucketAccess, tableReadWrite } from '../lib/app-environment';
import { BaseStack } from '../lib/base-stack';
import { configEnvironment, configNumber } from '../lib/config-values';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * The image's build context: only what worker/Dockerfile copies. A change anywhere else in the repository (the web
 * app, docs, this CDK app) leaves the image's hash alone, so a deploy does not rebuild and push 2 GB for it.
 */
export const WORKER_IMAGE_CONTEXT = [
    '*',
    '!pyproject.toml',
    '!uv.lock',
    '!.python-version',
    '!core',
    '!worker',
    '!api',
    'api/*',
    '!api/pyproject.toml',
    '!seed',
    'seed/*',
    '!seed/pyproject.toml',
    '!models',
    'models/*',
    '!models/manifest.json',
    '!scripts',
    'scripts/*',
    '!scripts/download_weights.py',
    'core/tests',
    'worker/tests',
    '**/__pycache__',
    '**/.pytest_cache',
    '**/.DS_Store',
];

/** Custom metric, in the namespace `<prefix>`, that the Ops stack alarms on. */
export const JOBS_EXHAUSTED_METRIC = 'JobsExhausted';

export class WorkerStack extends BaseStack {
    public readonly handler: lambda.DockerImageFunction;

    constructor(appContext: AppContext, stackConfig: StackConfig) {
        super(appContext, stackConfig);

        const timeout = cdk.Duration.seconds(configNumber(stackConfig, 'TimeoutSeconds', 240));

        this.handler = new lambda.DockerImageFunction(this, 'Handler', {
            functionName: this.withProjectPrefix('Worker'),
            description: 'Scores parking photos (ACPDS + YOLO26) and proposes stall layouts',
            code: lambda.DockerImageCode.fromImageAsset(REPO_ROOT, {
                file: 'worker/Dockerfile',
                target: 'lambda',
                buildArgs: { WORKER_EXTRAS: 'vision lambda' },
                // Same architecture as the CI timing gate (NFR-1) and the GitHub runners that build it.
                platform: Platform.LINUX_AMD64,
                exclude: WORKER_IMAGE_CONTEXT,
            }),
            architecture: lambda.Architecture.X86_64,
            // 3008 MB is the most a new account may configure. It comes with two cores at about 1.7 vCPUs of
            // time, a little under the 2 CPUs the NFR-1 gate times (peak RSS there: 1.3 GB).
            memorySize: configNumber(stackConfig, 'MemoryMb', 3008),
            // A photo takes 5 to 20 s. The first invocation on a newly pushed image took 80 s before that, most
            // of it Lambda fetching torch and the weights from the image as they are first read.
            timeout,
            environment: { ...coreEnvironment(this), ...configEnvironment(stackConfig) },
            logGroup: new logs.LogGroup(this, 'HandlerLogs', {
                logGroupName: `/aws/lambda/${this.withProjectPrefix('Worker')}`,
                retention: configNumber(stackConfig, 'LogRetentionDays', 30) as logs.RetentionDays,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
        });
        this.handler.addToRolePolicy(tableReadWrite(this));
        for (const statement of photoBucketAccess(this, 'read')) this.handler.addToRolePolicy(statement);

        const jobQueue = sqs.Queue.fromQueueArn(this, 'JobQueue', this.getParameter('JobQueueArn'));
        this.handler.addEventSource(
            new SqsEventSource(jobQueue, {
                // One photo per invocation: a batch would share one timeout and one model pass gains nothing.
                batchSize: 1,
                // At most this many photos at once. It caps the cost of a burst of uploads, and unlike reserved
                // concurrency it works under a new account's concurrency quota of 10.
                maxConcurrency: configNumber(stackConfig, 'MaxConcurrency', 2),
                // The handler names the jobs to retry; without this a normal return deletes them.
                reportBatchItemFailures: true,
            }),
        );

        // A job that fails on its last attempt is marked FAILED and its message deleted: the function returns
        // normally and nothing reaches the dead-letter queue. The log line is the only trace, so count it
        // (worker/parking_worker/handler.py and proposals.py: "... exhausted retries ...").
        new logs.MetricFilter(this, 'JobsExhaustedMetric', {
            logGroup: this.handler.logGroup,
            filterPattern: logs.FilterPattern.literal('"exhausted retries"'),
            metricNamespace: this.projectPrefix,
            metricName: JOBS_EXHAUSTED_METRIC,
            metricValue: '1',
            defaultValue: 0,
        });

        this.putParameter('WorkerFunctionName', this.handler.functionName);
    }
}
