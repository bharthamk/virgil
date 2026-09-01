/**
 * Routes shared by Virgil's two browser surfaces.
 *
 * The panel is momentary and shows the thing the learner just pressed. The
 * full page lives at the configured service's `/app/`, so a cloud deployment
 * opens its cloud origin and a local deployment opens loopback. Both reuse the
 * same renderer and route fragments; no product door opens an extension URL.
 */

/** Destinations inside the full-page surface. Unknown fragments fail home. */
export type MainPageRoute =
  | 'home' | 'plan' | 'courses' | 'check' | 'insights'
  | 'add-source'
  | 'account' | 'switch-user' | 'sign-out'
  | 'settings' | 'models' | 'privacy' | 'connections' | 'data';

export function mainPageRoute(hash: string): MainPageRoute {
  const route = hash.trim().replace(/^#/, '');
  const known: Readonly<Record<string, MainPageRoute>> = {
    learn: 'home', plan: 'plan', studies: 'courses', 'add-source': 'add-source', check: 'check', insights: 'insights',
    account: 'account', 'switch-user': 'switch-user', 'sign-out': 'sign-out',
    settings: 'settings', models: 'models', privacy: 'privacy', connections: 'connections',
    // Backup, restore and deletion. A settings section since 2026-08-29, and
    // addressable like every other one; `#account` still lands here on a
    // one-board install, which is where that door always went.
    data: 'data',
  };
  return known[route] ?? 'home';
}

/** The address a room owns once it is on screen. Kept beside the parser so an
 * address written by one build is guaranteed to be readable by the next. */
export function mainPageHash(route: MainPageRoute): string {
  const hashes: Readonly<Record<MainPageRoute, string>> = {
    home: '#learn', plan: '#plan', courses: '#studies', 'add-source': '#add-source', check: '#check', insights: '#insights',
    account: '#account', 'switch-user': '#switch-user', 'sign-out': '#sign-out',
    settings: '#settings', models: '#models', privacy: '#privacy', connections: '#connections',
    data: '#data',
  };
  return hashes[route];
}
