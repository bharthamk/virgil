import type { DriveFileIds } from '@sb/adapters';
import { mutateLearnerPrefs, type Store } from '@sb/core';

import type { DriveClientCredential } from './drive-credentials.js';

/** A server-held Google grant. The whole value arrives from Secret Manager. */
export interface ManagedDriveGrant {
  readonly account: string;
  readonly client: DriveClientCredential;
  readonly refreshToken: string;
}

const clean = (value: unknown, label: string): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 2_048 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`SB_NOTEBOOK_DRIVE_CREDENTIAL has no usable ${label}`);
  }
  return text;
};

/**
 * Accepts both Virgil's camel-case shape and gcloud's ADC snake-case shape.
 * Nothing from the parsed object is ever logged or returned by an endpoint.
 */
export function managedDriveGrant(raw: string | undefined): ManagedDriveGrant | null {
  const configured = raw?.trim();
  if (!configured || configured === 'disabled') return null;
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(configured);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    parsed = value as Record<string, unknown>;
  } catch {
    throw new Error('SB_NOTEBOOK_DRIVE_CREDENTIAL is not a JSON object');
  }
  return {
    account: clean(parsed.account, 'account'),
    client: {
      clientId: clean(parsed.clientId ?? parsed.client_id, 'client id'),
      clientSecret: clean(parsed.clientSecret ?? parsed.client_secret, 'client secret'),
    },
    refreshToken: clean(parsed.refreshToken ?? parsed.refresh_token, 'refresh token'),
  };
}

/**
 * The file ids are learner state, not credentials. Keeping them on the board
 * makes a replacement Doc survive Cloud Run's disposable filesystem and lets a
 * later foreground press hand the worker the same identities immediately.
 */
export function managedDriveIds(
  store: Pick<Store, 'getPrefs' | 'putPrefs' | 'mutatePrefs'>, expectedAccount: string,
  now: () => Date = () => new Date(),
): { read(): Promise<DriveFileIds>; write(ids: DriveFileIds): Promise<void> } {
  const current = async () => {
    const state = (await store.getPrefs()).notebookDrive;
    if (!state?.enabled) {
      throw new Error('Automatic Google Notebook refresh is not connected for this learner.');
    }
    if (state.account.toLowerCase() !== expectedAccount.toLowerCase()) {
      throw new Error('The Google Notebook background account does not match the learner setup.');
    }
    return state;
  };
  return {
    async read() {
      const state = await current();
      return { folderId: state.folderId, files: { ...state.files } };
    },
    async write(ids) {
      const state = await current();
      await mutateLearnerPrefs(store, (prefs) => {
        const latest = prefs.notebookDrive;
        if (!latest?.enabled || latest.account.toLowerCase() !== expectedAccount.toLowerCase()) {
          throw new Error('Automatic Google Notebook refresh changed while this write was running.');
        }
        return {
          ...prefs,
          notebookDrive: {
            ...latest,
            folderId: ids.folderId ?? state.folderId,
            files: { ...ids.files },
            lastWriteAt: now().toISOString(),
          },
        };
      });
    },
  };
}
