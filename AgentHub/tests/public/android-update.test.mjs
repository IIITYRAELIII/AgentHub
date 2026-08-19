import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

test("Android build supports a checkout path with non-ASCII characters", async () => {
  const properties = await readFile(path.join(ROOT, "AndroidApp", "gradle.properties"), "utf8");
  assert.match(properties, /^android\.overridePathCheck=true$/mu);
});

test("Android updater accepts only a newer same-origin APK with the published SHA-256", async () => {
  const [activity, receiver, manifest] = await Promise.all([
    readFile(path.join(
      ROOT,
      "AndroidApp", "app", "src", "main", "java", "app", "agenthub", "mobile", "MainActivity.java",
    ), "utf8"),
    readFile(path.join(
      ROOT,
      "AndroidApp", "app", "src", "main", "java", "app", "agenthub", "mobile", "UpdateInstallReceiver.java",
    ), "utf8"),
    readFile(path.join(ROOT, "AndroidApp", "app", "src", "main", "AndroidManifest.xml"), "utf8"),
  ]);
  assert.match(activity, /versionCode <= BuildConfig\.VERSION_CODE/u);
  assert.match(activity, /"\/api\/mobile\/update\.apk"\.equals\(downloadPath\)/u);
  assert.match(activity, /sameOrigin\(hub, download\)/u);
  assert.match(activity, /MessageDigest\.getInstance\("SHA-256"\)/u);
  assert.match(activity, /total != expectedBytes \|\| !expectedHash\.equals\(hex\(digest\.digest\(\)\)\)/u);
  assert.match(activity, /connection\.setInstanceFollowRedirects\(false\)/u);
  assert.match(activity, /VerifiedUpdateFileProvider\.uriFor/u);
  assert.match(activity, /Settings\.ACTION_MANAGE_UNKNOWN_APP_SOURCES/u);
  assert.match(activity, /new Intent\(Intent\.ACTION_VIEW\)/u);
  assert.match(activity, /onHubRestarted\(String releaseId\)[\s\S]*checkForUpdate\(activeServerUrl, true\)/u);
  assert.match(activity, /UPDATE_CHECK_INTERVAL_MS = 5L \* 60L \* 1000L/u);
  assert.match(activity, /PackageInstaller\.SessionParams\.USER_ACTION_NOT_REQUIRED/u);
  assert.match(activity, /session\.commit\(pending\.getIntentSender\(\)\)/u);
  assert.match(receiver, /PackageInstaller\.STATUS_PENDING_USER_ACTION/u);
  assert.match(receiver, /context\.startActivity\(confirmation\)/u);
  assert.match(manifest, /android\.permission\.UPDATE_PACKAGES_WITHOUT_USER_ACTION/u);
  assert.match(manifest, /android:name="\.UpdateInstallReceiver"[\s\S]*android:exported="false"/u);
});

test("Android update provider exposes only verified cache files and is not exported", async () => {
  const [manifest, provider, build, gradle] = await Promise.all([
    readFile(path.join(ROOT, "AndroidApp", "app", "src", "main", "AndroidManifest.xml"), "utf8"),
    readFile(path.join(
      ROOT,
      "AndroidApp", "app", "src", "main", "java", "app", "agenthub", "mobile",
      "VerifiedUpdateFileProvider.java",
    ), "utf8"),
    readFile(path.join(ROOT, "AndroidApp", "build.ps1"), "utf8"),
    readFile(path.join(ROOT, "AndroidApp", "app", "build.gradle"), "utf8"),
  ]);
  assert.match(manifest, /android:name="\.VerifiedUpdateFileProvider"/u);
  assert.match(manifest, /android:exported="false"/u);
  assert.match(manifest, /android:name="android\.permission\.REQUEST_INSTALL_PACKAGES"/u);
  assert.match(provider, /new File\(context\.getCacheDir\(\), "updates"\)/u);
  assert.match(provider, /AgentHub-Mobile-/u);
  assert.match(provider, /ParcelFileDescriptor\.MODE_READ_ONLY/u);
  assert.match(build, /assets\\mobile/u);
  assert.match(build, /Security\.Cryptography\.SHA256/u);
  assert.match(build, /AgentHub-Mobile\.apk/u);
  assert.match(build, /update\.json/u);
  assert.match(build, /ToUnixTimeSeconds\(\) \/ 60/u);
  assert.match(build, /previousVersionCode \+ 1/u);
  assert.match(build, /-PagentHubVersionCode=\$VersionCode/u);
  assert.match(build, /-PagentHubVersionName=\$VersionName/u);
  assert.match(gradle, /gradleProperty\("agentHubVersionCode"\)/u);
  assert.match(gradle, /gradleProperty\("agentHubVersionName"\)/u);
});

test("Android system Back stays inside Agent Hub while the WebView has an in-app destination", async () => {
  const [activity, manifest] = await Promise.all([
    readFile(path.join(
      ROOT,
      "AndroidApp", "app", "src", "main", "java", "app", "agenthub", "mobile", "MainActivity.java",
    ), "utf8"),
    readFile(path.join(ROOT, "AndroidApp", "app", "src", "main", "AndroidManifest.xml"), "utf8"),
  ]);
  assert.match(manifest, /android:enableOnBackInvokedCallback="true"/u);
  assert.match(activity, /import android\.window\.OnBackInvokedCallback;/u);
  assert.match(activity, /registerOnBackInvokedCallback\([\s\S]*OnBackInvokedDispatcher\.PRIORITY_DEFAULT/u);
  assert.match(activity, /unregisterOnBackInvokedCallback\(backCallback\)/u);
  assert.match(activity, /public void onBackPressed\(\) \{\s*handleBackNavigation\(\);/u);
  assert.match(activity, /window\.AgentHub\.navigateBack/u);
  assert.match(activity, /if \("true"\.equalsIgnoreCase\(String\.valueOf\(handled\)\)\) return;/u);
  assert.match(activity, /private void finishBackNavigation\(\)[\s\S]*if \(webView != null\) return;[\s\S]*finish\(\);/u);
  assert.doesNotMatch(activity, /webView\.goBack\(\)/u);
});
