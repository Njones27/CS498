#!/usr/bin/env node
// CDK entry point (cdk.json: `npx tsx app-main.ts`). Laid out like telemachus and AWS_Spark, after
// aws-samples/aws-cdk-project-template-for-devops: one JSON config per stage, picked with
// `-c APP_CONFIG=config/app-config-prod.json` or `export APP_CONFIG=...`.

import { AppContext, AppContextError } from './lib/app-context';
import { createStacks } from './lib/create-stacks';

try {
    const appContext = new AppContext({
        appConfigFileKey: 'APP_CONFIG',
        contextArgs: ['Stack.Web.DistPath', 'Stack.Api.CodePath'],
    });

    createStacks(appContext);
} catch (error) {
    if (error instanceof AppContextError) {
        console.error('[AppContextError]:', error.message);
    } else {
        console.error('[Error]:', error);
    }
    process.exitCode = 1;
}
