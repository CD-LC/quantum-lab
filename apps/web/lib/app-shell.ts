/**
 * Is this page running inside an installed app shell, rather than a browser tab?
 *
 * Three shells exist and each announces itself differently:
 *
 *  - Android TWA / installed PWA: `display-mode: standalone` matches.
 *  - iOS home-screen PWA: `navigator.standalone === true`.
 *  - The iOS App Store app (apps/ios): a WKWebView, which matches neither of the
 *    above, so the native side appends `Qubit16App/ios` to the user agent
 *    (WebViewController.swift, `applicationNameForUserAgent`).
 *
 * Why it matters: a shell has no address bar and, on iOS, no back button. The
 * site has to supply its own way back, and must not show "install this app" to
 * someone who is already inside it.
 */
interface NavigatorWithStandalone extends Navigator {
  standalone?: boolean
}

export const NATIVE_SHELL_UA_TOKEN = 'Qubit16App'

/** True when the native iOS wrapper (or any future native shell) is hosting the page. */
export function isNativeShell(): boolean {
  if (typeof navigator === 'undefined') return false
  return navigator.userAgent.includes(NATIVE_SHELL_UA_TOKEN)
}

/** True in any of the three shells above. Client-only: returns false during SSR. */
export function isAppShell(): boolean {
  if (typeof window === 'undefined') return false
  if (isNativeShell()) return true
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) return true
  } catch {
    /* matchMedia can throw in exotic embedded webviews. */
  }
  return (navigator as NavigatorWithStandalone).standalone === true
}

/**
 * STORE APPS AND PURCHASES.
 *
 * Google Play and the App Store both refuse apps that sell digital
 * subscriptions through an outside checkout (Play's payments policy; App Store
 * guideline 3.1.1). The two store apps are shells around this site, so inside
 * them every purchase entry point — pricing links, "See plans", "Upgrade",
 * checkout — is hidden, and /pricing shows a neutral note instead. Buying stays
 * on the website.
 *
 * Detection runs as an inline script before first paint (no flash of an
 * Upgrade button) and marks <html data-store-app>. CSS in globals.css does the
 * hiding, so a /pricing link added anywhere later is covered automatically.
 *
 *  - iOS app: the user-agent token above.
 *  - Android app: a Trusted Web Activity, i.e. real Chrome with Chrome's user
 *    agent. Chrome reports `android-app://<package>` as the referrer of the
 *    page the app opens, and the launch URL carries `?app=android`. Either is
 *    remembered in sessionStorage — per tab, so it never leaks into ordinary
 *    Chrome browsing of qubit16.ai the way localStorage would.
 *
 *    The `?app=android` marker is only honoured on an Android user agent that is
 *    running in an installed-app display mode (a TWA matches `standalone`; a
 *    normal browser tab matches `browser`). Otherwise anyone could hide the
 *    purchase path for every visitor by sharing a `/pricing?app=android` link.
 *    `?app=ios` is not honoured at all: the iOS app is identified by its
 *    user-agent token.
 */
export const STORE_APP_ATTR = 'data-store-app'
export const ANDROID_PACKAGE = 'ai.qubit16.app'

export const STORE_APP_SCRIPT = `(function(){try{
var d=document.documentElement,k="qubit16.storeApp",s=false;
if(navigator.userAgent.indexOf("${NATIVE_SHELL_UA_TOKEN}")>-1)s=true;
if(document.referrer.indexOf("android-app://${ANDROID_PACKAGE}")===0)s=true;
if(/[?&]app=android(&|$)/.test(location.search)&&/Android/.test(navigator.userAgent)){try{if(matchMedia("(display-mode: standalone)").matches||matchMedia("(display-mode: fullscreen)").matches)s=true}catch(e){}}
try{if(s)sessionStorage.setItem(k,"1");else if(sessionStorage.getItem(k)==="1")s=true}catch(e){}
if(s)d.setAttribute("${STORE_APP_ATTR}","1");
}catch(e){}})()`

/** True inside the Play Store or App Store app (after STORE_APP_SCRIPT has run). */
export function isStoreApp(): boolean {
  if (typeof document === 'undefined') return false
  return document.documentElement.hasAttribute(STORE_APP_ATTR)
}
