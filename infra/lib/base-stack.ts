// What every stack shares: the project prefix for names, and SSM parameters as the only way stacks hand values to
// each other. A parameter is written by the stack that owns the resource and resolved by CloudFormation when a later
// stack deploys, so `cdk synth` needs no AWS access and no stack exports pin another stack's resources in place.
// The scripts in script/ and the deploy workflow read the same parameters.

import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';

import { AppContext, StackConfig } from './app-context';

export class BaseStack extends cdk.Stack {
    protected readonly stackConfig: StackConfig;
    protected readonly projectPrefix: string;

    constructor(appContext: AppContext, stackConfig: StackConfig) {
        super(appContext.cdkApp, stackConfig.Name, { env: appContext.env });
        this.stackConfig = stackConfig;
        this.projectPrefix = appContext.projectPrefix;
    }

    /** `ParkingProd-<baseName>`: the name of a resource or SSM parameter of this stage. */
    withProjectPrefix(baseName: string): string {
        return `${this.projectPrefix}-${baseName}`;
    }

    /** Publish a value for later stacks and the scripts as SSM parameter `<prefix>-<key>`. */
    putParameter(key: string, value: string): void {
        new ssm.StringParameter(this, `Param${key}`, {
            parameterName: this.withProjectPrefix(key),
            stringValue: value,
        });
    }

    /** A value an earlier stack (or setup_initial.sh) published, resolved when this stack deploys. */
    getParameter(key: string): string {
        return ssm.StringParameter.valueForStringParameter(this, this.withProjectPrefix(key));
    }
}
