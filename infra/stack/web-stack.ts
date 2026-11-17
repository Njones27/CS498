// The site: a private S3 bucket with the built web app (web/dist) behind CloudFront, which also forwards /api/* to
// the HTTP API. One origin for pages and API means no CORS, and the service worker's /api/lots cache rules
// (web/public/sw.js) work unchanged.

import * as path from 'path';

import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';

import { AppContext, StackConfig } from '../lib/app-context';
import { BaseStack } from '../lib/base-stack';
import { configBoolean, configString } from '../lib/config-values';

const INFRA_ROOT = path.resolve(__dirname, '..');

/**
 * The web app routes in the browser (/lots/abc, /admin/upload), so any path that is not a file is the app itself.
 * A viewer-request function on the S3 behavior only: CloudFront's custom error responses would apply to /api/* as
 * well and turn the API's 403 and 404 answers into the home page.
 */
export const SPA_REWRITE = `
function handler(event) {
    var request = event.request;
    var lastSegment = request.uri.substring(request.uri.lastIndexOf('/') + 1);
    if (lastSegment.indexOf('.') === -1) {
        request.uri = '/index.html';
    }
    return request;
}
`;

export class WebStack extends BaseStack {
    public readonly siteBucket: s3.Bucket;
    public readonly distribution: cloudfront.Distribution;

    constructor(appContext: AppContext, stackConfig: StackConfig) {
        super(appContext, stackConfig);

        const distPath = path.resolve(INFRA_ROOT, configString(stackConfig, 'DistPath', '../web/dist'));
        const photoBucket = this.getParameter('PhotoBucketName');

        // Holds nothing but build output, so it goes when the stack goes.
        this.siteBucket = new s3.Bucket(this, 'SiteBucket', {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        // Photos are uploaded to and read from the photo bucket's presigned URLs, sign-in goes to Cognito, and the
        // font comes from Google Fonts (web/index.html). boto3 signs us-east-1 URLs for either S3 hostname.
        // The service worker (web/public/sw.js) re-fetches every GET the page makes, and a worker's fetch is
        // checked against connect-src whatever the resource is, so the font hosts are listed there as well.
        const fontHosts = 'https://fonts.googleapis.com https://fonts.gstatic.com';
        const photoHosts = `https://${photoBucket}.s3.${this.region}.${this.urlSuffix} https://${photoBucket}.s3.${this.urlSuffix}`;
        const csp = [
            "default-src 'self'",
            `img-src 'self' data: blob: ${photoHosts}`,
            `connect-src 'self' ${photoHosts} ${fontHosts} https://cognito-idp.${this.region}.${this.urlSuffix}`,
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com",
            "script-src 'self'",
            "worker-src 'self'",
            "manifest-src 'self'",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        ].join('; ');
        const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
            responseHeadersPolicyName: this.withProjectPrefix('SecurityHeaders'),
            securityHeadersBehavior: {
                strictTransportSecurity: { accessControlMaxAge: cdk.Duration.days(365), includeSubdomains: true, override: true },
                contentTypeOptions: { override: true },
                frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
                referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
                contentSecurityPolicy: { contentSecurityPolicy: csp, override: true },
            },
        });
        // CspReportOnly: browsers report what the policy would block without blocking it, to try a policy change.
        if (configBoolean(stackConfig, 'CspReportOnly', false)) {
            const cfn = securityHeaders.node.defaultChild as cloudfront.CfnResponseHeadersPolicy;
            cfn.addPropertyDeletionOverride('ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy');
            cfn.addPropertyOverride('ResponseHeadersPolicyConfig.CustomHeadersConfig.Items', [
                { Header: 'Content-Security-Policy-Report-Only', Value: csp, Override: true },
            ]);
        }

        this.distribution = new cloudfront.Distribution(this, 'Distribution', {
            comment: `${this.projectPrefix} web app and API`,
            defaultRootObject: 'index.html',
            httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
            priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
            defaultBehavior: {
                origin: origins.S3BucketOrigin.withOriginAccessControl(this.siteBucket),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
                responseHeadersPolicy: securityHeaders,
                functionAssociations: [
                    {
                        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                        function: new cloudfront.Function(this, 'SpaRewrite', {
                            functionName: this.withProjectPrefix('SpaRewrite'),
                            code: cloudfront.FunctionCode.fromInline(SPA_REWRITE),
                            runtime: cloudfront.FunctionRuntime.JS_2_0,
                        }),
                    },
                ],
            },
            additionalBehaviors: {
                '/api/*': {
                    origin: new origins.HttpOrigin(this.getParameter('ApiDomain'), {
                        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
                    }),
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
                    allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                    // Never cached at the edge; the Authorization header and query string reach the API as sent.
                    cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
                    originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
                    // HSTS, nosniff and the like on API answers too (CloudFront's managed policy; no CSP needed
                    // for JSON).
                    responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
                },
            },
        });

        // Vite gives everything under assets/ a content hash in its name, so those never change. The rest
        // (index.html, sw.js, the manifest, icons) keep their names and must be checked again on every visit.
        // prune: false keeps the previous build's assets for pages still open in someone's browser.
        const hashedAssets = new s3deploy.BucketDeployment(this, 'DeployHashedAssets', {
            sources: [s3deploy.Source.asset(distPath)],
            destinationBucket: this.siteBucket,
            exclude: ['*'],
            include: ['assets/*'],
            cacheControl: [s3deploy.CacheControl.fromString('public, max-age=31536000, immutable')],
            prune: false,
        });
        const entryFiles = new s3deploy.BucketDeployment(this, 'DeployEntryFiles', {
            sources: [s3deploy.Source.asset(distPath)],
            destinationBucket: this.siteBucket,
            exclude: ['assets/*'],
            cacheControl: [s3deploy.CacheControl.fromString('public, max-age=0, must-revalidate')],
            prune: false,
            distribution: this.distribution,
            distributionPaths: ['/*'],
        });
        // index.html goes live only after the assets it points at.
        entryFiles.node.addDependency(hashedAssets);

        this.putParameter('DistributionDomain', this.distribution.distributionDomainName);
        this.putParameter('DistributionId', this.distribution.distributionId);
        new cdk.CfnOutput(this, 'SiteUrl', { value: `https://${this.distribution.distributionDomainName}` });
    }
}
