// Instantiates the stacks the loaded config lists under `Stack`. Stacks share values through SSM parameters that
// CloudFormation resolves at deploy time, so the explicit dependencies below are what makes `cdk deploy` run them
// in order: Data -> Auth -> Api -> Worker -> Web -> Ops. Cicd stands alone (script/setup_initial.sh).

import * as cdk from 'aws-cdk-lib';

import { AppContext } from './app-context';
import { configNumber } from './config-values';
import { ApiStack } from '../stack/api-stack';
import { AuthStack } from '../stack/auth-stack';
import { CicdStack } from '../stack/cicd-stack';
import { DataStack } from '../stack/data-stack';
import { OpsStack } from '../stack/ops-stack';
import { WebStack } from '../stack/web-stack';
import { WorkerStack } from '../stack/worker-stack';

export interface ParkingStacks {
    cicd?: CicdStack;
    data?: DataStack;
    auth?: AuthStack;
    api?: ApiStack;
    worker?: WorkerStack;
    web?: WebStack;
    ops?: OpsStack;
}

/** The stage stacks in deploy order. Keep in step with script/lib.sh and .github/workflows/deploy-stage.yml. */
export const STAGE_STACKS = ['Data', 'Auth', 'Api', 'Worker', 'Web', 'Ops'] as const;
const KNOWN_STACKS: readonly string[] = ['Cicd', ...STAGE_STACKS];

export function createStacks(appContext: AppContext): ParkingStacks {
    const { Project, Stack } = appContext.appConfig;

    const unknown = Object.keys(Stack).filter((key) => !KNOWN_STACKS.includes(key));
    if (unknown.length > 0) {
        throw new Error(`[config] Unknown stack key(s) ${unknown.join(', ')}; expected some of ${KNOWN_STACKS.join(', ')}`);
    }
    if (Stack.Data && Stack.Worker) {
        // SQS refuses an event source whose function can outlive the queue's visibility timeout.
        const visibility = configNumber(Stack.Data, 'JobVisibilityTimeoutSeconds', 300);
        const timeout = configNumber(Stack.Worker, 'TimeoutSeconds', 240);
        if (visibility < timeout) {
            throw new Error(`[config] Data.JobVisibilityTimeoutSeconds (${visibility}) must be at least Worker.TimeoutSeconds (${timeout})`);
        }
    }

    const stacks: ParkingStacks = {
        cicd: Stack.Cicd && new CicdStack(appContext, Stack.Cicd),
        data: Stack.Data && new DataStack(appContext, Stack.Data),
        auth: Stack.Auth && new AuthStack(appContext, Stack.Auth),
        api: Stack.Api && new ApiStack(appContext, Stack.Api),
        worker: Stack.Worker && new WorkerStack(appContext, Stack.Worker),
        web: Stack.Web && new WebStack(appContext, Stack.Web),
        ops: Stack.Ops && new OpsStack(appContext, Stack.Ops),
    };

    const ordered = [stacks.data, stacks.auth, stacks.api, stacks.worker, stacks.web, stacks.ops].filter(
        (stack): stack is NonNullable<typeof stack> => stack !== undefined,
    );
    for (let i = 1; i < ordered.length; i++) {
        ordered[i].addStackDependency(ordered[i - 1], `${ordered[i - 1].stackName} writes SSM parameters it reads`);
    }

    cdk.Tags.of(appContext.cdkApp).add('Project', Project.Name);
    cdk.Tags.of(appContext.cdkApp).add('Stage', Project.Stage);

    return stacks;
}
