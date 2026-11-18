// Sign-in (AUTH_MODE=cognito): a user pool whose `admin` group marks the people allowed to use /admin. Accounts are
// created by an administrator (script/create_user.sh), never by signing up. The web app's own form sends the email
// and password straight to the pool and uses the ID token it gets back as the API's bearer token
// (web/src/auth/cognito.ts, core/parking_core/auth.py).

import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';

import { AppContext, StackConfig } from '../lib/app-context';
import { BaseStack } from '../lib/base-stack';
import { configBoolean, configNumber } from '../lib/config-values';

/** The group the API treats as administrators (`Principal.is_admin`). */
export const ADMIN_GROUP = 'admin';

export class AuthStack extends BaseStack {
    public readonly userPool: cognito.UserPool;
    public readonly webClient: cognito.UserPoolClient;

    constructor(appContext: AppContext, stackConfig: StackConfig) {
        super(appContext, stackConfig);

        const retain = configBoolean(stackConfig, 'RetainOnDelete', true);
        const sessionMinutes = configNumber(stackConfig, 'SessionMinutes', 60);

        this.userPool = new cognito.UserPool(this, 'UserPool', {
            userPoolName: this.withProjectPrefix('Users'),
            selfSignUpEnabled: false,
            signInAliases: { email: true },
            signInCaseSensitive: false,
            standardAttributes: { email: { required: true, mutable: true } },
            passwordPolicy: { minLength: 12, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: false },
            accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
            deletionProtection: retain,
            removalPolicy: retain ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        });

        new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
            userPoolId: this.userPool.userPoolId,
            groupName: ADMIN_GROUP,
            description: 'May use the /admin console and the /admin API routes',
        });

        this.webClient = this.userPool.addClient('WebClient', {
            userPoolClientName: this.withProjectPrefix('Web'),
            // A browser cannot keep a secret; the password flow is the one the site's own form uses.
            generateSecret: false,
            authFlows: { userPassword: true },
            disableOAuth: true,
            // The same answer for a wrong password and an unknown email.
            preventUserExistenceErrors: true,
            // The web app keeps the ID token for one session and signs in again when it expires, like the dev tokens.
            idTokenValidity: cdk.Duration.minutes(sessionMinutes),
            accessTokenValidity: cdk.Duration.minutes(sessionMinutes),
            refreshTokenValidity: cdk.Duration.minutes(Math.max(60, sessionMinutes)),
            enableTokenRevocation: true,
        });

        this.putParameter('UserPoolId', this.userPool.userPoolId);
        this.putParameter('UserPoolClientId', this.webClient.userPoolClientId);
    }
}
