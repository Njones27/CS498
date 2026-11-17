# Infrastructure (Phase 2, AWS)

The AWS version of the local Docker Compose stack, as an AWS CDK v2 app in TypeScript. Its layout follows
[telemachus](https://github.com/KentuckySolarCar/telemachus) and [AWS_Spark](https://github.com/Njones27/AWS_Spark):
one JSON config per stage, a stack per concern, and GitHub Actions deploying through OIDC with no stored keys.

`infra/local/` is unrelated to CDK: it holds the ElasticMQ config of the local stack.

## What runs where

```
browser ── CloudFront ──┬── S3 site bucket (web/dist)                      Web
                        └── /api/* ── API Gateway HTTP API ── API Lambda   Api
browser ── presigned URLs ── S3 photo bucket                               Data
browser ── sign-in ── Cognito user pool                                    Auth
API Lambda ── SQS job queue ── worker Lambda (container image)             Data, Worker
both Lambdas ── DynamoDB table                                             Data
```

| Local (docker-compose.yml) | AWS | Stack |
|---|---|---|
| `web` (Vite dev server) | S3 + CloudFront | `ParkingProd-Web` |
| `api` (uvicorn) | API Gateway HTTP API + Lambda (zip, Mangum) | `ParkingProd-Api` |
| `worker` (queue poller) | Lambda container image with the ACPDS and YOLO26 weights, SQS trigger | `ParkingProd-Worker` |
| `rustfs`, `elasticmq`, `dynamodb-local` | S3, SQS + dead-letter queue, DynamoDB | `ParkingProd-Data` |
| dev login (`AUTH_MODE=dev`) | Cognito user pool, `admin` group | `ParkingProd-Auth` |
| none | CloudWatch alarms, monthly budgets | `ParkingProd-Ops` |
| none | GitHub OIDC provider and deploy role | `ParkingProd-Cicd` |

There is one stage, `Prod`, in one account (`config/app-config-prod.json`). Stack and resource names start with
`<Name><Stage>`, so a second stage would be a second config file.

Stacks pass values to each other through SSM parameters named `ParkingProd-<Key>`, resolved when a stack deploys,
never through CloudFormation exports. `cdk synth` therefore needs no AWS access, and the scripts and the smoke test
read the same parameters:

| Parameter | Written by | Read by |
|---|---|---|
| `TableName`, `PhotoBucketName`, `JobQueueUrl`, `JobQueueArn`, `JobDeadLetterQueueName` | Data | Api, Worker, Web, Ops, `seed.sh` |
| `UserPoolId`, `UserPoolClientId` | Auth | Api, Worker, `seed.sh`, `create_user.sh` |
| `ApiId`, `ApiDomain`, `ApiFunctionName` | Api | Web, Ops |
| `WorkerFunctionName` | Worker | Ops |
| `DistributionDomain`, `DistributionId` | Web | smoke test, scripts |
| `DeployRoleArn` | Cicd | `setup_initial.sh` |
| `AlertEmail` | `setup_initial.sh` (not CDK) | Ops |

## How deploys flow

```
pull request ─ ci.yml ─ `infra` job: typecheck, tests, build, cdk synth   (no AWS access)
                      └ `worker-vision-image` job: builds the Lambda image target too
merge to main ─ ci.yml passes ─ deploy.yml ─ deploy-stage.yml (environment prod)
                 ├ build web/dist and the API code
                 ├ assume ParkingProd-GitHubDeploy through OIDC
                 ├ cdk deploy Data Auth Api Worker Web Ops
                 └ smoke test: /api/health, /api/auth/config, /api/lots, /, /admin
```

Nothing reaches AWS before it is merged, and a commit on `main` deploys only after its CI run passed. The deploy
role itself may only assume the CDK bootstrap roles, and its trust policy names this repository's `prod`
environment, which `setup_initial.sh` has you limit to the `main` branch. The workflow never deploys the Cicd stack.

That is a boundary around the pipeline, not around what gets merged: `cdk deploy` runs CloudFormation with
administrator rights (see Security notes), so whoever can merge to `main` can change anything in the account,
this role included. Protect `main` (required reviews and required CI checks) accordingly.

The worker image is about 2 GB (torch, torchvision, Ultralytics, 190 MB of weights). Its build context is only what
`worker/Dockerfile` copies, so it is rebuilt and pushed when `core/`, `worker/`, `uv.lock` or the weight manifest
change, and reused otherwise.

## One-time setup

With administrator credentials for the account (`aws sso login --profile cs498`), Node 24, uv and Docker:

```bash
cd infra && npm ci
```

```bash
ALERT_EMAIL=you@example.edu infra/script/setup_initial.sh config/app-config-prod.json
```

That bootstraps CDK, stores the alert address in SSM, deploys `ParkingProd-Cicd` and prints the `gh` commands
that create the GitHub environment `prod` with its four variables (`AWS_DEPLOY_ROLE_ARN`, `AWS_REGION`,
`AWS_ACCOUNT_ID`, `APP_CONFIG`). There are no secrets to set.

First deploy, and any deploy from a laptop afterwards (the workflow is the normal path):

```bash
infra/script/deploy_stacks.sh config/app-config-prod.json
```

Then give yourself a sign-in and, if you want sample data, load a lot:

```bash
infra/script/create_user.sh config/app-config-prod.json you@example.edu --admin
```

```bash
infra/script/seed.sh config/app-config-prod.json --lot pklot-ufpr04
```

`Stack.Data.PhotoCorsOrigins` names the site's origin. In a new account, put the distribution's domain there
after the first deploy (it only exists then) and deploy again: without the key the photo bucket's CORS rule
accepts any CloudFront site. AWS also emails the alert address a link that must be clicked before alarms are
delivered.

## Config keys (`config/app-config-prod.json`)

| Key | Meaning |
|---|---|
| `Project.Name`, `Stage`, `Account`, `Region` | The stage. `Profile` is the AWS CLI profile the scripts use on a laptop. |
| `Cicd.GitHubRepo`, `GitHubEnvironment`, `GitHubSubjectPrefix` | Who may assume the deploy role. Read the prefix with `gh api repos/<owner>/<repo>/actions/oidc/customization/sub`. |
| `Data.RetainOnDelete`, `PointInTimeRecovery` | Keep the table and photo bucket when the stack is deleted; table backups. |
| `Data.JobVisibilityTimeoutSeconds` | How long a job is hidden while a worker has it, and so how long a job waits after a worker was killed mid-run. At least `Worker.TimeoutSeconds`. |
| `Data.PhotoCorsOrigins` | Origins allowed to upload to and read from the photo bucket. |
| `Data.RawPhotoExpiryDays` | Delete uploaded photos after this many days. 0 keeps them. |
| `Auth.SessionMinutes` | Lifetime of a sign-in. |
| `Api.ThrottleRateLimit`, `ThrottleBurstLimit` | Requests per second the API accepts, for every caller together. |
| `Worker.MemoryMb`, `TimeoutSeconds`, `MaxConcurrency` | Size of the worker Lambda and how many photos it scores at once. |
| `Worker.Environment`, `Api.Environment` | Extra settings for `parking_core.settings` (`DETECTOR`, `ALIGNER`, `YOLO_IMGSZ`, cutoffs). |
| `Web.CspReportOnly` | Report content security policy violations instead of blocking them. |
| `Ops.MonthlyBudgetsUsd`, `*Threshold` | Budget amounts (alerts at 80% spent and at 100% forecast) and alarm thresholds. |

## What it costs

Everything is pay-per-use and a pilot stays inside the free tiers apart from a few dollars: the worker images in
ECR (about $0.20 a month each, five kept), five CloudWatch alarms ($0.10 each), one custom metric ($0.30) and Lambda time for scoring (a
photo takes 10 to 20 s at 3 GB, about $0.001). The budgets email at 80% of $10 and of $25.

## How fast photos are scored

Measured on the deployed stage with the PKLot fixture (27 stalls): a warm worker finishes a photo 5 s after it is
queued (4 to 6 s of processing, 1.3 GB peak memory). The first photo after a deploy that changed the worker
image, or after the worker has been idle long enough for Lambda to retire it, takes about 90 s instead: Lambda
fetches torch and the weights out of the 2 GB image as they are first read, then the models load. The snapshot
shows as queued and then processing meanwhile; nothing is lost. `Worker.TimeoutSeconds` (240) leaves room for it.

A new account starts with a Lambda concurrency quota of 10. The worker uses at most `MaxConcurrency` (2) of it and
the API the rest; `setup_initial.sh` prints the command that requests the usual 1000.

## Alarms

All five email the alert address: `JobsExhausted` (a photo or Find stalls job failed on all three attempts and
was marked failed), `JobsDeadLettered` (a job's message was set aside after five deliveries because the worker kept being killed; that job is left unfinished, so use Retry on its snapshot), `WorkerErrors`, `ApiErrors` and `Api5xx`.

## Security notes

- The API verifies Cognito ID tokens itself (`core/parking_core/auth.py`): signature against the pool's keys,
  issuer, audience, `token_use`, and a verified email (`create_user.sh` marks it verified, also when re-run for an existing account). The dev login and its public secret cannot run here: `APP_ENV=aws` refuses
  `AUTH_MODE=dev`, and `/auth/login` answers 404.
- Accounts are created by an administrator only. The web client has no secret and allows the password flow only.
  The `admin` group is read from the token, so removing someone from it (or disabling them) takes effect when
  their current sign-in ends, at most `Auth.SessionMinutes` later.
- The API throttle (`Api.ThrottleRateLimit`) is one limit for all callers together: it caps cost and load, but one
  client at 20 requests a second makes the API answer 429 to everyone else. A per-client limit needs AWS WAF in
  front of CloudFront.
- The API and the worker have separate roles: the API may write photos and enqueue jobs, the worker may read
  photos and consume jobs, both may read and write items of the one table. Neither may scan or manage it.
- Both buckets block public access and require TLS. The site bucket is readable only by the distribution (OAC).
- `cdk bootstrap` is the default one, so CloudFormation deploys with administrator rights, as in telemachus.
  AWS_Spark's least-privilege execution policies and permissions boundaries would be the next step.
- The API Gateway endpoint is also reachable directly, not only through CloudFront. It has the same throttling and
  the same token checks; AWS_Spark's origin-verify header would close that path.

## Teardown

```bash
infra/script/destroy_stacks.sh config/app-config-prod.json
```

It asks for the stage name first and lists what it leaves behind on purpose: the table, the photo bucket and the
user pool (all with deletion protection), the alert address and the CDK bootstrap stack.
