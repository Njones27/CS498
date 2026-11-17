// Watching the stage: alarms on the things that mean photos are not being scored or the API is failing, and
// monthly cost budgets (NFR-9). Both email the address script/setup_initial.sh stored in SSM, which keeps it out of
// this public repository.

import * as cdk from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';

import { AppContext, StackConfig } from '../lib/app-context';
import { BaseStack } from '../lib/base-stack';
import { configNumber, configNumberList } from '../lib/config-values';
import { JOBS_EXHAUSTED_METRIC } from './worker-stack';

const PERIOD = cdk.Duration.minutes(5);

export class OpsStack extends BaseStack {
    public readonly alarmTopic: sns.Topic;

    constructor(appContext: AppContext, stackConfig: StackConfig) {
        super(appContext, stackConfig);

        const alertEmail = this.getParameter('AlertEmail');

        this.alarmTopic = new sns.Topic(this, 'AlarmTopic', { topicName: this.withProjectPrefix('Alarms'), enforceSSL: true });
        // AWS emails the address a confirmation link the first time; alarms arrive once it is clicked.
        new sns.Subscription(this, 'AlarmEmail', {
            topic: this.alarmTopic,
            protocol: sns.SubscriptionProtocol.EMAIL,
            endpoint: alertEmail,
        });

        const lambdaErrors = (functionName: string) =>
            new cloudwatch.Metric({
                namespace: 'AWS/Lambda',
                metricName: 'Errors',
                dimensionsMap: { FunctionName: functionName },
                statistic: 'Sum',
                period: PERIOD,
            });

        // Reached when the worker is killed (timeout, out of memory) or cannot finish a job's bookkeeping on
        // every delivery. Such a job is left unfinished: look at the message, then use Retry on the snapshot.
        this.alarm('JobsDeadLettered', 'A job message was set aside after three deliveries the worker did not survive', {
            metric: new cloudwatch.Metric({
                namespace: 'AWS/SQS',
                metricName: 'ApproximateNumberOfMessagesVisible',
                dimensionsMap: { QueueName: this.getParameter('JobDeadLetterQueueName') },
                statistic: 'Maximum',
                period: PERIOD,
            }),
            threshold: 1,
        });
        this.alarm('JobsExhausted', 'A photo or Find stalls job failed on all three attempts and was marked failed', {
            metric: new cloudwatch.Metric({
                namespace: this.projectPrefix,
                metricName: JOBS_EXHAUSTED_METRIC,
                statistic: 'Sum',
                period: PERIOD,
            }),
            threshold: 1,
        });
        this.alarm('WorkerErrors', 'The worker Lambda crashed or timed out', {
            metric: lambdaErrors(this.getParameter('WorkerFunctionName')),
            threshold: configNumber(stackConfig, 'WorkerErrorThreshold', 1),
        });
        this.alarm('ApiErrors', 'The API Lambda crashed or timed out', {
            metric: lambdaErrors(this.getParameter('ApiFunctionName')),
            threshold: configNumber(stackConfig, 'ApiErrorThreshold', 3),
        });
        this.alarm('Api5xx', 'The API answered with server errors', {
            metric: new cloudwatch.Metric({
                namespace: 'AWS/ApiGateway',
                metricName: '5xx',
                dimensionsMap: { ApiId: this.getParameter('ApiId') },
                statistic: 'Sum',
                period: PERIOD,
            }),
            threshold: configNumber(stackConfig, 'Api5xxThreshold', 5),
        });

        for (const limit of configNumberList(stackConfig, 'MonthlyBudgetsUsd', [10, 25])) {
            const subscribers = [{ subscriptionType: 'EMAIL', address: alertEmail }];
            new budgets.CfnBudget(this, `Budget${limit}Usd`, {
                budget: {
                    budgetName: this.withProjectPrefix(`Monthly-${limit}-USD`),
                    budgetType: 'COST',
                    timeUnit: 'MONTHLY',
                    budgetLimit: { amount: limit, unit: 'USD' },
                },
                notificationsWithSubscribers: [
                    {
                        notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80, thresholdType: 'PERCENTAGE' },
                        subscribers,
                    },
                    {
                        notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' },
                        subscribers,
                    },
                ],
            });
        }
    }

    private alarm(name: string, description: string, props: { metric: cloudwatch.Metric; threshold: number }): void {
        const alarm = new cloudwatch.Alarm(this, name, {
            alarmName: this.withProjectPrefix(name),
            alarmDescription: description,
            metric: props.metric,
            threshold: props.threshold,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            // No requests and an empty queue report nothing, which is fine.
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });
        alarm.addAlarmAction(new SnsAction(this.alarmTopic));
    }
}
