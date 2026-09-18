/**
 * The compiled identity of this exact frontend bundle. The value comes from the
 * build (`__SPELLTYPE_RELEASE_ID__`, injected by the Vite config), and this file
 * is the only place the build constant may appear: every module that needs to
 * know "which build am I" imports RELEASE_ID from here.
 */
declare const __SPELLTYPE_RELEASE_ID__: string;

export const RELEASE_ID: string = __SPELLTYPE_RELEASE_ID__;
