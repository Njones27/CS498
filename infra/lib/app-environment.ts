// What the API and the worker have in common: the settings that point parking_core at this stage's resources
// (core/parking_core/settings.py) and the permissions to use them. Each function gets its own role with only the
// statements it needs.

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';

import { BaseStack } from './base-stack';

/** Environment variables `Settings` reads. Values are SSM parameters of the Data and Auth stacks. */
export function coreEnvironment(stack: BaseStack): Record<string, string> {
    return {
        APP_ENV: 'aws',
        AUTH_MODE: 'cognito',
        TABLE_NAME: stack.getParameter('TableName'),
        BUCKET_NAME: stack.getParameter('PhotoBucketName'),
        QUEUE_URL: stack.getParameter('JobQueueUrl'),
        // Not secrets. The worker checks no tokens, but one Settings class configures both functions.
        COGNITO_USER_POOL_ID: stack.getParameter('UserPoolId'),
        COGNITO_CLIENT_ID: stack.getParameter('UserPoolClientId'),
    };
}

/** Read and write items of the stage's table and its index. No table management, no scans. */
export function tableReadWrite(stack: BaseStack): iam.PolicyStatement {
    const tableArn = cdk.Arn.format({ service: 'dynamodb', resource: 'table', resourceName: stack.getParameter('TableName') }, stack);
    return new iam.PolicyStatement({
        sid: 'TableReadWrite',
        actions: [
            'dynamodb:GetItem',
            'dynamodb:Query',
            'dynamodb:PutItem',
            'dynamodb:UpdateItem',
            'dynamodb:DeleteItem',
            'dynamodb:BatchWriteItem',
            'dynamodb:ConditionCheckItem',
        ],
        resources: [tableArn, `${tableArn}/index/*`],
    });
}

/**
 * Objects of the photo bucket. ListBucket is what makes a missing key answer 404 instead of 403, which
 * `S3ObjectStore.head` and `.get` rely on.
 */
export function photoBucketAccess(stack: BaseStack, access: 'read' | 'readWrite'): iam.PolicyStatement[] {
    const bucketArn = `arn:${stack.partition}:s3:::${stack.getParameter('PhotoBucketName')}`;
    return [
        new iam.PolicyStatement({
            sid: 'PhotoObjects',
            actions: access === 'read' ? ['s3:GetObject'] : ['s3:GetObject', 's3:PutObject'],
            resources: [`${bucketArn}/*`],
        }),
        new iam.PolicyStatement({ sid: 'PhotoBucketList', actions: ['s3:ListBucket'], resources: [bucketArn] }),
    ];
}
