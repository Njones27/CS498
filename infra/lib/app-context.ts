// Loads one config file (config/app-config-<stage>.json) and derives the project prefix every stack and resource
// name starts with. Same shape as telemachus and AWS_Spark, which follow aws-samples/aws-cdk-project-template-for-devops
// (lib/template/app-context.ts), cut down to what this app uses.
//
// Pick the config with `-c APP_CONFIG=config/app-config-prod.json` or `export APP_CONFIG=...`.

import * as fs from 'fs';
import * as cdk from 'aws-cdk-lib';

export interface ProjectConfig {
    Name: string;
    Stage: string;
    Account: string;
    Region: string;
    /** AWS CLI profile the scripts in script/ use on a laptop. CI ignores it. */
    Profile?: string;
}

export interface StackConfig {
    /** Full stack name once AppContext has added the project prefix, e.g. `ParkingProd-Web`. */
    Name: string;
    /** The name as written in the config file, e.g. `Web`. */
    ShortStackName: string;
    [key: string]: unknown;
}

export interface AppConfig {
    Project: ProjectConfig;
    Stack: Record<string, StackConfig>;
}

export class AppContextError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AppContextError';
    }
}

export interface AppContextProps {
    /** Context key or environment variable holding the config file path. */
    appConfigFileKey: string;
    /** Dotted config keys that `-c Stack.Web.DistPath=...` may override. */
    contextArgs?: string[];
    /** Passed to `new cdk.App()`. Tests use it to inject context instead of the CLI. */
    appProps?: cdk.AppProps;
}

export class AppContext {
    public readonly cdkApp: cdk.App;
    public readonly appConfig: AppConfig;
    /** `<Name><Stage>`, e.g. `ParkingProd`. */
    public readonly projectPrefix: string;
    public readonly env: Required<cdk.Environment>;

    constructor(props: AppContextProps) {
        this.cdkApp = new cdk.App(props.appProps);

        const configPath: unknown = this.cdkApp.node.tryGetContext(props.appConfigFileKey) ?? process.env[props.appConfigFileKey];
        if (typeof configPath !== 'string' || configPath.length === 0) {
            throw new AppContextError(
                `${props.appConfigFileKey} is not set. Use -c ${props.appConfigFileKey}=config/app-config-prod.json or export it.`,
            );
        }

        this.appConfig = loadAppConfig(configPath);
        this.projectPrefix = `${this.appConfig.Project.Name}${this.appConfig.Project.Stage}`;
        this.env = { account: this.appConfig.Project.Account, region: this.appConfig.Project.Region };

        for (const key of props.contextArgs ?? []) this.overrideFromContext(key);
        for (const [key, stack] of Object.entries(this.appConfig.Stack)) {
            stack.ShortStackName = stack.Name ?? key;
            stack.Name = `${this.projectPrefix}-${stack.ShortStackName}`;
        }
    }

    private overrideFromContext(dottedKey: string) {
        const value: unknown = this.cdkApp.node.tryGetContext(dottedKey);
        if (value === undefined) return;
        const path = dottedKey.split('.');
        const last = path.pop() as string;
        let parent: unknown = this.appConfig;
        for (const part of path) parent = isRecord(parent) ? parent[part] : undefined;
        if (isRecord(parent)) parent[last] = value;
    }
}

function loadAppConfig(path: string): AppConfig {
    let config: AppConfig;
    try {
        config = JSON.parse(fs.readFileSync(path, 'utf8')) as AppConfig;
    } catch (e) {
        throw new AppContextError(`Could not read the config file ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const key of ['Name', 'Stage', 'Account', 'Region'] as const) {
        if (typeof config.Project?.[key] !== 'string' || config.Project[key].length === 0) {
            throw new AppContextError(`Project.${key} is missing in ${path}`);
        }
    }
    if (!isRecord(config.Stack)) throw new AppContextError(`Stack is missing in ${path}`);
    return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
