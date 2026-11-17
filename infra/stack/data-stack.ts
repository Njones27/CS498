// The stage's state: the DynamoDB table, the photo bucket and the job queue with its dead-letter queue. These are the
// AWS versions of what `ensure_resources` (core/parking_core/adapters/aws.py) creates on the local emulators; keep
// the table's keys and index in step with it.

import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';

import { AppContext, StackConfig } from '../lib/app-context';
import { BaseStack } from '../lib/base-stack';
import { configBoolean, configNumber, configStringList } from '../lib/config-values';

/**
 * Deliveries before SQS sets a message aside. More than the worker's own limit (MAX_ATTEMPTS = 3 in
 * worker/parking_worker/handler.py), which marks a job failed and deletes its message: a delivery that never ran
 * the job (not claimable yet, a killed invocation) counts here too and must not cost the job its last attempt.
 */
export const MAX_RECEIVE_COUNT = 5;

export class DataStack extends BaseStack {
    public readonly table: dynamodb.Table;
    public readonly photoBucket: s3.Bucket;
    public readonly jobQueue: sqs.Queue;
    public readonly deadLetterQueue: sqs.Queue;

    constructor(appContext: AppContext, stackConfig: StackConfig) {
        super(appContext, stackConfig);

        // Lots, layouts, photos' records and statuses outlive a stack that is deleted by mistake.
        const retain = configBoolean(stackConfig, 'RetainOnDelete', true);
        const removalPolicy = retain ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

        this.table = new dynamodb.Table(this, 'Table', {
            partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            timeToLiveAttribute: 'expiresAt',
            pointInTimeRecoverySpecification: {
                pointInTimeRecoveryEnabled: configBoolean(stackConfig, 'PointInTimeRecovery', true),
            },
            deletionProtection: retain,
            removalPolicy,
        });
        this.table.addGlobalSecondaryIndex({
            indexName: 'GSI1',
            partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // Browsers PUT photos straight to presigned URLs and read them back into a canvas, so the bucket answers
        // CORS for the site's origin. The distribution's domain only exists once the Web stack has deployed, after
        // this one: until PhotoCorsOrigins names it, any CloudFront site passes the CORS check. The presigned URL's
        // signature is what authorizes a request either way.
        const corsOrigins = configStringList(stackConfig, 'PhotoCorsOrigins', ['https://*.cloudfront.net']);
        const rawPhotoExpiryDays = configNumber(stackConfig, 'RawPhotoExpiryDays', 0);
        this.photoBucket = new s3.Bucket(this, 'PhotoBucket', {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            removalPolicy,
            cors: [
                {
                    allowedOrigins: corsOrigins,
                    allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
                    allowedHeaders: ['*'],
                    exposedHeaders: ['ETag'],
                    maxAge: 3000,
                },
            ],
            lifecycleRules: [
                { id: 'AbortStalledUploads', abortIncompleteMultipartUploadAfter: cdk.Duration.days(1) },
                // Off by default: the snapshot pages show a photo for as long as its record exists.
                ...(rawPhotoExpiryDays > 0
                    ? [{ id: 'ExpireRawPhotos', prefix: 'raw/', expiration: cdk.Duration.days(rawPhotoExpiryDays) }]
                    : []),
            ],
        });

        this.deadLetterQueue = new sqs.Queue(this, 'JobDeadLetterQueue', {
            retentionPeriod: cdk.Duration.days(14),
            enforceSSL: true,
        });
        this.jobQueue = new sqs.Queue(this, 'JobQueue', {
            // Longer than the worker's timeout, so a job still running is never delivered to a second worker.
            // A job that fails is handed back sooner by the worker itself (parking_worker.lambda_handler); a
            // worker that is killed mid-job hands nothing back, and its job waits this long for the next try.
            visibilityTimeout: cdk.Duration.seconds(configNumber(stackConfig, 'JobVisibilityTimeoutSeconds', 300)),
            deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: MAX_RECEIVE_COUNT },
            enforceSSL: true,
        });

        this.putParameter('TableName', this.table.tableName);
        this.putParameter('PhotoBucketName', this.photoBucket.bucketName);
        this.putParameter('JobQueueUrl', this.jobQueue.queueUrl);
        this.putParameter('JobQueueArn', this.jobQueue.queueArn);
        this.putParameter('JobDeadLetterQueueName', this.deadLetterQueue.queueName);
    }
}
