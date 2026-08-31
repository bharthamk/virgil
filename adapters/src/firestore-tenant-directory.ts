import {
  FirestoreStoreError, docId, openFirestoreClient,
  type FirestoreClientOptions, type FsDocumentReference, type FsFirestore,
} from './firestore-store.js';

export interface TenantDirectorySnapshot {
  readonly ownerEmail: string;
  readonly memberEmails: readonly string[];
}

export interface FirestoreTenantDirectoryOptions extends FirestoreClientOptions {
  readonly tenantId: string;
  readonly ownerEmail: string;
  readonly initialMembers?: readonly string[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_MEMBERS = 100;

const email = (value: string): string => {
  const normal = value.trim().toLowerCase();
  if (!EMAIL.test(normal) || normal.length > 320) {
    throw new FirestoreStoreError('invalid-value', 'tenant member email is invalid');
  }
  return normal;
};

const members = (values: readonly string[], owner: string): readonly string[] => {
  const unique = [...new Set([owner, ...values].map(email))].sort();
  if (unique.length > MAX_MEMBERS) {
    throw new FirestoreStoreError('resource-exhausted', `a Virgil installation supports at most ${MAX_MEMBERS} members`);
  }
  return unique;
};

const read = (value: Record<string, unknown> | undefined): TenantDirectorySnapshot => {
  const owner = typeof value?.['ownerEmail'] === 'string' ? email(value['ownerEmail']) : null;
  const rawMembers = value?.['memberEmails'];
  if (!owner || !Array.isArray(rawMembers) || rawMembers.some((entry) => typeof entry !== 'string')) {
    throw new FirestoreStoreError('invalid-value', 'tenant member directory is malformed');
  }
  const memberEmails = members(rawMembers as string[], owner);
  return { ownerEmail: owner, memberEmails };
};

const document = (snapshot: TenantDirectorySnapshot): Record<string, unknown> => ({
  schema: 'virgil-tenant-v1',
  ownerEmail: snapshot.ownerEmail,
  memberEmails: [...snapshot.memberEmails],
  updatedAt: new Date().toISOString(),
});

/** Deployment-owned membership, separate from every learner-owned board. */
export class FirestoreTenantDirectory {
  private connecting: Promise<FsFirestore> | null = null;

  constructor(private readonly opts: FirestoreTenantDirectoryOptions) {}

  private client(): Promise<FsFirestore> {
    return (this.connecting ??= openFirestoreClient(this.opts));
  }

  private async ref(): Promise<FsDocumentReference> {
    return (await this.client()).collection('virgilTenants').doc(docId(this.opts.tenantId));
  }

  async ensure(): Promise<TenantDirectorySnapshot> {
    const db = await this.client();
    const ref = await this.ref();
    const configuredOwner = email(this.opts.ownerEmail);
    const initial: TenantDirectorySnapshot = {
      ownerEmail: configuredOwner,
      memberEmails: members(this.opts.initialMembers ?? [], configuredOwner),
    };
    return db.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      if (!snap.exists) {
        transaction.set(ref, document(initial));
        return initial;
      }
      const stored = read(snap.data());
      if (stored.ownerEmail !== configuredOwner) {
        throw new FirestoreStoreError('permission-denied',
          'configured Virgil owner does not match the existing tenant directory');
      }
      return stored;
    });
  }

  async addMember(value: string): Promise<TenantDirectorySnapshot> {
    const candidate = email(value);
    return this.change((current) => ({
      ...current,
      memberEmails: members([...current.memberEmails, candidate], current.ownerEmail),
    }));
  }

  async removeMember(value: string): Promise<TenantDirectorySnapshot> {
    const candidate = email(value);
    return this.change((current) => {
      if (candidate === current.ownerEmail) {
        throw new FirestoreStoreError('permission-denied', 'the Virgil owner cannot be removed');
      }
      return {
        ...current,
        memberEmails: current.memberEmails.filter((member) => member !== candidate),
      };
    });
  }

  private async change(
    update: (current: TenantDirectorySnapshot) => TenantDirectorySnapshot,
  ): Promise<TenantDirectorySnapshot> {
    const db = await this.client();
    const ref = await this.ref();
    return db.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      if (!snap.exists) throw new FirestoreStoreError('not-found', 'tenant member directory is missing');
      const next = update(read(snap.data()));
      transaction.set(ref, document(next));
      return next;
    });
  }
}
