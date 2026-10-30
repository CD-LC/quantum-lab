# Android app — architecture, build, and what is still yours to do

Written 2026-09-18, alongside the app itself (`apps/android/`). Read this
before touching the Android project; it explains why it is built the way it
is, not just how.

---

## 1. The architecture decision, and why it is not a native rewrite

**The app is a Trusted Web Activity (TWA), not a WebView wrapper and not a
native Kotlin rewrite.** `apps/android/app` is a thin, real Android Studio
project (Kotlin, Gradle Kotlin DSL, compileSdk 36) whose `LauncherActivity`
hands the whole screen to the device's verified Chrome/WebView-engine browser,
full-screen, no address bar, pointed at `https://qubit16.ai`. That is what
[`androidbrowserhelper`](https://github.com/GoogleChromeLabs/android-browser-helper)
— Chrome's own TWA library — does, and it is the same technology Bubblewrap
generates around.

This was a deliberate call, not the default because it was easiest:

* **This repo already decided not to chase re-implementation as a trophy.**
  `the internal product plan` says it about qubit count on the browser
  simulator; the same argument applies harder here. `lib/quantum.ts`, all 44+
  visualizations (several WebGL/Three.js), the AI tutor, hardware job
  submission, Stripe billing, the admin console, and the Learning Paths and
  Glossary added 2026-09-18 would all have to be rebuilt in Kotlin to get a
  native app with equal functionality — months of work, a second codebase
  that drifts from the first on day two, and a worse product than what
  already exists.
* **A TWA gets 100% feature parity by construction.** There is exactly one
  implementation of the product. Ship a change to the web app and the Android
  app has it too, with no app-store release required for anything except the
  wrapper itself.
* **It is genuinely the current recommended technology for this case**, not
  a compatibility shim — Google's own guidance for a feature-complete PWA.
  It launches faster than a WebView (shares the installed browser's engine
  and cache) and inherits the site's own excellent offline support (see
  `docs/PWA.md`) for free.

What makes this **not** "just a browser in a box" — the genuinely native,
Kotlin-implemented pieces:

| Feature | File(s) |
|---|---|
| Adaptive icon + Android 13+ themed (Material You) icon | `app/src/main/res/{drawable,mipmap-anydpi-v26}/ic_launcher*.xml` |
| Native splash screen (AndroidX SplashScreen API), same colours as the web manifest | `res/values/themes.xml`, `res/drawable/ic_splash_mark.xml` |
| Verified App Links — a shared `qubit16.ai` link opens the app directly | `AndroidManifest.xml` `autoVerify` intent-filter + `assetlinks.json` (§3) |
| Home-screen widget: "Quantum Tip", native Jetpack Glance, fully offline | `app/src/main/kotlin/ai/qubit16/app/widget/` |
| App shortcuts (long-press the icon): Simulator, Course, Paths, Visualize | `res/xml/shortcuts.xml` |
| Notification delegation scaffold (web push renders as a native notification) | `AndroidManifest.xml`'s `DelegationService` entry — inert until push is wired up server-side, see §6 |

---

## 2. Building it

Requirements confirmed present on this machine: JDK (via Gradle toolchain),
Android SDK with `platforms;android-36` and `build-tools;37.0.0`.

```sh
cd apps/android
./gradlew :app:assembleDebug     # -> app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:assembleRelease   # -> app/build/outputs/apk/release/app-release-unsigned.apk
```

Both were built and verified in this session: debug is 10.7 MB, release
(R8-minified, resources shrunk) is 1.6 MB. `local.properties` (gitignored)
points Gradle at the SDK — regenerate it on another machine with:

```sh
echo "sdk.dir=/path/to/Android/Sdk" > apps/android/local.properties
```

**Toolchain versions are pinned deliberately**, not to whatever was newest:
AGP 8.9.2 / Gradle 8.11.1 / Kotlin 2.1.0. `androidx.browser`, pulled in
transitively by `androidbrowserhelper`, resolved to `1.9.0-alpha04` and
required AGP ≥8.9.1 — that is the actual floor, found by building, not
guessed. Bump `build.gradle.kts`'s plugin versions and
`gradle/wrapper/gradle-wrapper.properties`'s `distributionUrl` together.

**`lintVitalAnalyzeRelease` can fail on a flaky network download** (it fetches
a ~30MB IntelliJ/Kotlin-compiler jar for Android Lint's own tooling,
unrelated to this app's code) — if it does, either retry or run
`./gradlew :app:assembleRelease -x lintVitalAnalyzeRelease -x lintVitalReportRelease -x lintVitalRelease`
to confirm the build itself is sound, the way this session did.

Opening `apps/android/` in Android Studio works as a normal Gradle project —
nothing here depends on a Gradle plugin or wizard, everything is committed,
readable source.

---

## 3. Digital Asset Links — makes shared links open the app, not the browser

Two files must agree, or App Links verification silently fails (the app still
works, it just falls back to opening in the browser instead of itself):

* `apps/web/public/.well-known/assetlinks.json` — served by the website; names
  the package and the SHA-256 fingerprints of the certificate Play signs the
  app with. With Play App Signing that is Google's key, not the upload key:
  Play Console → Protected with Play → Play Store protection → Play App
  Signing → **App signing key certificate**. The file lists that fingerprint
  plus Google's two hybrid signing certificates (download "certificates.zip"
  on the same page; `openssl x509 -inform DER -in <cert> -noout -fingerprint
  -sha256` prints each).
* `apps/android/app/src/main/res/values/strings.xml`'s `asset_statements` —
  the app's half, which only names the site (`namespace: web`, `site:
  https://qubit16.ai`); no fingerprint goes there.

The web file is live once the site deploys; verify with
`https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://qubit16.ai&relation=delegate_permission/common.handle_all_urls`.

Android re-verifies automatically; there is no manual "submit for review"
step. You can check verification status on an installed device with:

```sh
adb shell pm get-app-links ai.qubit16.app
```

---

## 4. Signing for release — deliberately not done here

**No production signing key exists anywhere in this repo, and none was
generated by this session.** `app/build.gradle.kts`'s `release` build type is
unsigned on purpose. This is the one piece of the app that is a genuine,
long-lived secret — anyone holding it can publish updates to your app on the
Play Store — so it is not something to generate unattended and leave sitting
in a repo, even a private one.

When you are ready:

```sh
keytool -genkeypair -v -keystore release.keystore -alias qubit16 \
  -keyalg RSA -keysize 2048 -validity 10000
```

Store `release.keystore` and its passwords somewhere durable and *not* in
this git repo (a password manager, or Play's own **Play App Signing**, which
lets Google hold the final signing key and you keep only an upload key — the
current recommended setup, and the default for new apps). Then build a signed
release without ever putting the password in a file. The simplest way (added
2026-10-04) is environment variables, which `app/build.gradle.kts` reads — with
none set the build stays unsigned, as before:

```sh
export QUBIT16_KEYSTORE=/path/to/release.keystore
export QUBIT16_KEYSTORE_PASSWORD=...   QUBIT16_KEY_ALIAS=qubit16   QUBIT16_KEY_PASSWORD=...
./gradlew :app:bundleRelease           # -> app/build/outputs/bundle/release/app-release.aab
```

The older injected-property form still works too:

```sh
./gradlew :app:assembleRelease \
  -Pandroid.injected.signing.store.file=/path/to/release.keystore \
  -Pandroid.injected.signing.store.password=$STORE_PASSWORD \
  -Pandroid.injected.signing.key.alias=qubit16 \
  -Pandroid.injected.signing.key.password=$KEY_PASSWORD
```

(This works today — `build.gradle.kts` has no `signingConfig` block for
`release`, so Gradle falls back to these injected properties. If you want a
committed `signingConfig` instead, wire one referencing environment variables
— never a literal password in the file.)

---

## 5. The Play Store — needs the company's own account

Publishing needs decisions and actions only you can make: a Google Play
Console developer account (one-time $25 fee, paid by the account holder), the store listing (screenshots, a feature graphic, short and
full descriptions), a content rating questionnaire, country availability and
pricing, and a privacy policy URL (the site already has one at
[`/privacy`](https://qubit16.ai/privacy) — reuse it).

Once you have an account, uploading `app-release.apk`/`.aab` and stepping
through the listing wizard is the whole remaining task — everything technical
this document covers is already done.

**A tip on the format:** Play now requires an Android App Bundle (`.aab`),
not an APK, for new apps. Build one with `./gradlew :app:bundleRelease`
(same signing flags as §4) — the debug/release **APK** builds in this doc are
for local testing.

---

## 6. What is deliberately not built yet, and why

* **Real push notifications.** The `DelegationService` entry in the manifest
  is ready to receive them, but nothing calls the
  [Notification Delegation API](https://developer.chrome.com/docs/capabilities/trusted-web-activity/notifications)
  from the web app yet, and there is no push subscription server. This needs
  a Firebase/FCM project — its own Google Cloud project decision, which
  should be yours, not mine to create unattended.
* **Play Feature Delivery, App Actions / Assistant integration, a config
  activity letting a user pick the widget's topic.** All reasonable next
  steps once the app has real users to justify them; listed here so they are
  not forgotten, not built speculatively.
* **A signed release build.** See §4 — needs a key only you should hold.
* **Filled-in Digital Asset Links fingerprint.** See §3 — needs the release
  key from §4 first.

## 7. Files added

```
apps/android/                              the whole Android Studio project
apps/web/public/.well-known/assetlinks.json Digital Asset Links (placeholder fingerprint, see §3)
docs/ANDROID.md                             this file
```

## 8. Changes of 2026-10-04

* **`DISPLAY_MODE` is now `default`, not `immersive`.** Immersive hid the system
  status and navigation bars, which collided with the site's new bottom tab bar
  (a swipe from the bottom edge to reveal the system bar lands on it) and removed
  the visible back affordance. Bar colours still match the site.
* **Env-var release signing** (§4).
* The `.aab` and debug APK rebuilt and verified (`BUILD SUCCESSFUL`); the web UI
  was exercised in real Android Chrome on a Pixel 10 Pro emulator. The TWA
  *wrapper itself* was not launched on the emulator — without a release
  fingerprint in `assetlinks.json` it falls back to a Custom Tab anyway (§3).
* Store screenshots at Play's phone size: `apps/android/store/`.
* iOS counterpart: [`IOS.md`](IOS.md).

## Play payments policy: no purchase entry points in the app

Play requires Google Play Billing for digital subscriptions sold inside an app,
and a TWA counts. The site therefore hides every purchase entry point when it is
running inside this app: `/pricing` links, upgrade buttons, the plan cards and
checkout (`docs/BILLING.md` § "Store apps").

The TWA is real Chrome, so the site cannot use a user-agent token as iOS does.
It recognises the app from Chrome's `android-app://ai.qubit16.app` referrer and
from the launch URL, which is `https://qubit16.ai/?app=android`
(`manifestPlaceholders["defaultUrl"]` in `app/build.gradle.kts`; `versionCode`
2). The referrer alone already works for the version-1 build on Play; the URL
marker needs version 2 uploaded. The URL marker is only honoured on an Android
user agent in `standalone`/`fullscreen` display mode (which a TWA is), so a
shared `https://qubit16.ai/pricing?app=android` link opened in an ordinary
browser tab does not hide anything.

## Building the bundle in CI

`.github/workflows/android.yml` builds `app-release.aab` on a GitHub runner
(JDK 17 + Android SDK, nothing needed locally) on every change under
`apps/android/` and on demand (Actions → Android → Run workflow). With the
four signing secrets set — `QUBIT16_KEYSTORE_B64` (the upload keystore,
base64), `QUBIT16_KEYSTORE_PASSWORD`, `QUBIT16_KEY_ALIAS`, `QUBIT16_KEY_PASSWORD`
— the bundle is signed with the upload key and ready for Play Console; without
them the job still compiles and uploads an UNSIGNED bundle, clearly labelled,
as a build check. Download the artifact from the run page and upload it in
Play Console → Testing → Internal testing → Create new release.
