# Install Virgil for your own users

Virgil is an AI learning manager: Capture, Learn, Grow, Manage and Customize
share one learner state, and the operator owns the infrastructure that holds it.

Virgil is self-hosted. Your service, Firebase project, Google OAuth clients,
model keys and learner boards belong to you. There is no central Virgil tenant
and no universal extension package that silently sends learners to somebody
else's project.

This is the supported source installation path. It deliberately separates the
Google client used by the hosted page from the client used by Chrome; Google
requires different application types for those two surfaces.

## What you need

- Node.js 22 or 24 LTS and npm
- Docker with `buildx`
- Google Cloud CLI and Firebase CLI, signed into the project you will own
- a Google Cloud project with billing or public release credits
- a Gemini API key stored under the two ladder secret names in Secret Manager,
  never in the repository (the same key may be used for both on a small install)
- Chrome for the extension

Start from a clean clone:

```bash
npm ci
npm test
```

The test command compiles the workspaces. Do not package an extension from a
tree that does not pass it.

## 1. Create the self-hosted identity boundary

In your Google Cloud project:

1. Register the project with Firebase, create a Firebase Web app, and record its
   public Web API key.
2. Configure the OAuth consent screen, enable Firebase Authentication and its
   Google provider, and—while the consent screen is in Testing—add every account
   used for installation acceptance as a test user.
3. Create an OAuth client of type **Web application** for the hosted `/app/`
   page. Record its client id. Once Cloud Run gives you the service URL, add the
   exact origin (scheme and hostname, no `/app/` path) to **Authorized
   JavaScript origins**.
4. Do not reuse that Web client in the extension manifest. The Chrome client is
   created in step 4 after Virgil has generated a stable extension id.

The Web API key and both OAuth client ids are public application identifiers,
not passwords. They are still deployment-specific. Model keys, Drive tokens
and refresh tokens remain in Secret Manager or Virgil's protected local files.

Google's own setup references:

- [Google Identity Services web client setup](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid)
- [Chrome extension OAuth manifest](https://developer.chrome.com/docs/extensions/reference/manifest/oauth2)

## 2. Review and deploy the service

First print the cloud actions without changing anything:

```bash
PROJECT_ID=your-project ./deploy/build.sh --plan
PROJECT_ID=your-project \
FIREBASE_API_KEY=your-public-web-api-key \
GOOGLE_WEB_CLIENT_ID=your-web-application-client-id \
OWNER_EMAIL=owner@example.com \
./deploy/apply.sh --plan
```

The plan writes `deploy/*.plan.yaml`. A real apply writes
`deploy/*.rendered.yaml`; the dry run never overwrites the last applied receipt.

Create the three secret names before applying. The first two are the free and
paid arms of the model ladder; one Gemini key may seed both. Managed Notebook
Drive export is optional, so a fresh installation can store the literal
`disabled` in the third secret instead of fabricating an OAuth grant:

```bash
gcloud secrets create virgil-gemini-api-key --data-file=- --project your-project
gcloud secrets create virgil-gemini-api-key-free --data-file=- --project your-project
printf %s disabled | gcloud secrets create virgil-notebook-drive-credential \
  --data-file=- --project your-project
```

Enter the Gemini key on standard input for each of the first two commands.
Replace `disabled` later with the managed-Drive JSON shape documented in the
README only if you want background Drive-source refresh.

When the plan is correct, run the same build and apply commands with
`VIRGIL_DEPLOY=yes`. `apply.sh` creates the dedicated `virgil-runtime` service
account when absent, creates the default Firestore Native database in `nam5`,
and grants only the Firestore, Vertex, Job-execution and named-secret access it
needs. The scripts refuse to create or bill resources without that exact
opt-in.

```bash
VIRGIL_DEPLOY=yes PROJECT_ID=your-project ./deploy/build.sh

VIRGIL_DEPLOY=yes \
PROJECT_ID=your-project \
FIREBASE_API_KEY=your-public-web-api-key \
GOOGLE_WEB_CLIENT_ID=your-web-application-client-id \
OWNER_EMAIL=owner@example.com \
./deploy/apply.sh
```

`OWNER_EMAIL` bootstraps this installation's owner. After the first successful
sign-in, the owner can add or remove people in **Settings → General**. Everyone
in that Virgil installation uses the same operator-managed model credentials
and billing boundary, while Firebase identity continues to route each account
to its own isolated learner board. `ALLOWED_EMAILS` remains an optional
comma-separated initial-member and upgrade-migration input; it is not needed
for ordinary membership changes after the directory exists.

Read the service origin from Cloud Run, then add that exact origin to the Web
client's Authorized JavaScript origins. The service owns the full product at:

```text
https://YOUR-SERVICE/app/
```

Do not continue until `/app/` loads and **Continue with Google** completes for
one test account. A page that merely returns 200 is not an identity proof.

The optional Scheduler sweep remains off by default. Pins and learner actions
already trigger useful background work; run `deploy/schedule.sh` only if you
deliberately want the additional idle-board floor described there.

## 3. Prepare a stable extension id

The Chrome OAuth client must be tied to an extension id, and an unpacked
extension without a manifest key can change id when its path changes. Virgil's
packager therefore runs in two stages.

First generate an allowlisted preparation package:

```bash
npm run package:extension -- \
  --service https://YOUR-SERVICE \
  --out ./release/virgil-extension
```

The command builds first, creates a stable manifest key, prints the extension
id and writes the same id to `virgil-package.json` and `NEXT_STEP.txt`. The
preparation package intentionally has no `oauth2` manifest entry and is not the
finished extension.

## 4. Create the Chrome client and finish the package

In the same Google Cloud project, create an OAuth client of type **Chrome
extension** for the exact extension id printed in step 3. Then rerun against the
same output directory:

```bash
npm run package:extension -- \
  --service https://YOUR-SERVICE \
  --out ./release/virgil-extension \
  --google-extension-client-id YOUR_CHROME_CLIENT.apps.googleusercontent.com
```

The existing manifest key is reused, so the extension id cannot drift between
the preparation and finished packages. The final directory contains only
browser runtime assets. It excludes source, tests, declarations, QA, the hosted
web entry and the retired extension-owned board page.

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked** and
select `release/virgil-extension/`.

## 5. Prove the first-user path

Use a browser profile that has never used this deployment:

1. Open the Virgil toolbar popup and choose **Open Virgil**.
2. Confirm it opens your service's `/app/`, never a `chrome-extension://` page.
3. Continue with Google and confirm the learner's email appears.
4. Open the side panel and confirm the current Learn page appears with **Visit
   full site** and **Pick what to pin**.
5. Pin a passage from an ordinary page, wait for the lesson, answer one section,
   and confirm the same evidence appears on the hosted board after reload.
6. Sign out, switch account, and confirm the previous learner's board is not
   visible.

That is the installation acceptance. A green build alone does not replace it.

## Updating an installation

Rebuild and rerun the final package command against the same `--out` directory.
The packager reads and preserves the existing manifest key before replacing the
runtime files, so the Google-registered extension id stays stable. Keep a copy
of that finished directory or its public manifest key with your deployment
configuration. Losing it means creating a new Chrome OAuth client for a new
extension id.

Learner data backup and restore lives under **Your account → Your data**. Model
keys, Firebase configuration, OAuth clients, Drive credentials and Secret
Manager state are operator configuration and must be backed up separately.
