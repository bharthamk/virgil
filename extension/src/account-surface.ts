import { accountMarkup } from './demo-mode.js';

interface AccountSurfaceOptions {
  readonly content: HTMLElement;
  readonly label: string;
  readonly demo: boolean;
  readonly make: (markup: string) => HTMLElement;
  readonly onSwitch: () => void;
  readonly onSignOut: () => void;
  readonly onData: () => void;
}

/** Mount account identity and exits. Data operations remain in Settings. */
export function mountAccountSurface(options: AccountSurfaceOptions): void {
  const view = accountMarkup(options.demo);
  const hero = options.make(view.hero);
  (hero.querySelector('.account-email') as HTMLElement).textContent = options.label;
  options.content.append(hero);
  const access = options.make(view.access);
  access.querySelector('[data-switch]')!.addEventListener('click', options.onSwitch);
  access.querySelector('[data-signout]')!.addEventListener('click', options.onSignOut);
  options.content.append(access);
  const pointer = options.make(view.data);
  pointer.querySelector('[data-data-settings]')!.addEventListener('click', options.onData);
  options.content.append(pointer);
}
