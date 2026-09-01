import type { DriveClientCredential } from './drive-credentials.js';

/**
 * Optional shipped OAuth identity for the desktop installed-app flow.
 *
 * PKCE and the loopback redirect protect authorization; a desktop client cannot
 * keep its client values confidential. User-supplied `SB_DRIVE_CLIENT_ID` and
 * `SB_DRIVE_CLIENT_SECRET` take precedence. An empty pair means the build has no
 * bundled Google sign-in identity. See `NOTEBOOK_SEAM_V2.md` §4.3.
 */
export const SHIPPED_DRIVE_CLIENT: DriveClientCredential = {
  clientId: '',
  clientSecret: '',
};
