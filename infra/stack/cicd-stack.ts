// How GitHub Actions reaches this account: GitHub's OIDC provider and one role the deploy workflow assumes. No
// access keys are stored anywhere. The role can only hand the deploy over to the CDK bootstrap roles, so CI is
// bounded by what `cdk deploy` does.
//
// Deployed by hand by script/setup_initial.sh with administrator credentials, never by the workflow: CI does not
// get to change its own trust or permissions.

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';

import { AppContext, StackConfig } from '../lib/app-context';
import { BaseStack } from '../lib/base-stack';
import { configString } from '../lib/config-values';

const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';

/** Default CDK bootstrap qualifier (`cdk bootstrap` without `--qualifier`). */
const CDK_QUALIFIER = 'hnb659fds';

/**
 * The bootstrap roles CI may assume: deploy (CloudFormation), file-publishing (the API zip and web/dist) and
 * image-publishing (the worker image). Not lookup: the app does no context lookups.
 */
export const CI_ASSUMABLE_CDK_ROLES = ['deploy', 'file-publishing', 'image-publishing'] as const;

export class CicdStack extends BaseStack {
    public readonly deployRole: iam.Role;

    constructor(appContext: AppContext, stackConfig: StackConfig) {
        super(appContext, stackConfig);

        const repo = configString(stackConfig, 'GitHubRepo');
        const environment = configString(stackConfig, 'GitHubEnvironment');
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`[config] Cicd.GitHubRepo must be owner/name (got ${repo})`);
        // GitHub's token `sub` starts with `repo:<owner>/<repo>`, or `repo:<owner>@<id>/<repo>@<id>` for repositories
        // on immutable subjects. Read the real prefix with
        // `gh api repos/<owner>/<repo>/actions/oidc/customization/sub` (field sub_claim_prefix).
        const subjectPrefix = configString(stackConfig, 'GitHubSubjectPrefix', `repo:${repo}`);
        if (!subjectPrefix.startsWith('repo:')) throw new Error('[config] Cicd.GitHubSubjectPrefix must start with repo:');

        const provider = new iam.CfnOIDCProvider(this, 'GitHubOidcProvider', {
            url: `https://${GITHUB_OIDC_HOST}`,
            clientIdList: ['sts.amazonaws.com'],
        });

        const cdkRoleArns = CI_ASSUMABLE_CDK_ROLES.map(
            (kind) => `arn:${this.partition}:iam::${this.account}:role/cdk-${CDK_QUALIFIER}-${kind}-role-${this.account}-${this.region}`,
        );

        this.deployRole = new iam.Role(this, 'GitHubDeployRole', {
            roleName: this.withProjectPrefix('GitHubDeploy'),
            description: `GitHub Actions deploy role for ${repo}, environment ${environment}`,
            maxSessionDuration: cdk.Duration.hours(2),
            assumedBy: new iam.WebIdentityPrincipal(provider.attrArn, {
                // Exact match: only jobs that run in this repository's GitHub environment may assume the role.
                // The environment itself is limited to the main branch (script/setup_initial.sh prints how).
                StringEquals: {
                    [`${GITHUB_OIDC_HOST}:aud`]: 'sts.amazonaws.com',
                    [`${GITHUB_OIDC_HOST}:sub`]: `${subjectPrefix}:environment:${environment}`,
                },
            }),
            inlinePolicies: {
                CdkDeploy: new iam.PolicyDocument({
                    statements: [
                        new iam.PolicyStatement({ sid: 'AssumeCdkBootstrapRoles', actions: ['sts:AssumeRole'], resources: cdkRoleArns }),
                        new iam.PolicyStatement({
                            sid: 'ReadCdkBootstrapVersion',
                            actions: ['ssm:GetParameter'],
                            resources: [`arn:${this.partition}:ssm:${this.region}:${this.account}:parameter/cdk-bootstrap/${CDK_QUALIFIER}/version`],
                        }),
                        // The deploy workflow's smoke test looks up the site it just deployed.
                        new iam.PolicyStatement({
                            sid: 'ReadSmokeTestTarget',
                            actions: ['ssm:GetParameter'],
                            resources: [
                                `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter/${this.withProjectPrefix('DistributionDomain')}`,
                            ],
                        }),
                    ],
                }),
            },
        });

        this.putParameter('DeployRoleArn', this.deployRole.roleArn);
        new cdk.CfnOutput(this, 'DeployRoleArnOutput', { value: this.deployRole.roleArn });
    }
}
