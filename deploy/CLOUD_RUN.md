# Deploying Virgil on Google Cloud Run

Virgil uses two Cloud Run resources:

- a service for the authenticated API and full-page experience;
- a Job for restartable, per-learner background processing.

Firestore stores learner boards, Firebase Authentication establishes browser
identity, Secret Manager supplies model and optional Drive credentials, and
Artifact Registry stores the two container images.

For the complete first-install sequence, including OAuth client creation and
extension packaging, start with [`INSTALL.md`](../INSTALL.md).

## Safety model

The deployment scripts are fail-closed:

- `--plan` prints the cloud actions and renders `*.plan.yaml` without applying
  resources;
- mutating commands require the exact opt-in `VIRGIL_DEPLOY=yes`;
- deployment-specific rendered files are ignored by Git;
- secret values are never accepted as command-line arguments by these scripts;
- the service and Job run as a dedicated service account;
- access is granted to the named secrets and Job instead of broad project roles;
- Firestore client access is denied; the server-side adapter uses its service
  account;
- the scripts do not grant public `allUsers` IAM access.

Review the generated plan before applying it.

## Required operator inputs

| Variable | Required | Purpose |
| :--- | :---: | :--- |
| `PROJECT_ID` | yes | Operator-owned Google Cloud project |
| `FIREBASE_API_KEY` | yes | Public Firebase Web application configuration |
| `GOOGLE_WEB_CLIENT_ID` | yes | OAuth client for the hosted web origin |
| `OWNER_EMAIL` | yes for a new install | Bootstraps the first installation owner |
| `REGION` | no | Cloud Run and Artifact Registry region; defaults to `us-central1` |
| `FIRESTORE_LOCATION` | no | Firestore database location; defaults to `nam5` |
| `BOARD_ID` | no | Board used only by the optional fixed-board Scheduler sweep |
| `NOTEBOOK_URL` | no | Notebook destination opened by the product |
| `ALLOWED_EMAILS` | no | Optional initial members or upgrade migration input |

The hosted web client and Chrome extension client are different OAuth
application types. Do not put the Chrome client ID into
`GOOGLE_WEB_CLIENT_ID`.

## Secret names

The default templates expect:

```text
virgil-gemini-api-key
virgil-gemini-api-key-free
virgil-notebook-drive-credential
```

Create those secrets before applying the resources. The first two may contain
the same Gemini key for a small installation. If managed Drive export is not in
use, store the literal `disabled` in the third secret.

The names can be overridden with `SECRET_NAME`, `FREE_SECRET_NAME`, and
`NOTEBOOK_DRIVE_SECRET_NAME`. Values remain in Secret Manager.

## Plan the deployment

Install dependencies and run the offline gate first:

```bash
npm ci
npm test
npm run check:public
npm run check:deps
```

Then render and review the cloud plan:

```bash
PROJECT_ID=your-project ./deploy/build.sh --plan

PROJECT_ID=your-project \
FIREBASE_API_KEY=your-public-web-api-key \
GOOGLE_WEB_CLIENT_ID=your-web-client-id \
OWNER_EMAIL=owner@example.com \
./deploy/apply.sh --plan
```

The plan route does not create, push, or replace cloud resources.

## Build and apply

After reviewing the plan and creating the three secrets:

```bash
VIRGIL_DEPLOY=yes PROJECT_ID=your-project ./deploy/build.sh

VIRGIL_DEPLOY=yes \
PROJECT_ID=your-project \
FIREBASE_API_KEY=your-public-web-api-key \
GOOGLE_WEB_CLIENT_ID=your-web-client-id \
OWNER_EMAIL=owner@example.com \
./deploy/apply.sh
```

`build.sh` runs the test suite in the image builder runtime, enables the
required APIs, creates the Artifact Registry repository if needed, and pushes
Linux AMD64 Job and service images.

`apply.sh` ensures the dedicated runtime service account and default Firestore
database exist, grants the bounded runtime permissions, validates the service,
applies the Job, grants Job execution with per-learner overrides, and replaces
the service last.

## Apply deny-all Firestore client rules

Virgil's browser surfaces use the authenticated HTTP service; they do not talk
to Firestore directly. Publish the included deny-all rules before accepting
users:

```bash
gcloud services enable firebaserules.googleapis.com --project your-project
npx firebase deploy --only firestore:rules --project your-project
```

Run the command from the repository root so `firebase.json` resolves
`deploy/firestore.rules`.

## Optional Scheduler floor

Normal processing is dispatched by learner action and configured thresholds.
No cron is required. To add an hourly recovery sweep for the single configured
`BOARD_ID`:

```bash
VIRGIL_DEPLOY=yes \
VIRGIL_SCHEDULE=on \
PROJECT_ID=your-project \
./deploy/schedule.sh
```

The script creates or updates one Scheduler job. It is not a multi-user sweep.

## Acceptance checks

After deployment:

1. Add the exact Cloud Run origin to the Web OAuth client's Authorized
   JavaScript origins.
2. Open `https://YOUR-SERVICE/app/` and complete Firebase sign-in.
3. Confirm an unapproved account cannot read another learner's board.
4. Pin a passage, process it, complete one lesson action, and confirm the board
   survives a service restart.
5. Execute the Job directly and inspect its terminal outcome:

   ```bash
   gcloud run jobs execute virgil-nightly --region us-central1 --wait
   ```

6. Package the extension with the same service origin and complete the
   cross-surface path described in [`INSTALL.md`](../INSTALL.md).

Do not treat a healthy `/health` response as proof of identity, persistence, or
model routing. The first-user path is the deployment acceptance test.
