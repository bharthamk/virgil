import { localHost } from '../host.js';
import { runHostContract } from './host-contract.js';

/**
 * The reference host, bound to the contract.
 *
 * This is the control, and it is the reason the contract is a specification of
 * Virgil's sequencing rather than a transcription of ADK's. Every assertion here
 * passes with no framework installed, which means each one is a rule this
 * project chose — not a behaviour inherited from a dependency and then written
 * down as if it had been a decision.
 *
 * It is also the fallback that makes the ADK dependency a choice rather than a
 * commitment: if the package is declined, or a version of it breaks, the nightly
 * still has a host that satisfies every requirement below.
 */
runHostContract('local', localHost, 'local');
